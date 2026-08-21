import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CancelTaskRequest,
  CreateTaskRequest,
  StartTaskRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskView,
} from '../shared/runtime/runtime-interface';

const EVENT_FILE = 'events.log';
const PROJECTION_FILE = 'projection.json';
const EVENT_HEADER_BYTES = 36;
const MAX_EVENT_BYTES = 16 * 1024;

type TaskFailureCode =
  | 'idempotency-conflict'
  | 'not-found'
  | 'task-not-ready'
  | 'internal';

export class TaskStorageError extends Error {
  constructor(readonly code: TaskFailureCode) {
    super(`Task storage failed: ${code}`);
    this.name = 'TaskStorageError';
  }
}

interface TaskCreatedEvent {
  readonly type: 'TaskCreated';
  readonly version: 1;
  readonly task: TaskView;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface RunCreatedEvent {
  readonly type: 'RunCreated';
  readonly version: 1;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly run: StoredRun;
}

interface AttemptCreatedEvent {
  readonly type: 'AttemptCreated';
  readonly version: 1;
  readonly taskId: string;
  readonly attempt: StoredAttempt;
}

interface ContextAllocatedEvent {
  readonly type: 'ContextAllocated';
  readonly version: 1;
  readonly taskId: string;
  readonly context: StoredContext;
}

interface AttemptStartedEvent {
  readonly type: 'AttemptStarted';
  readonly version: 1;
  readonly taskId: string;
}

interface AttemptCompletedEvent {
  readonly type: 'AttemptCompleted';
  readonly version: 1;
  readonly taskId: string;
  readonly exitCode: number;
}

interface AttemptFailedEvent {
  readonly type: 'AttemptFailed';
  readonly version: 1;
  readonly taskId: string;
}

interface CancellationRequestedEvent {
  readonly type: 'CancellationRequested';
  readonly version: 1;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

interface AttemptCancelledEvent {
  readonly type: 'AttemptCancelled';
  readonly version: 1;
  readonly taskId: string;
}

type TaskEvent =
  | TaskCreatedEvent
  | RunCreatedEvent
  | AttemptCreatedEvent
  | ContextAllocatedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | AttemptFailedEvent
  | CancellationRequestedEvent
  | AttemptCancelledEvent;

interface StoredRun {
  readonly id: string;
  readonly number: number;
}

interface StoredAttempt {
  readonly id: string;
  readonly number: number;
  readonly state: TaskExecutionState;
  readonly exitCode?: number;
}

interface StoredContext {
  readonly id: string;
  readonly worktreeId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly processId: string;
  readonly ptyId: string;
}

interface StoredExecution {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  run: StoredRun;
  attempt: StoredAttempt | null;
  context: StoredContext | null;
  cancellation: { readonly idempotencyKey: string; readonly fingerprint: string } | null;
}

export interface ExecutionReservation {
  readonly execution: TaskExecutionView;
  readonly created: boolean;
}

/** The sole serialized writer for durable Task and execution lifecycle evidence. */
export class TaskModule {
  private readonly directory: string;
  private readonly eventPath: string;
  private readonly projectionPath: string;
  private readonly tasks = new Map<string, TaskView>();
  private readonly taskIds = new Map<string, TaskView>();
  private readonly fingerprints = new Map<string, string>();
  private readonly executions = new Map<string, StoredExecution>();
  private readonly executionKeys = new Map<string, StoredExecution>();
  private mutation: Promise<void> = Promise.resolve();
  private poisoned = false;

  constructor(
    runtimeDirectory: string,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {
    this.directory = path.join(runtimeDirectory, 'tasks');
    this.eventPath = path.join(this.directory, EVENT_FILE);
    this.projectionPath = path.join(this.directory, PROJECTION_FILE);
  }

  async start(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.directory);
      await verifyProtectedFile(this.eventPath);
      await verifyProtectedFile(this.projectionPath);
      await this.replay();
      await this.writeProjection();
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError('internal');
    }
  }

  create(request: CreateTaskRequest): Promise<TaskView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const fingerprint = canonicalTaskFingerprint(request);
      const existing = this.tasks.get(request.idempotencyKey);
      if (existing) {
        if (this.fingerprints.get(request.idempotencyKey) === fingerprint) return existing;
        throw new TaskStorageError('idempotency-conflict');
      }
      const task: TaskView = {
        id: this.randomId(),
        objective: request.objective,
        project: request.project,
        repository: request.repository,
        baseRef: request.baseRef,
        provider: request.provider,
        createdAt: new Date(this.now()).toISOString(),
      };
      await this.appendVisible({
        type: 'TaskCreated',
        version: 1,
        task,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
      });
      return task;
    });
  }

  list(): readonly TaskView[] {
    return [...this.tasks.values()];
  }

  reserveExecution(request: StartTaskRequest): Promise<ExecutionReservation> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      const keyed = this.executionKeys.get(request.idempotencyKey);
      if (keyed) {
        if (keyed.fingerprint !== fingerprint) throw new TaskStorageError('idempotency-conflict');
        if (!keyed.attempt) {
          await this.appendVisible({
            type: 'AttemptCreated',
            version: 1,
            taskId: task.id,
            attempt: { id: this.randomId(), number: 1, state: 'starting' },
          });
          return { execution: this.viewFor(task, this.executionFor(task.id)), created: true };
        }
        if (keyed.attempt.state === 'starting' && !keyed.context) {
          return { execution: this.viewFor(task, keyed), created: true };
        }
        return { execution: this.viewFor(task, keyed), created: false };
      }
      if (this.executions.has(task.id)) throw new TaskStorageError('task-not-ready');
      const run: StoredRun = { id: this.randomId(), number: 1 };
      await this.appendVisible({
        type: 'RunCreated',
        version: 1,
        taskId: task.id,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
        run,
      });
      const attempt: StoredAttempt = { id: this.randomId(), number: 1, state: 'starting' };
      await this.appendVisible({ type: 'AttemptCreated', version: 1, taskId: task.id, attempt });
      return { execution: this.viewFor(task, this.executionFor(task.id)), created: true };
    });
  }

  allocateContext(taskId: string, context: StoredContext): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'ContextAllocated', version: 1, taskId, context });
  }

  markStarted(taskId: string): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'AttemptStarted', version: 1, taskId });
  }

  complete(taskId: string, exitCode: number): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'AttemptCompleted', version: 1, taskId, exitCode });
  }

  fail(taskId: string): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'AttemptFailed', version: 1, taskId });
  }

  requestCancellation(request: CancelTaskRequest): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const execution = this.executionFor(task.id);
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      if (execution.cancellation) {
        if (execution.cancellation.idempotencyKey !== request.idempotencyKey) {
          throw new TaskStorageError('task-not-ready');
        }
        if (execution.cancellation.fingerprint !== fingerprint) {
          throw new TaskStorageError('idempotency-conflict');
        }
        return this.viewFor(task, execution);
      }
      if (isTerminal(execution.attempt?.state)) return this.viewFor(task, execution);
      await this.appendVisible({
        type: 'CancellationRequested',
        version: 1,
        taskId: task.id,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
      });
      return this.viewFor(task, this.executionFor(task.id));
    });
  }

  cancel(taskId: string): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'AttemptCancelled', version: 1, taskId });
  }

  execution(taskId: string): TaskExecutionView {
    const task = this.taskById(taskId);
    return this.viewFor(task, this.executions.get(task.id) ?? null);
  }

  private transition(
    taskId: string,
    event: Exclude<
      TaskEvent,
      TaskCreatedEvent | RunCreatedEvent | AttemptCreatedEvent | CancellationRequestedEvent
    >,
  ): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      await this.appendVisible(event);
      return this.viewFor(task, this.executionFor(task.id));
    });
  }

  private async appendVisible(event: TaskEvent): Promise<void> {
    await this.append(event);
    this.apply(event);
    await this.writeProjection();
  }

  private async replay(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(this.eventPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }
    let offset = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < EVENT_HEADER_BYTES) {
        await fs.promises.truncate(this.eventPath, offset);
        break;
      }
      const length = bytes.readUInt32BE(offset);
      if (length === 0 || length > MAX_EVENT_BYTES || offset + EVENT_HEADER_BYTES + length > bytes.length) {
        if (offset + EVENT_HEADER_BYTES + length > bytes.length) {
          await fs.promises.truncate(this.eventPath, offset);
          break;
        }
        throw new TaskStorageError('internal');
      }
      const checksum = bytes.subarray(offset + 4, offset + EVENT_HEADER_BYTES);
      const payload = bytes.subarray(offset + EVENT_HEADER_BYTES, offset + EVENT_HEADER_BYTES + length);
      if (!createHash('sha256').update(payload).digest().equals(checksum)) {
        throw new TaskStorageError('internal');
      }
      this.apply(parseEvent(payload));
      offset += EVENT_HEADER_BYTES + length;
    }
  }

  private apply(event: TaskEvent): void {
    switch (event.type) {
      case 'TaskCreated':
        this.applyTaskCreated(event);
        return;
      case 'RunCreated':
        this.applyRunCreated(event);
        return;
      case 'AttemptCreated':
        this.applyAttemptCreated(event);
        return;
      case 'ContextAllocated':
        this.applyContextAllocated(event);
        return;
      case 'AttemptStarted':
        this.applyAttemptStarted(event);
        return;
      case 'CancellationRequested':
        this.applyCancellationRequested(event);
        return;
      case 'AttemptCompleted':
        this.applyTerminal(event.taskId, 'completed', event.exitCode);
        return;
      case 'AttemptFailed':
        this.applyTerminal(event.taskId, 'failed');
        return;
      case 'AttemptCancelled':
        this.applyTerminal(event.taskId, 'cancelled');
    }
  }

  private applyTaskCreated(event: TaskCreatedEvent): void {
    const existing = this.tasks.get(event.idempotencyKey);
    if (
      existing &&
      (existing.id !== event.task.id || this.fingerprints.get(event.idempotencyKey) !== event.fingerprint)
    ) {
      throw new TaskStorageError('internal');
    }
    const matchingTask = this.taskIds.get(event.task.id);
    if (matchingTask && matchingTask.id !== event.task.id) throw new TaskStorageError('internal');
    this.tasks.set(event.idempotencyKey, event.task);
    this.taskIds.set(event.task.id, event.task);
    this.fingerprints.set(event.idempotencyKey, event.fingerprint);
  }

  private applyRunCreated(event: RunCreatedEvent): void {
    if (!this.taskIds.has(event.taskId) || this.executions.has(event.taskId)) {
      throw new TaskStorageError('internal');
    }
    const execution: StoredExecution = {
      taskId: event.taskId,
      idempotencyKey: event.idempotencyKey,
      fingerprint: event.fingerprint,
      run: event.run,
      attempt: null,
      context: null,
      cancellation: null,
    };
    this.executions.set(event.taskId, execution);
    this.executionKeys.set(event.idempotencyKey, execution);
  }

  private applyAttemptCreated(event: AttemptCreatedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (execution.attempt) throw new TaskStorageError('internal');
    execution.attempt = event.attempt;
  }

  private applyContextAllocated(event: ContextAllocatedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || execution.context || execution.attempt.state !== 'starting') {
      throw new TaskStorageError('internal');
    }
    execution.context = event.context;
  }

  private applyAttemptStarted(event: AttemptStartedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || !execution.context || execution.attempt.state !== 'starting') {
      throw new TaskStorageError('internal');
    }
    execution.attempt = { ...execution.attempt, state: 'running' };
  }

  private applyCancellationRequested(event: CancellationRequestedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || isTerminal(execution.attempt.state) || execution.cancellation) {
      throw new TaskStorageError('internal');
    }
    execution.cancellation = {
      idempotencyKey: event.idempotencyKey,
      fingerprint: event.fingerprint,
    };
    execution.attempt = { ...execution.attempt, state: 'cancelling' };
  }

  private applyTerminal(
    taskId: string,
    state: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled'>,
    exitCode?: number,
  ): void {
    const execution = this.executionFor(taskId);
    if (!execution.attempt || isTerminal(execution.attempt.state)) throw new TaskStorageError('internal');
    execution.attempt = {
      ...execution.attempt,
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  private taskById(taskId: string): TaskView {
    const task = this.taskIds.get(taskId);
    if (!task) throw new TaskStorageError('not-found');
    return task;
  }

  private executionFor(taskId: string): StoredExecution {
    const execution = this.executions.get(taskId);
    if (!execution) throw new TaskStorageError('internal');
    return execution;
  }

  private viewFor(task: TaskView, execution: StoredExecution | null): TaskExecutionView {
    const state = execution?.attempt?.state ?? (execution ? 'starting' : 'ready');
    return {
      task: { ...task, executionState: state },
      run: execution ? { ...execution.run } : null,
      attempt: execution?.attempt ? { ...execution.attempt } : null,
      context: execution?.context ? { ...execution.context } : null,
    };
  }

  private async append(event: TaskEvent): Promise<void> {
    await verifyProtectedFile(this.eventPath);
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    if (payload.length > MAX_EVENT_BYTES) throw new TaskStorageError('internal');
    const header = Buffer.alloc(EVENT_HEADER_BYTES);
    header.writeUInt32BE(payload.length, 0);
    createHash('sha256').update(payload).digest().copy(header, 4);
    const frame = Buffer.concat([header, payload]);
    const handle = await fs.promises.open(this.eventPath, 'a', 0o600);
    try {
      const startOffset = (await handle.stat()).size;
      let offset = 0;
      try {
        while (offset < frame.length) {
          const { bytesWritten } = await handle.write(frame.subarray(offset));
          if (bytesWritten === 0) throw new TaskStorageError('internal');
          offset += bytesWritten;
        }
        await handle.sync();
      } catch (error) {
        if (offset < frame.length) await this.repairIncompleteAppend(handle, startOffset);
        else this.poisoned = true;
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  private async repairIncompleteAppend(handle: fs.promises.FileHandle, offset: number): Promise<void> {
    try {
      await handle.truncate(offset);
      await handle.sync();
    } catch {
      this.poisoned = true;
      throw new TaskStorageError('internal');
    }
  }

  private async writeProjection(): Promise<void> {
    const temporaryPath = `${this.projectionPath}.${this.randomId()}.tmp`;
    const contents = JSON.stringify({ version: 2, tasks: this.list() });
    const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporaryPath, this.projectionPath);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private throwIfPoisoned(): void {
    if (this.poisoned) throw new TaskStorageError('internal');
  }
}

function canonicalTaskFingerprint(request: CreateTaskRequest): string {
  return JSON.stringify([
    request.objective,
    request.project,
    request.repository,
    request.baseRef,
    request.provider,
  ]);
}

function canonicalExecutionFingerprint(taskId: string): string {
  return JSON.stringify([taskId]);
}

function isTerminal(state: TaskExecutionState | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function parseEvent(payload: Buffer): TaskEvent {
  try {
    const value = object(JSON.parse(payload.toString('utf8')));
    const type = string(value.type);
    if (value.version !== 1) throw new Error('invalid event');
    return type === 'TaskCreated' ? parseTaskCreatedEvent(value) : parseExecutionEvent(value, type);
  } catch {
    throw new TaskStorageError('internal');
  }
}

function parseTaskCreatedEvent(value: Record<string, unknown>): TaskCreatedEvent {
  return {
    type: 'TaskCreated',
    version: 1,
    task: parseTask(object(value.task)),
    idempotencyKey: string(value.idempotencyKey),
    fingerprint: string(value.fingerprint),
  };
}

function parseExecutionEvent(value: Record<string, unknown>, type: string): TaskEvent {
  const taskId = string(value.taskId);
  if (type === 'RunCreated') {
    return {
      type,
      version: 1,
      taskId,
      idempotencyKey: string(value.idempotencyKey),
      fingerprint: string(value.fingerprint),
      run: parseRun(object(value.run)),
    };
  }
  if (type === 'AttemptCreated') return { type, version: 1, taskId, attempt: parseAttempt(object(value.attempt)) };
  if (type === 'ContextAllocated') return { type, version: 1, taskId, context: parseContext(object(value.context)) };
  if (type === 'AttemptStarted' || type === 'AttemptFailed' || type === 'AttemptCancelled') {
    return { type, version: 1, taskId };
  }
  if (type === 'AttemptCompleted') return { type, version: 1, taskId, exitCode: integer(value.exitCode) };
  if (type === 'CancellationRequested') {
    return {
      type,
      version: 1,
      taskId,
      idempotencyKey: string(value.idempotencyKey),
      fingerprint: string(value.fingerprint),
    };
  }
  throw new Error('invalid event');
}

function parseTask(value: Record<string, unknown>): TaskView {
  return {
    id: string(value.id),
    objective: string(value.objective),
    project: string(value.project),
    repository: string(value.repository),
    baseRef: string(value.baseRef),
    provider: string(value.provider) as TaskView['provider'],
    createdAt: string(value.createdAt),
  };
}

function parseRun(value: Record<string, unknown>): StoredRun {
  return { id: string(value.id), number: positiveInteger(value.number) };
}

function parseAttempt(value: Record<string, unknown>): StoredAttempt {
  const state = string(value.state) as TaskExecutionState;
  if (!['starting', 'running', 'completed', 'failed', 'cancelling', 'cancelled'].includes(state)) {
    throw new Error('invalid attempt');
  }
  const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode);
  return {
    id: string(value.id),
    number: positiveInteger(value.number),
    state,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function parseContext(value: Record<string, unknown>): StoredContext {
  return {
    id: string(value.id),
    worktreeId: string(value.worktreeId),
    branchName: string(value.branchName),
    baseCommit: string(value.baseCommit),
    processId: string(value.processId),
    ptyId: string(value.ptyId),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error('invalid string');
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid integer');
  return value as number;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('invalid integer');
  return value as number;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TaskStorageError('internal');
  if (
    process.platform !== 'win32' &&
    ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
  ) {
    throw new TaskStorageError('internal');
  }
}

async function verifyProtectedFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TaskStorageError('internal');
    if (
      process.platform !== 'win32' &&
      ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
    ) {
      throw new TaskStorageError('internal');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw error;
  }
}

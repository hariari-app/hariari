import type {
  CancelTaskRequest,
  StartTaskRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskOutputEvent,
} from '../shared/runtime/runtime-interface';
import {
  GenericCliExecutionError,
  type GenericCliExecution,
  type GenericCliExecutionAdapter,
} from './generic-cli-execution-adapter';
import { TaskModule, TaskStorageError } from './task-module';

const MAX_OUTPUT_CHARS = 4 * 1024;

interface InFlightStart {
  readonly idempotencyKey: string;
  readonly promise: Promise<TaskExecutionView>;
}

export class TaskExecutionError extends Error {
  constructor(readonly code: 'worktree-unavailable' | 'process-start-failed' | 'internal') {
    super(`Task execution failed: ${code}`);
    this.name = 'TaskExecutionError';
  }
}

/** Runtime-owned execution module: adapter lifecycle, transient output, and durable transitions. */
export class TaskExecutionModule {
  private readonly starts = new Map<string, InFlightStart>();
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly exitWaits = new Map<string, ExitWait>();
  private readonly active = new Map<string, GenericCliExecution>();
  private readonly subscribers = new Map<string, Set<(event: TaskOutputEvent) => void>>();
  private readonly outputSequences = new Map<string, number>();

  constructor(
    private readonly tasks: TaskModule,
    private readonly adapter: GenericCliExecutionAdapter,
    private readonly randomId: () => string,
  ) {}

  start(request: StartTaskRequest): Promise<TaskExecutionView> {
    const inFlight = this.starts.get(request.taskId);
    if (inFlight) return this.followInFlightStart(request, inFlight);
    const promise = this.startOwned(request);
    const owned = { idempotencyKey: request.idempotencyKey, promise };
    this.starts.set(request.taskId, owned);
    void promise.then(
      () => this.releaseStart(request.taskId, owned),
      () => this.releaseStart(request.taskId, owned),
    );
    return promise;
  }

  private async startOwned(request: StartTaskRequest): Promise<TaskExecutionView> {
    const reservation = await this.tasks.reserveExecution(request);
    return reservation.created
      ? this.startReserved(request, reservation.execution)
      : reservation.execution;
  }

  private followInFlightStart(
    request: StartTaskRequest,
    inFlight: InFlightStart,
  ): Promise<TaskExecutionView> {
    if (inFlight.idempotencyKey === request.idempotencyKey) return inFlight.promise;
    return inFlight.promise.then(
      () => this.start(request),
      () => this.start(request),
    );
  }

  private releaseStart(taskId: string, owned: InFlightStart): void {
    if (this.starts.get(taskId) === owned) this.starts.delete(taskId);
  }

  async cancel(request: CancelTaskRequest): Promise<TaskExecutionView> {
    const view = await this.tasks.requestCancellation(request);
    if (view.attempt?.state !== 'cancelling') return view;
    const active = this.active.get(request.taskId);
    if (!active) return view;
    return this.stopCancelled(request.taskId, active);
  }

  private async stopCancelled(
    taskId: string,
    active: GenericCliExecution,
  ): Promise<TaskExecutionView> {
    const exitWait = this.exitWaits.get(taskId);
    try {
      await active.stop();
      await exitWait?.promise;
      return this.tasks.execution(taskId);
    } catch {
      throw new TaskExecutionError('internal');
    }
  }

  get(taskId: string): TaskExecutionView {
    return this.tasks.execution(taskId);
  }

  subscribe(taskId: string, listener: (event: TaskOutputEvent) => void): () => void {
    this.tasks.execution(taskId);
    const listeners = this.subscribers.get(taskId) ?? new Set<(event: TaskOutputEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  private async startReserved(
    request: StartTaskRequest,
    execution: TaskExecutionView,
  ): Promise<TaskExecutionView> {
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    let active: GenericCliExecution | null = null;
    try {
      active = await this.adapter.start({
        task: execution.task,
        run: execution.run,
        attempt: execution.attempt,
        identities: {
          contextId: this.randomId(),
          worktreeId: this.randomId(),
          processId: this.randomId(),
          ptyId: this.randomId(),
        },
        onOutput: (data) => this.publishOutput(request.taskId, execution.attempt!.id, data),
        onExit: (exitCode) => void this.settle(request.taskId, exitCode),
      });
      this.active.set(request.taskId, active);
      this.exitWaits.set(request.taskId, new ExitWait());
      await this.tasks.allocateContext(request.taskId, active.context);
      const started = await this.tasks.markStarted(request.taskId);
      active.activateExit();
      if (started.attempt?.state === 'cancelling') {
        void this.stopCancelled(request.taskId, active).catch(() => undefined);
        return started;
      }
      active.activateOutput();
      return started;
    } catch (error) {
      return this.failStart(request.taskId, active, error);
    }
  }

  private async failStart(
    taskId: string,
    active: GenericCliExecution | null,
    error: unknown,
  ): Promise<never> {
    if (active) {
      await active.stop().catch(() => undefined);
      active.dispose();
      this.active.delete(taskId);
    }
    if (error instanceof GenericCliExecutionError && error.context) {
      await this.allocateFailedContext(taskId, error.context);
    }
    try {
      await this.persistStartFailure(taskId);
    } finally {
      this.resolveExitWait(taskId);
    }
    if (error instanceof GenericCliExecutionError) throw new TaskExecutionError(error.code);
    throw new TaskExecutionError('internal');
  }

  private async allocateFailedContext(
    taskId: string,
    context: GenericCliExecution['context'],
  ): Promise<void> {
    try {
      await this.tasks.allocateContext(taskId, context);
    } catch (error) {
      if (this.tasks.execution(taskId).context) return;
      if (!(error instanceof TaskStorageError)) throw error;
      await this.tasks.allocateContext(taskId, context);
    }
  }

  private async persistStartFailure(taskId: string): Promise<void> {
    try {
      await this.tasks.fail(taskId);
    } catch {
      await this.tasks.fail(taskId);
    }
  }

  private settle(taskId: string, exitCode: number): void {
    if (this.settlements.has(taskId)) return;
    const settlement = this.persistExitWithRetry(taskId, exitCode)
      .then(() => this.release(taskId))
      .catch((error: unknown) => {
        this.rejectExitWait(taskId, error);
        this.release(taskId);
        throw error;
      });
    this.settlements.set(taskId, settlement);
    void settlement.catch(() => undefined);
  }

  private async persistExitWithRetry(taskId: string, exitCode: number): Promise<void> {
    try {
      await this.persistExit(taskId, exitCode);
    } catch {
      await this.persistExit(taskId, exitCode);
    }
  }

  private release(taskId: string): void {
    this.active.get(taskId)?.dispose();
    this.active.delete(taskId);
    this.settlements.delete(taskId);
    this.resolveExitWait(taskId);
  }

  private resolveExitWait(taskId: string): void {
    const exitWait = this.exitWaits.get(taskId);
    this.exitWaits.delete(taskId);
    exitWait?.resolve();
  }

  private rejectExitWait(taskId: string, error: unknown): void {
    const exitWait = this.exitWaits.get(taskId);
    this.exitWaits.delete(taskId);
    exitWait?.reject(error);
  }

  private async persistExit(taskId: string, exitCode: number): Promise<void> {
    const view = this.tasks.execution(taskId);
    if (!view.attempt || isTerminal(view.attempt.state)) return;
    if (view.attempt.state === 'cancelling') await this.tasks.cancel(taskId);
    else if (exitCode === 0) await this.tasks.complete(taskId, exitCode);
    else await this.tasks.fail(taskId);
  }

  private publishOutput(taskId: string, attemptId: string, value: string): void {
    const data = sanitizeOutput(value);
    if (data.length === 0) return;
    const sequence = (this.outputSequences.get(taskId) ?? 0) + 1;
    this.outputSequences.set(taskId, sequence);
    this.publish({ kind: 'data', taskId, attemptId, sequence, data });
    if (data.length < value.length) {
      const droppedSequence = sequence + 1;
      this.outputSequences.set(taskId, droppedSequence);
      this.publish({ kind: 'dropped', taskId, attemptId, sequence: droppedSequence });
    }
  }

  private publish(event: TaskOutputEvent): void {
    for (const listener of this.subscribers.get(event.taskId) ?? []) {
      try {
        listener(event);
      } catch {
        // Output listeners are isolated from the PTY lifecycle.
      }
    }
  }
}

function sanitizeOutput(value: string): string {
  return [...value.slice(0, MAX_OUTPUT_CHARS * 2)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character === '\n' || character === '\r' || character === '\t' || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .slice(0, MAX_OUTPUT_CHARS);
}

function isTerminal(state: TaskExecutionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

class ExitWait {
  private resolvePromise: () => void = () => undefined;
  private rejectPromise: (error: unknown) => void = () => undefined;
  readonly promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    void this.promise.catch(() => undefined);
  }

  resolve(): void {
    this.resolvePromise();
  }

  reject(error: unknown): void {
    this.rejectPromise(error);
  }
}

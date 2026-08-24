import type {
  CancelTaskRequest,
  CreateTaskRequest,
  StartTaskRequest,
  ProviderSessionActionRequest,
  ReconcileTaskRequest,
  RecoverTaskRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskRecoveryView,
  TaskRecoveryDecisionView,
  TaskView,
} from '../shared/runtime/runtime-interface';
import {
  type AttemptCreatedEvent,
  type AttemptForkedEvent,
  type AttemptResumedEvent,
  type AttemptSupersededEvent,
  type AttemptSupersessionRequestedEvent,
  type AttemptStartedEvent,
  type CancellationRequestedEvent,
  type ContextAllocatedEvent,
  type RunCreatedEvent,
  type StoredAttempt,
  type StoredContext,
  type StoredProviderSession,
  type StoredRun,
  type TaskCreatedEvent,
  type TaskEvent,
  type TaskReconciledEvent,
  type TaskRecoveryDecidedEvent,
} from './task-events';
import {
  ProviderSessionLifecycle,
  ProviderSessionLifecycleError,
  type PreparedProviderAction,
  type ProviderActionDecision,
  type ProviderActionRejection,
  type ProviderSessionAction,
} from './provider-session-lifecycle';
import { TaskEventStore, TaskEventStoreError } from './task-event-store';
import {
  privateExecutionProjection,
  projectExecution,
  type PrivateTaskExecutionView,
} from './task-execution-projection';

type TaskFailureCode = 'idempotency-conflict' | 'not-found' | 'task-not-ready'
  | 'unsupported-operation' | 'internal';

export class TaskStorageError extends Error {
  constructor(readonly code: TaskFailureCode) {
    super(`Task storage failed: ${code}`);
    this.name = 'TaskStorageError';
  }
}

export interface StoredExecution {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly run: StoredRun;
  readonly attempt: StoredAttempt | null;
  readonly attempts: readonly StoredAttempt[];
  readonly context: StoredContext | null;
  readonly executionContexts: readonly StoredContext[];
  readonly providerSession: StoredProviderSession | null;
  readonly providerSessions: readonly StoredProviderSession[];
  readonly supersession: {
    readonly actionKey: string;
    readonly reason: 'native-resume' | 'fork';
    readonly parentAttemptId: string;
    readonly parentSessionId: string;
  } | null;
  readonly plannedAction: {
    readonly kind: 'native-resume' | 'fork';
    readonly actionKey: string;
    readonly sourceAttemptId: string;
    readonly sourceSessionId: string;
    readonly plannedContext: StoredContext;
  } | null;
  readonly cancellation: { readonly idempotencyKey: string; readonly fingerprint: string } | null;
}

export interface ExecutionReservation {
  readonly execution: TaskExecutionView; readonly created: boolean;
  readonly providerRepair?: PlannedProviderRepair;
}

export interface PlannedProviderRepair {
  readonly kind: 'native-resume' | 'fork'; readonly parentContext: StoredContext;
  readonly parentSession: StoredProviderSession; readonly plannedContext: StoredContext;
}

export type ProviderActionRepair = { readonly execution: TaskExecutionView; readonly repair: PlannedProviderRepair | null };

export interface NativeResumeReservation extends PlannedProviderRepair {
  readonly execution: TaskExecutionView;
}

export type ProviderForkReservation = NativeResumeReservation;
/** The sole serialized writer for durable Task and execution lifecycle evidence. */
export class TaskModule {
  readonly runtimeDirectory: string;
  private readonly store: TaskEventStore;
  private readonly tasks = new Map<string, TaskView>();
  private readonly taskIds = new Map<string, TaskView>();
  private readonly fingerprints = new Map<string, string>();
  private readonly executions = new Map<string, StoredExecution>();
  private readonly recoveries = new Map<string, TaskReconciledEvent>();
  private readonly recoveriesById = new Map<string, TaskReconciledEvent>();
  private readonly recoveryDecisions = new Map<string, TaskRecoveryDecidedEvent>();
  private readonly executionKeys = new Map<string, StoredExecution>();
  private readonly providerLifecycle: ProviderSessionLifecycle;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    runtimeDirectory: string,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {
    this.runtimeDirectory = runtimeDirectory;
    this.store = new TaskEventStore(runtimeDirectory, randomId);
    this.providerLifecycle = new ProviderSessionLifecycle({
      view: (taskId) => this.lifecycleView(taskId),
      append: (event) => this.appendVisible(event),
    });
  }

  async start(): Promise<void> {
    try {
      await this.store.start((event) => this.apply(event), () => this.list());
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
          const providerRepair = this.providerRepair(keyed);
          return {
            execution: this.viewFor(task, keyed), created: true,
            providerRepair,
          };
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

  allocateContext(taskId: string, context: StoredContext, providerSession: StoredProviderSession | null): Promise<TaskExecutionView> {
    return this.transition(taskId, { type: 'ContextAllocated', version: 1, taskId, context, providerSession });
  }

  reserveNativeResume(request: ProviderSessionActionRequest): Promise<NativeResumeReservation> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const execution = this.executionFor(task.id);
      const parent = requiredResumeParent(execution, request.providerSessionId);
      if (parent.attempt.state === 'running') await this.appendVisible({
          type: 'AttemptSupersessionRequested', version: 1, taskId: task.id,
          actionKey: request.idempotencyKey, parentAttemptId: parent.attempt.id,
          parentSessionId: parent.session.id, reason: 'native-resume',
        });
      if (this.executionFor(task.id).attempt?.state === 'superseding') {
        await this.appendVisible({
          type: 'AttemptSuperseded', version: 1, taskId: task.id,
          actionKey: request.idempotencyKey, attemptId: parent.attempt.id,
          reason: 'native-resume',
        });
      }
      if (this.executionFor(task.id).attempt?.state !== 'superseded') {
        throw new TaskStorageError('internal');
      }
      const plannedContext = this.resumedContext(parent.context);
      await this.appendVisible({
        type: 'AttemptResumed', version: 1, taskId: task.id,
        attempt: { id: this.randomId(), number: parent.attempt.number + 1, state: 'starting' },
        sourceAttemptId: parent.attempt.id, sourceSessionId: parent.session.id,
        actionKey: request.idempotencyKey, plannedContext,
      });
      return { kind: 'native-resume', execution: this.viewFor(task, this.executionFor(task.id)),
        parentContext: parent.context, parentSession: parent.session, plannedContext };
    });
  }

  prepareProviderAction(
    request: ProviderSessionActionRequest,
    action: ProviderSessionAction,
  ): Promise<PreparedProviderAction> {
    return this.enqueue(() => this.runProvider(() => this.providerLifecycle.prepare(request, action)));
  }

  acceptProviderAction(
    prepared: PreparedProviderAction,
    decision: ProviderActionDecision,
  ): Promise<void> {
    return this.enqueue(() => this.runProvider(() => this.providerLifecycle.accept(prepared, decision)));
  }

  rejectProviderAction(
    prepared: PreparedProviderAction,
    reason: ProviderActionRejection,
  ): Promise<never> {
    return this.enqueue(() => this.runProvider(() => this.providerLifecycle.reject(prepared, reason)));
  }

  abortProviderAction(prepared: PreparedProviderAction): Promise<void> {
    return this.enqueue(() => this.runProvider(() => this.providerLifecycle.abort(prepared)));
  }

  requestProviderSupersession(
    prepared: PreparedProviderAction,
    reason: 'native-resume' | 'fork',
  ): Promise<TaskExecutionView> {
    return this.transition(prepared.request.taskId, {
      type: 'AttemptSupersessionRequested', version: 1,
      taskId: prepared.request.taskId, actionKey: prepared.request.idempotencyKey,
      parentAttemptId: prepared.session.attemptId,
      parentSessionId: prepared.session.id, reason,
    });
  }

  completeProviderSupersession(taskId: string, attemptId: string): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      const task = this.taskById(taskId);
      const execution = this.executionFor(taskId);
      if (execution.attempt?.id === attemptId && execution.attempt.state === 'superseded') {
        return this.viewFor(task, execution);
      }
      if (!execution.supersession || execution.supersession.parentAttemptId !== attemptId) {
        throw new TaskStorageError('internal');
      }
      await this.appendVisible({
        type: 'AttemptSuperseded', version: 1, taskId,
        actionKey: execution.supersession.actionKey, attemptId,
        reason: execution.supersession.reason,
      });
      return this.viewFor(task, this.executionFor(taskId));
    });
  }

  reserveProviderFork(prepared: PreparedProviderAction): Promise<ProviderForkReservation> {
    return this.enqueue(async () => {
      const task = this.taskById(prepared.request.taskId);
      const execution = this.executionFor(task.id);
      if (!execution.attempt || execution.attempt.id !== prepared.session.attemptId ||
        execution.attempt.state !== 'superseded') throw new TaskStorageError('task-not-ready');
      const plannedContext = this.resumedContext(prepared.context);
      await this.appendVisible({
        type: 'AttemptForked', version: 1, taskId: task.id,
        attempt: { id: this.randomId(), number: execution.attempt.number + 1, state: 'starting' },
        parentAttemptId: execution.attempt.id, parentSessionId: prepared.session.id,
        forkKey: prepared.request.idempotencyKey, plannedContext,
      });
      return { kind: 'fork', execution: this.viewFor(task, this.executionFor(task.id)),
        parentContext: prepared.context, parentSession: prepared.session, plannedContext };
    });
  }

  recoverProviderAction(
    request: ProviderSessionActionRequest, kind: PlannedProviderRepair['kind'],
  ): Promise<ProviderActionRepair | null> {
    return this.enqueue(async () => {
      const task = this.taskById(request.taskId);
      const execution = this.executionFor(task.id);
      const planned = execution.plannedAction;
      if (!planned || planned.kind !== kind || planned.actionKey !== request.idempotencyKey ||
        planned.sourceSessionId !== request.providerSessionId) return null;
      if (isTerminal(execution.attempt?.state)) return { execution: this.viewFor(task, execution), repair: null };
      const repair = this.providerRepair(execution);
      if (!repair) throw new TaskStorageError('internal');
      return { execution: this.viewFor(task, execution), repair };
    });
  }

  private resumedContext(parent: StoredContext): StoredContext {
    return { ...parent, id: this.randomId(), processId: this.randomId(), ptyId: this.randomId() };
  }

  markStarted(taskId: string): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      const execution = this.executionFor(task.id);
      if (execution.attempt?.state === 'cancelling' || isTerminal(execution.attempt?.state)) {
        return this.viewFor(task, execution);
      }
      await this.appendVisible({ type: 'AttemptStarted', version: 1, taskId });
      return this.viewFor(task, this.executionFor(task.id));
    });
  }

  complete(taskId: string, exitCode: number): Promise<TaskExecutionView> {
    return this.finish(taskId, 'completed', exitCode);
  }

  fail(taskId: string): Promise<TaskExecutionView> {
    return this.finish(taskId, 'failed');
  }

  requestCancellation(request: CancelTaskRequest): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const execution = this.executions.get(task.id);
      if (!execution?.attempt) throw new TaskStorageError('task-not-ready');
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      if (isTerminal(execution.attempt.state)) return this.viewFor(task, execution);
      if (execution.cancellation) {
        if (execution.cancellation.idempotencyKey !== request.idempotencyKey) {
          throw new TaskStorageError('task-not-ready');
        }
        if (execution.cancellation.fingerprint !== fingerprint) {
          throw new TaskStorageError('idempotency-conflict');
        }
        return this.viewFor(task, execution);
      }
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
    return this.finish(taskId, 'cancelled');
  }

  execution(taskId: string): TaskExecutionView {
    const task = this.taskById(taskId);
    return this.viewFor(task, this.executions.get(task.id) ?? null);
  }

  privateExecution(taskId: string): PrivateTaskExecutionView {
    const task = this.taskById(taskId);
    return this.privateViewFor(task, this.executions.get(task.id) ?? null);
  }

  reconciliation(request: ReconcileTaskRequest): TaskRecoveryView | null {
    this.throwIfPoisoned();
    const existing = this.recoveries.get(request.idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== recoveryFingerprint(request.taskId)) {
      throw new TaskStorageError('idempotency-conflict');
    }
    return existing.recovery;
  }

  recordReconciliation(
    request: ReconcileTaskRequest,
    recovery: TaskRecoveryView,
  ): Promise<TaskRecoveryView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const existing = this.recoveries.get(request.idempotencyKey);
      const fingerprint = recoveryFingerprint(task.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new TaskStorageError('idempotency-conflict');
        }
        return existing.recovery;
      }
      if (recovery.taskId !== task.id) throw new TaskStorageError('internal');
      await this.appendVisible({
        type: 'TaskReconciled', version: 1, taskId: task.id,
        idempotencyKey: request.idempotencyKey, fingerprint, recovery,
      });
      return this.recoveries.get(request.idempotencyKey)!.recovery;
    });
  }

  recovery(request: RecoverTaskRequest): TaskRecoveryView {
    this.throwIfPoisoned();
    const recovery = this.recoveriesById.get(request.recoveryId);
    if (!recovery || recovery.taskId !== request.taskId) throw new TaskStorageError('not-found');
    return recovery.recovery;
  }

  recoveryDecision(request: RecoverTaskRequest): TaskRecoveryDecisionView | null {
    this.throwIfPoisoned();
    const existing = this.recoveryDecisions.get(request.idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== recoveryDecisionFingerprint(request)) {
      throw new TaskStorageError('idempotency-conflict');
    }
    return existing.result;
  }

  recordRecoveryDecision(
    request: RecoverTaskRequest,
    result: TaskRecoveryDecisionView,
  ): Promise<TaskRecoveryDecisionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const recovery = this.recovery(request);
      const existing = this.recoveryDecisions.get(request.idempotencyKey);
      const fingerprint = recoveryDecisionFingerprint(request);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new TaskStorageError('idempotency-conflict');
        }
        return existing.result;
      }
      if (result.taskId !== recovery.taskId || result.recoveryId !== recovery.id ||
        result.decision !== recovery.decision) throw new TaskStorageError('internal');
      await this.appendVisible({
        type: 'TaskRecoveryDecided', version: 1, taskId: recovery.taskId,
        idempotencyKey: request.idempotencyKey, fingerprint, result,
      });
      return this.recoveryDecisions.get(request.idempotencyKey)!.result;
    });
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

  private finish(
    taskId: string,
    requested: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled'>,
    exitCode?: number,
  ): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      const execution = this.executionFor(task.id);
      if (isTerminal(execution.attempt?.state)) return this.viewFor(task, execution);
      const cancelled = requested === 'cancelled' || execution.attempt?.state === 'cancelling';
      const event = cancelled
        ? { type: 'AttemptCancelled' as const, version: 1 as const, taskId }
        : requested === 'completed'
          ? { type: 'AttemptCompleted' as const, version: 1 as const, taskId, exitCode: exitCode ?? 0 }
          : { type: 'AttemptFailed' as const, version: 1 as const, taskId };
      await this.appendVisible(event);
      return this.viewFor(task, this.executionFor(task.id));
    });
  }

  private async appendVisible(event: TaskEvent): Promise<void> {
    try {
      await this.store.appendVisible(event, (applied) => this.apply(applied), () => this.list());
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError('internal');
    }
  }

  private apply(event: TaskEvent): void {
    switch (event.type) {
      case 'TaskCreated': return void this.applyTaskCreated(event);
      case 'RunCreated': return void this.applyRunCreated(event);
      case 'AttemptCreated': return void this.applyAttemptCreated(event);
      case 'ContextAllocated': return void this.applyContextAllocated(event);
      case 'AttemptStarted': return void this.applyAttemptStarted(event);
      case 'AttemptSupersessionRequested':
        this.applySupersessionRequested(event);
        return;
      case 'AttemptSuperseded':
        this.applyAttemptSuperseded(event);
        return;
      case 'AttemptResumed':
        this.applyAttemptResumed(event);
        return;
      case 'ProviderSessionActionDecided':
        this.providerLifecycle.replay(event);
        return;
      case 'ProviderSessionActionAborted':
        this.providerLifecycle.replayAbort(event);
        this.applyProviderActionAborted(event.taskId);
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
        return;
      case 'AttemptForked':
        this.applyAttemptForked(event);
        return;
      case 'TaskReconciled':
        this.applyTaskReconciled(event);
        return;
      case 'TaskRecoveryDecided':
        this.applyTaskRecoveryDecided(event);
        return;
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

  private applyTaskReconciled(event: TaskReconciledEvent): void {
    if (!this.taskIds.has(event.taskId) || event.recovery.taskId !== event.taskId) {
      throw new TaskStorageError('internal');
    }
    const existing = this.recoveries.get(event.idempotencyKey);
    if (existing && (existing.fingerprint !== event.fingerprint ||
      JSON.stringify(existing.recovery) !== JSON.stringify(event.recovery))) {
      throw new TaskStorageError('internal');
    }
    this.recoveries.set(event.idempotencyKey, event);
    const byId = this.recoveriesById.get(event.recovery.id);
    if (byId && byId.idempotencyKey !== event.idempotencyKey) {
      throw new TaskStorageError('internal');
    }
    this.recoveriesById.set(event.recovery.id, event);
  }

  private applyTaskRecoveryDecided(event: TaskRecoveryDecidedEvent): void {
    const recovery = this.recoveriesById.get(event.result.recoveryId);
    if (!recovery || recovery.taskId !== event.taskId ||
      recovery.recovery.decision !== event.result.decision) throw new TaskStorageError('internal');
    const existing = this.recoveryDecisions.get(event.idempotencyKey);
    if (existing && (existing.fingerprint !== event.fingerprint ||
      JSON.stringify(existing.result) !== JSON.stringify(event.result))) {
      throw new TaskStorageError('internal');
    }
    this.recoveryDecisions.set(event.idempotencyKey, event);
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
      attempts: [],
      context: null,
      executionContexts: [],
      providerSession: null,
      providerSessions: [],
      supersession: null,
      plannedAction: null,
      cancellation: null,
    };
    this.executions.set(event.taskId, execution);
    this.executionKeys.set(event.idempotencyKey, execution);
  }

  private applyAttemptCreated(event: AttemptCreatedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (execution.attempt) throw new TaskStorageError('internal');
    this.replaceExecution(execution, { ...execution, attempt: event.attempt, attempts: [...execution.attempts, event.attempt] });
  }

  private applyContextAllocated(event: ContextAllocatedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (
      !execution.attempt ||
      execution.context ||
      (execution.attempt.state !== 'starting' && execution.attempt.state !== 'cancelling')
    ) {
      throw new TaskStorageError('internal');
    }
    if (event.providerSession && (event.providerSession.taskId !== event.taskId || event.providerSession.executionContextId !== event.context.id || event.providerSession.attemptId !== execution.attempt.id)) throw new TaskStorageError('internal');
    this.replaceExecution(execution, {
      ...execution,
      context: event.context,
      executionContexts: [...execution.executionContexts, event.context],
      providerSession: event.providerSession,
      providerSessions: event.providerSession
        ? [...execution.providerSessions, event.providerSession]
        : execution.providerSessions,
      plannedAction: null,
    });
  }

  private applyAttemptStarted(event: AttemptStartedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || !execution.context || execution.attempt.state !== 'starting') {
      throw new TaskStorageError('internal');
    }
    this.replaceAttempt(execution, { ...execution.attempt, state: 'running' });
  }

  private applySupersessionRequested(event: AttemptSupersessionRequestedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || !execution.providerSession ||
      execution.attempt.id !== event.parentAttemptId ||
      execution.providerSession.id !== event.parentSessionId ||
      isTerminal(execution.attempt.state)) throw new TaskStorageError('internal');
    this.replaceAttempt(execution, { ...execution.attempt, state: 'superseding' });
    const updated = this.executionFor(event.taskId);
    this.replaceExecution(updated, { ...updated, supersession: {
      actionKey: event.actionKey, reason: event.reason,
      parentAttemptId: event.parentAttemptId, parentSessionId: event.parentSessionId,
    } });
  }

  private applyAttemptSuperseded(event: AttemptSupersededEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || execution.attempt.id !== event.attemptId ||
      execution.attempt.state !== 'superseding') throw new TaskStorageError('internal');
    this.replaceAttempt(execution, { ...execution.attempt, state: 'superseded' });
  }

  private applyAttemptResumed(event: AttemptResumedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || execution.attempt.id !== event.sourceAttemptId ||
      execution.attempt.state !== 'superseded' ||
      execution.providerSession?.id !== event.sourceSessionId) throw new TaskStorageError('internal');
    this.replaceExecution(execution, {
      ...execution, attempt: event.attempt, attempts: [...execution.attempts, event.attempt],
      context: null, providerSession: null, cancellation: null, supersession: null,
      plannedAction: {
        kind: 'native-resume', actionKey: event.actionKey,
        sourceAttemptId: event.sourceAttemptId,
        sourceSessionId: event.sourceSessionId, plannedContext: event.plannedContext,
      },
    });
  }

  private applyProviderActionAborted(taskId: string): void {
    const execution = this.executionFor(taskId);
    if (!execution.attempt || execution.attempt.state !== 'superseding' ||
      !execution.supersession) throw new TaskStorageError('internal');
    this.replaceExecution(execution, {
      ...this.withAttempt(execution, { ...execution.attempt, state: 'running' }),
      supersession: null,
    });
  }

  private applyCancellationRequested(event: CancellationRequestedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || isTerminal(execution.attempt.state) || execution.cancellation) {
      throw new TaskStorageError('internal');
    }
    this.replaceExecution(execution, {
      ...this.withAttempt(execution, { ...execution.attempt, state: 'cancelling' }),
      cancellation: {
        idempotencyKey: event.idempotencyKey,
        fingerprint: event.fingerprint,
      },
    });
  }

  private applyTerminal(
    taskId: string,
    state: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled'>,
    exitCode?: number,
  ): void {
    const execution = this.executionFor(taskId);
    if (!execution.attempt || isTerminal(execution.attempt.state)) throw new TaskStorageError('internal');
    this.replaceAttempt(execution, {
      ...execution.attempt,
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }
  private applyAttemptForked(event: AttemptForkedEvent): void {
    const execution = this.executionFor(event.taskId);
    if (!execution.attempt || !execution.context || !execution.providerSession || execution.attempt.id !== event.parentAttemptId || execution.providerSession.id !== event.parentSessionId || execution.attempt.number >= event.attempt.number) throw new TaskStorageError('internal');
    const parent = event.plannedContext ? execution.attempt
      : { ...execution.attempt, state: 'superseded' as const };
    this.replaceExecution(execution, { ...execution, attempt: event.attempt,
      attempts: [...execution.attempts.map((attempt) =>
        attempt.id === parent.id ? parent : attempt), event.attempt], context: null,
      providerSession: null, cancellation: null, supersession: null,
      plannedAction: event.plannedContext ? {
        kind: 'fork', actionKey: event.forkKey,
        sourceAttemptId: event.parentAttemptId,
        sourceSessionId: event.parentSessionId, plannedContext: event.plannedContext,
      } : null });
  }

  private providerRepair(execution: StoredExecution): PlannedProviderRepair | undefined {
    const planned = execution.plannedAction;
    if (!planned) return undefined;
    const parentSession = execution.providerSessions.find((session) =>
      session.id === planned.sourceSessionId && session.attemptId === planned.sourceAttemptId);
    const parentContext = parentSession && execution.executionContexts.find((context) =>
      context.id === parentSession.executionContextId);
    if (!parentSession || !parentContext) throw new TaskStorageError('internal');
    return { kind: planned.kind, parentContext, parentSession,
      plannedContext: planned.plannedContext };
  }

  private replaceExecution(current: StoredExecution, replacement: StoredExecution): void {
    if (
      this.executions.get(current.taskId) !== current ||
      this.executionKeys.get(current.idempotencyKey) !== current
    ) {
      throw new TaskStorageError('internal');
    }
    this.executions.set(replacement.taskId, replacement);
    this.executionKeys.set(replacement.idempotencyKey, replacement);
  }

  private replaceAttempt(execution: StoredExecution, attempt: StoredAttempt): void {
    this.replaceExecution(execution, this.withAttempt(execution, attempt));
  }

  private withAttempt(execution: StoredExecution, attempt: StoredAttempt): StoredExecution {
    return {
      ...execution,
      attempt,
      attempts: execution.attempts.map((stored) => stored.id === attempt.id ? attempt : stored),
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
    return projectExecution(task, execution);
  }

  private privateViewFor(
    task: TaskView,
    execution: StoredExecution | null,
  ): PrivateTaskExecutionView {
    return privateExecutionProjection(task, execution);
  }

  private lifecycleView(taskId: string): PrivateTaskExecutionView | null {
    const task = this.taskIds.get(taskId);
    if (!task) return null;
    return this.privateViewFor(task, this.executions.get(taskId) ?? null);
  }

  private async runProvider<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfPoisoned();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderSessionLifecycleError) throw new TaskStorageError(error.code);
      throw error;
    }
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
    try {
      this.store.throwIfPoisoned();
    } catch (error) {
      if (error instanceof TaskEventStoreError) throw new TaskStorageError('internal');
      throw error;
    }
  }
}

function requiredResumeParent(execution: StoredExecution, providerSessionId: string): {
  readonly attempt: StoredAttempt;
  readonly context: StoredContext;
  readonly session: StoredProviderSession;
} {
  if (!execution.attempt || !execution.context || !execution.providerSession ||
    execution.providerSession.id !== providerSessionId ||
    !['running', 'superseding', 'superseded'].includes(execution.attempt.state)) {
    throw new TaskStorageError('task-not-ready');
  }
  return {
    attempt: execution.attempt,
    context: execution.context,
    session: execution.providerSession,
  };
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

function recoveryFingerprint(taskId: string): string {
  return JSON.stringify(['reconcile', taskId]);
}

function recoveryDecisionFingerprint(request: RecoverTaskRequest): string {
  return JSON.stringify(['recover', request.taskId, request.recoveryId]);
}

function isTerminal(state: TaskExecutionState | undefined): boolean {
  return state === 'completed' || state === 'failed' ||
    state === 'cancelled' || state === 'superseded';
}

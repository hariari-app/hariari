import type {
  CancelTaskRequest,
  CreateTaskRequest,
  StartTaskRequest,
  ReconcileTaskRequest,
  RecoverTaskRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskRecoveryView,
  TaskRecoveryDecisionView,
  TaskTimelineView,
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
} from './task-events';
import {
  ProviderSessionLifecycle,
  ProviderSessionLifecycleError,
  type PreparedProviderAction,
  type ProviderActionDecision,
  type ProviderActionRejection,
  type ProviderSessionAction,
  type ProviderSessionOperationRequest,
} from './provider-session-lifecycle';
import { TaskEventStore, TaskEventStoreError } from './task-event-store';
import { type AttemptLifecycleKind, TaskEventTimeline } from './task-event-timeline';
import { TaskStorageError } from './task-storage-error';
import type {
  ExecutionReservation,
  NativeResumeReservation,
  PlannedProviderRepair,
  ProviderActionRepair,
  ProviderForkReservation,
  StoredExecution,
} from './task-execution-state';
import {
  abortProviderActionExecution,
  cancelExecution,
  executionFromRun,
  forkExecution,
  plannedProviderRepair,
  resumeExecution,
  terminalExecution,
} from './task-execution-state';
import {
  canonicalExecutionFingerprint,
  canonicalTaskFingerprint,
} from './task-fingerprints';
import {
  privateExecutionProjection,
  projectExecution,
  type PrivateTaskExecutionView,
} from './task-execution-projection';
import { TaskRecoveryJournal } from './task-recovery-journal';
import {
  isTerminalExecutionState,
  resumeParentExecution,
} from './task-execution-rules';

/** The sole serialized writer for durable Task and execution lifecycle evidence. */
export class TaskModule {
  readonly runtimeDirectory: string;
  private readonly store: TaskEventStore;
  private readonly tasks = new Map<string, TaskView>();
  private readonly taskIds = new Map<string, TaskView>();
  private readonly fingerprints = new Map<string, string>();
  private readonly taskCorrelations = new Map<string, string>();
  private readonly executions = new Map<string, StoredExecution>();
  private readonly executionKeys = new Map<string, StoredExecution>();
  private readonly eventTimeline: TaskEventTimeline;
  private readonly providerLifecycle: ProviderSessionLifecycle;
  private readonly recoveryJournal: TaskRecoveryJournal;
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    runtimeDirectory: string,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {
    this.runtimeDirectory = runtimeDirectory;
    this.store = new TaskEventStore(runtimeDirectory, randomId);
    this.eventTimeline = new TaskEventTimeline({
      now: () => new Date(this.now()).toISOString(),
      append: (event) => this.appendVisible(event),
      execution: (taskId) => this.executionFor(taskId),
    });
    this.providerLifecycle = new ProviderSessionLifecycle({
      view: (taskId) => this.lifecycleView(taskId),
      append: (event) => this.appendVisible(event),
    });
    this.recoveryJournal = new TaskRecoveryJournal({
      append: (event) => this.appendVisible(event),
      assertWritable: () => this.throwIfPoisoned(),
      fail: (code) => {
        throw new TaskStorageError(code);
      },
      serialize: (operation) => this.enqueue(operation),
      taskExists: (taskId) => this.taskIds.has(taskId),
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

  create(request: CreateTaskRequest, correlationId: string): Promise<TaskView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const fingerprint = canonicalTaskFingerprint(request);
      const existing = this.tasks.get(request.idempotencyKey);
      if (existing) {
        if (this.fingerprints.get(request.idempotencyKey) === fingerprint) {
          await this.eventTimeline.recordTaskCreated(
            existing,
            request.idempotencyKey,
            this.taskCorrelations.get(request.idempotencyKey) ?? request.idempotencyKey,
          );
          return existing;
        }
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
        correlationId,
        fingerprint,
      });
      await this.eventTimeline.recordTaskCreated(task, request.idempotencyKey, correlationId);
      return task;
    });
  }

  list(): readonly TaskView[] {
    return [...this.tasks.values()];
  }

  recoveryWorktrees(): readonly { readonly taskId: string; readonly worktreeId: string }[] {
    return [...this.executions.values()].flatMap((execution) =>
      [...new Set(execution.executionContexts.map((context) => context.worktreeId))]
        .map((worktreeId) => ({ taskId: execution.taskId, worktreeId })));
  }

  reserveExecution(
    request: StartTaskRequest,
    correlationId: string,
  ): Promise<ExecutionReservation> {
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
          const providerRepair = plannedProviderRepair(keyed);
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
        correlationId,
        fingerprint,
        run,
      });
      const attempt: StoredAttempt = { id: this.randomId(), number: 1, state: 'starting' };
      await this.appendVisible({ type: 'AttemptCreated', version: 1, taskId: task.id, attempt });
      return { execution: this.viewFor(task, this.executionFor(task.id)), created: true };
    });
  }

  allocateContext(taskId: string, context: StoredContext, providerSession: StoredProviderSession | null,
    providerObservation: unknown | null = null): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      const current = this.executionFor(task.id);
      if (current.context) {
        if (current.context.id !== context.id || current.providerSession?.id !== providerSession?.id) {
          throw new TaskStorageError('internal');
        }
      } else {
        await this.appendVisible({ type: 'ContextAllocated', version: 1, taskId, context, providerSession });
      }
      if (providerSession) {
        if (providerObservation === null) throw new TaskStorageError('internal');
        await this.eventTimeline.recordProviderObservation(
          this.executionFor(taskId),
          providerSession,
          providerObservation,
        );
      }
      return this.viewFor(task, this.executionFor(task.id));
    });
  }

  reserveNativeResume(request: ProviderSessionOperationRequest): Promise<NativeResumeReservation> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const execution = this.executionFor(task.id);
      const parent = resumeParentExecution(execution, request.providerSessionId);
      if (!parent) throw new TaskStorageError('task-not-ready');
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
        actionKey: request.idempotencyKey,
        correlationId: request.correlationId,
        plannedContext,
      });
      return { kind: 'native-resume', execution: this.viewFor(task, this.executionFor(task.id)),
        parentContext: parent.context, parentSession: parent.session, plannedContext };
    });
  }

  prepareProviderAction(
    request: ProviderSessionOperationRequest,
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
        forkKey: prepared.request.idempotencyKey,
        correlationId: prepared.request.correlationId,
        plannedContext,
      });
      return { kind: 'fork', execution: this.viewFor(task, this.executionFor(task.id)),
        parentContext: prepared.context, parentSession: prepared.session, plannedContext };
    });
  }

  recoverProviderAction(
    request: ProviderSessionOperationRequest, kind: PlannedProviderRepair['kind'],
  ): Promise<ProviderActionRepair | null> {
    return this.enqueue(async () => {
      const task = this.taskById(request.taskId);
      const execution = this.executionFor(task.id);
      const planned = execution.plannedAction;
      if (!planned || planned.kind !== kind || planned.actionKey !== request.idempotencyKey ||
        planned.sourceSessionId !== request.providerSessionId) return null;
      if (isTerminalExecutionState(execution.attempt?.state)) return { execution: this.viewFor(task, execution), repair: null };
      const repair = plannedProviderRepair(execution);
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
      if (execution.attempt?.state === 'cancelling' || isTerminalExecutionState(execution.attempt?.state)) {
        return this.viewFor(task, execution);
      }
      if (execution.attempt?.state === 'starting') await this.appendVisible(
        { type: 'AttemptStarted', version: 1, taskId });
      const started = this.executionFor(task.id);
      await this.eventTimeline.recordAttemptLifecycle(started, 'attempt-started');
      return this.viewFor(task, started);
    });
  }

  complete(taskId: string, exitCode: number): Promise<TaskExecutionView> {
    return this.finish(taskId, 'completed', exitCode);
  }

  fail(taskId: string): Promise<TaskExecutionView> {
    return this.finish(taskId, 'failed');
  }

  requestCancellation(
    request: CancelTaskRequest & { readonly correlationId: string },
  ): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      const execution = this.executions.get(task.id);
      if (!execution?.attempt) throw new TaskStorageError('task-not-ready');
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      if (isTerminalExecutionState(execution.attempt.state)) return this.viewFor(task, execution);
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
        correlationId: request.correlationId,
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

  timeline(taskId: string): TaskTimelineView {
    this.taskById(taskId);
    return this.eventTimeline.view(taskId, this.execution(taskId));
  }
  hasCompleteProviderSessionObservation(taskId: string, attemptId: string, providerSessionId: string): boolean {
    return this.eventTimeline.hasMatchingProviderObservation(taskId, attemptId, providerSessionId);
  }
  hasAttemptLifecycleEvent(taskId: string, attemptId: string, kind: AttemptLifecycleKind): boolean {
    return this.eventTimeline.hasLifecycleEvent(taskId, attemptId, kind);
  }
  privateExecution(taskId: string): PrivateTaskExecutionView {
    const task = this.taskById(taskId);
    return this.privateViewFor(task, this.executions.get(task.id) ?? null);
  }

  reconciliation(request: ReconcileTaskRequest): TaskRecoveryView | null {
    return this.recoveryJournal.reconciliation(request);
  }

  recordReconciliation(
    request: ReconcileTaskRequest,
    recovery: TaskRecoveryView,
  ): Promise<TaskRecoveryView> {
    return this.recoveryJournal.recordReconciliation(request, recovery);
  }

  recovery(request: RecoverTaskRequest): TaskRecoveryView {
    return this.recoveryJournal.recovery(request);
  }

  recoveryDecision(request: RecoverTaskRequest): TaskRecoveryDecisionView | null {
    return this.recoveryJournal.decision(request);
  }

  recordRecoveryDecision(
    request: RecoverTaskRequest,
    result: TaskRecoveryDecisionView,
  ): Promise<TaskRecoveryDecisionView> {
    return this.recoveryJournal.recordDecision(request, result);
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
      const terminal = await this.eventTimeline.recordTerminalTransition(
        execution,
        requested,
        exitCode,
      );
      return this.viewFor(task, terminal);
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
      case 'TaskCreated':
      case 'RunCreated':
      case 'AttemptCreated':
      case 'ContextAllocated':
        this.applyFoundationEvent(event);
        return;
      case 'RawProviderObservationRecorded':
      case 'NormalizedRuntimeEventRecorded':
        this.applyTimelineEvent(event);
        return;
      case 'AttemptStarted':
        this.applyAttemptStarted(event);
        return;
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
      case 'AttemptFailed':
      case 'AttemptCancelled':
        this.applyTerminalTransition(event);
        return;
      case 'AttemptForked':
        this.applyAttemptForked(event);
        return;
      case 'TaskReconciled':
      case 'TaskRecoveryDecided':
        this.recoveryJournal.replay(event);
        return;
    }
  }

  private applyFoundationEvent(
    event: Extract<
      TaskEvent,
      { type: 'TaskCreated' | 'RunCreated' | 'AttemptCreated' | 'ContextAllocated' }
    >,
  ): void {
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
    }
  }

  private applyTimelineEvent(
    event: Extract<
      TaskEvent,
      { type: 'RawProviderObservationRecorded' | 'NormalizedRuntimeEventRecorded' }
    >,
  ): void {
    this.taskById(event.taskId);
    const execution = event.type === 'NormalizedRuntimeEventRecorded' &&
      event.event.kind !== 'task-created'
      ? this.executionFor(event.taskId)
      : undefined;
    this.eventTimeline.apply(event, execution);
  }

  private applyTerminalTransition(
    event: Extract<
      TaskEvent,
      { type: 'AttemptCompleted' | 'AttemptFailed' | 'AttemptCancelled' }
    >,
  ): void {
    const execution = this.executionFor(event.taskId);
    this.replaceExecution(execution, terminalExecution(execution, event));
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
    this.taskCorrelations.set(event.idempotencyKey, event.correlationId);
  }

  private applyRunCreated(event: RunCreatedEvent): void {
    if (!this.taskIds.has(event.taskId) || this.executions.has(event.taskId)) {
      throw new TaskStorageError('internal');
    }
    const execution = executionFromRun(event);
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
      isTerminalExecutionState(execution.attempt.state)) throw new TaskStorageError('internal');
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
    this.replaceExecution(execution, resumeExecution(execution, event));
  }

  private applyProviderActionAborted(taskId: string): void {
    const execution = this.executionFor(taskId);
    this.replaceExecution(execution, abortProviderActionExecution(execution));
  }

  private applyCancellationRequested(event: CancellationRequestedEvent): void {
    const execution = this.executionFor(event.taskId);
    this.replaceExecution(execution, cancelExecution(execution, event));
  }

  private applyAttemptForked(event: AttemptForkedEvent): void {
    const execution = this.executionFor(event.taskId);
    this.replaceExecution(execution, forkExecution(execution, event));
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

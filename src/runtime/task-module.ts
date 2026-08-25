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
  type CancellationRequestedEvent,
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
import { TaskEventHistoryRepair } from './task-event-history-repair';
import { type AttemptLifecycleKind, TaskEventTimeline } from './task-event-timeline';
import { TaskStorageError } from './task-storage-error';
import { startTaskReplay } from './task-replay-startup';
import type {
  ExecutionReservation,
  NativeResumeReservation,
  PlannedProviderRepair,
  ProviderActionRepair,
  ProviderForkReservation,
  StoredExecution,
} from './task-execution-state';
import { plannedProviderRepair } from './task-execution-state';
import {
  canonicalExecutionFingerprint,
  canonicalTaskFingerprint,
} from './task-fingerprints';
import {
  TaskExecutionProjection,
  type PrivateTaskExecutionView,
} from './task-execution-projection';
import { TaskRecoveryJournal } from './task-recovery-journal';
import {
  isTerminalExecutionState,
  resumeParentExecution,
} from './task-execution-rules';
type ResumeParent = NonNullable<ReturnType<typeof resumeParentExecution>>;
/** Orchestrates serialized durable Task commands and replay routing. */
export class TaskModule {
  readonly runtimeDirectory: string;
  private readonly store: TaskEventStore;
  private readonly historyRepair: TaskEventHistoryRepair;
  private readonly tasks = new Map<string, TaskView>();
  private readonly taskIds = new Map<string, TaskView>();
  private readonly taskOwnershipKeys = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly taskCorrelations = new Map<string, string>();
  private readonly executionProjection: TaskExecutionProjection;
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
    this.executionProjection = new TaskExecutionProjection({
      taskExists: (taskId) => this.taskIds.has(taskId),
    });
    this.eventTimeline = new TaskEventTimeline({
      now: () => new Date(this.now()).toISOString(),
      append: (event) => this.appendVisible(event),
      execution: (taskId) => this.executionProjection.require(taskId),
    });
    this.historyRepair = new TaskEventHistoryRepair({
      now: () => new Date(this.now()).toISOString(),
      append: (event) => this.appendVisible(event),
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
    return startTaskReplay(
      () => this.store.start((event) => this.apply(event), () => this.list()),
      async () => {
        for (const task of this.list()) await this.historyRepair.repair(task.id);
        this.eventTimeline.assertReplayComplete(
          this.list().map((task) => this.executionProjection.view(task)));
      },
    );
  }
  create(request: CreateTaskRequest, correlationId: string): Promise<TaskView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const fingerprint = canonicalTaskFingerprint(request);
      const existing = this.tasks.get(request.idempotencyKey);
      if (existing) {
        await this.historyRepair.repair(existing.id);
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
    return this.executionProjection.recoveryWorktrees();
  }
  reserveExecution(
    request: StartTaskRequest,
    correlationId: string,
  ): Promise<ExecutionReservation> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      await this.historyRepair.repair(task.id);
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      const keyed = this.executionProjection.byKey(request.idempotencyKey);
      if (keyed) {
        return this.reserveExistingExecution(task, keyed, fingerprint);
      }
      return this.reserveNewExecution(task, request, correlationId, fingerprint);
    });
  }
  private async reserveExistingExecution(
    task: TaskView,
    execution: StoredExecution,
    fingerprint: string,
  ): Promise<ExecutionReservation> {
    if (execution.fingerprint !== fingerprint) {
      throw new TaskStorageError('idempotency-conflict');
    }
    if (!execution.attempt) {
      await this.appendVisible({
        type: 'AttemptCreated',
        version: 1,
        taskId: task.id,
        attempt: { id: this.randomId(), number: 1, state: 'starting' },
      });
      return {
        execution: this.executionProjection.view(task),
        created: true,
      };
    }
    if (execution.attempt.state === 'starting' && !execution.context) {
      return {
        execution: this.executionProjection.view(task),
        created: true,
        providerRepair: plannedProviderRepair(execution),
      };
    }
    return {
      execution: this.executionProjection.view(task),
      created: false,
    };
  }
  private async reserveNewExecution(
    task: TaskView,
    request: StartTaskRequest,
    correlationId: string,
    fingerprint: string,
  ): Promise<ExecutionReservation> {
    if (this.executionProjection.optional(task.id)) {
      throw new TaskStorageError('task-not-ready');
    }
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
    const attempt: StoredAttempt = {
      id: this.randomId(),
      number: 1,
      state: 'starting',
    };
    await this.appendVisible({
      type: 'AttemptCreated',
      version: 1,
      taskId: task.id,
      attempt,
    });
    return {
      execution: this.executionProjection.view(task),
      created: true,
    };
  }
  allocateContext(
    taskId: string,
    context: StoredContext,
    providerSession: StoredProviderSession | null,
    providerObservation: unknown | null = null,
    launchOutcome: 'succeeded' | 'failed' = 'succeeded',
  ): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      await this.historyRepair.repair(task.id);
      const current = this.executionProjection.require(task.id);
      if (current.context) {
        if (current.context.id !== context.id || current.providerSession?.id !== providerSession?.id) {
          throw new TaskStorageError('internal');
        }
      } else {
        await this.appendVisible({
          type: 'ContextAllocated',
          version: 1,
          taskId,
          context, providerSession, launchOutcome,
          ...(providerSession ? { observedAt: new Date(this.now()).toISOString() } : {}),
        });
      }
      if (providerSession) {
        if (providerObservation === null) {
          throw new TaskStorageError('internal');
        }
        await this.eventTimeline.recordProviderObservation(
          this.executionProjection.require(taskId),
          providerSession,
          providerObservation,
        );
      }
      return this.executionProjection.view(task);
    });
  }
  reserveNativeResume(request: ProviderSessionOperationRequest): Promise<NativeResumeReservation> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(request.taskId);
      await this.historyRepair.repair(task.id);
      const execution = this.executionProjection.require(task.id);
      const parent = resumeParentExecution(execution, request.providerSessionId);
      if (!parent) {
        throw new TaskStorageError('task-not-ready');
      }
      await this.supersedeResumeParent(task.id, parent, request.idempotencyKey);
      const plannedContext = this.resumedContext(parent.context);
      await this.appendVisible({
        type: 'AttemptResumed',
        version: 1,
        taskId: task.id,
        attempt: {
          id: this.randomId(),
          number: parent.attempt.number + 1,
          state: 'starting',
        },
        sourceAttemptId: parent.attempt.id,
        sourceSessionId: parent.session.id,
        actionKey: request.idempotencyKey,
        correlationId: request.correlationId,
        plannedContext,
      });
      return {
        kind: 'native-resume',
        execution: this.executionProjection.view(task),
        parentContext: parent.context,
        parentSession: parent.session,
        plannedContext,
      };
    });
  }
  private async supersedeResumeParent(
    taskId: string,
    parent: ResumeParent,
    actionKey: string,
  ): Promise<void> {
    if (parent.attempt.state === 'running') {
      await this.appendVisible({
        type: 'AttemptSupersessionRequested',
        version: 1,
        taskId,
        actionKey,
        parentAttemptId: parent.attempt.id,
        parentSessionId: parent.session.id,
        reason: 'native-resume',
      });
    }
    if (this.executionProjection.require(taskId).attempt?.state === 'superseding') {
      await this.appendVisible({
        type: 'AttemptSuperseded',
        version: 1,
        taskId,
        actionKey,
        attemptId: parent.attempt.id,
        reason: 'native-resume',
      });
    }
    if (this.executionProjection.require(taskId).attempt?.state !== 'superseded') {
      throw new TaskStorageError('internal');
    }
  }

  prepareProviderAction(
    request: ProviderSessionOperationRequest,
    action: ProviderSessionAction,
  ): Promise<PreparedProviderAction> {
    return this.enqueue(async () => {
      const task = this.taskById(request.taskId);
      await this.historyRepair.repair(task.id);
      return this.runProvider(() => this.providerLifecycle.prepare(request, action));
    });
  }

  acceptProviderAction(
    prepared: PreparedProviderAction,
    decision: ProviderActionDecision,
  ): Promise<void> {
    return this.enqueue(() =>
      this.runProvider(() => this.providerLifecycle.accept(prepared, decision)));
  }

  rejectProviderAction(
    prepared: PreparedProviderAction,
    reason: ProviderActionRejection,
  ): Promise<never> {
    return this.enqueue(() =>
      this.runProvider(() => this.providerLifecycle.reject(prepared, reason)));
  }

  abortProviderAction(prepared: PreparedProviderAction): Promise<void> {
    return this.enqueue(() =>
      this.runProvider(() => this.providerLifecycle.abort(prepared)));
  }

  requestProviderSupersession(
    prepared: PreparedProviderAction,
    reason: 'native-resume' | 'fork',
  ): Promise<TaskExecutionView> {
    return this.transition(prepared.request.taskId, {
      type: 'AttemptSupersessionRequested',
      version: 1,
      taskId: prepared.request.taskId,
      actionKey: prepared.request.idempotencyKey,
      parentAttemptId: prepared.session.attemptId,
      parentSessionId: prepared.session.id,
      reason,
    });
  }

  completeProviderSupersession(taskId: string, attemptId: string): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      const task = this.taskById(taskId);
      const execution = this.executionProjection.require(taskId);
      if (execution.attempt?.id === attemptId && execution.attempt.state === 'superseded') {
        return this.executionProjection.view(task);
      }
      if (!execution.supersession || execution.supersession.parentAttemptId !== attemptId) {
        throw new TaskStorageError('internal');
      }
      await this.appendVisible({
        type: 'AttemptSuperseded',
        version: 1,
        taskId,
        actionKey: execution.supersession.actionKey,
        attemptId,
        reason: execution.supersession.reason,
      });
      return this.executionProjection.view(task);
    });
  }

  reserveProviderFork(prepared: PreparedProviderAction): Promise<ProviderForkReservation> {
    return this.enqueue(async () => {
      const task = this.taskById(prepared.request.taskId);
      const execution = this.executionProjection.require(task.id);
      if (
        !execution.attempt ||
        execution.attempt.id !== prepared.session.attemptId ||
        execution.attempt.state !== 'superseded'
      ) {
        throw new TaskStorageError('task-not-ready');
      }
      const plannedContext = this.resumedContext(prepared.context);
      await this.appendVisible({
        type: 'AttemptForked',
        version: 1,
        taskId: task.id,
        attempt: {
          id: this.randomId(),
          number: execution.attempt.number + 1,
          state: 'starting',
        },
        parentAttemptId: execution.attempt.id,
        parentSessionId: prepared.session.id,
        forkKey: prepared.request.idempotencyKey,
        correlationId: prepared.request.correlationId,
        plannedContext,
      });
      return {
        kind: 'fork',
        execution: this.executionProjection.view(task),
        parentContext: prepared.context,
        parentSession: prepared.session,
        plannedContext,
      };
    });
  }

  recoverProviderAction(
    request: ProviderSessionOperationRequest,
    kind: PlannedProviderRepair['kind'],
  ): Promise<ProviderActionRepair | null> {
    return this.enqueue(async () => {
      const task = this.taskById(request.taskId);
      await this.historyRepair.repair(task.id);
      const execution = this.executionProjection.require(task.id);
      const planned = execution.plannedAction;
      if (
        !planned ||
        planned.kind !== kind ||
        planned.actionKey !== request.idempotencyKey ||
        planned.sourceSessionId !== request.providerSessionId
      ) {
        return null;
      }
      if (isTerminalExecutionState(execution.attempt?.state)) {
        return {
          execution: this.executionProjection.view(task),
          repair: null,
        };
      }
      const repair = plannedProviderRepair(execution);
      if (!repair) {
        throw new TaskStorageError('internal');
      }
      return {
        execution: this.executionProjection.view(task),
        repair,
      };
    });
  }

  private resumedContext(parent: StoredContext): StoredContext {
    return {
      ...parent,
      id: this.randomId(),
      processId: this.randomId(),
      ptyId: this.randomId(),
    };
  }

  markStarted(taskId: string): Promise<TaskExecutionView> {
    return this.enqueue(async () => {
      this.throwIfPoisoned();
      const task = this.taskById(taskId);
      await this.historyRepair.repair(task.id);
      const execution = this.executionProjection.require(task.id);
      if (
        execution.attempt?.state === 'cancelling' ||
        isTerminalExecutionState(execution.attempt?.state)
      ) {
        return this.executionProjection.view(task);
      }
      let occurredAt: string | undefined;
      if (execution.attempt?.state === 'starting') {
        occurredAt = new Date(this.now()).toISOString();
        await this.appendVisible({
          type: 'AttemptStarted',
          version: 1,
          taskId,
          occurredAt,
        });
      }
      const started = this.executionProjection.require(task.id);
      await this.eventTimeline.recordAttemptLifecycle(started, 'attempt-started', occurredAt);
      return this.executionProjection.view(task);
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
      await this.historyRepair.repair(task.id);
      const execution = this.executionProjection.optional(task.id);
      if (!execution?.attempt) {
        throw new TaskStorageError('task-not-ready');
      }
      const fingerprint = canonicalExecutionFingerprint(request.taskId);
      if (isTerminalExecutionState(execution.attempt.state)) {
        return this.executionProjection.view(task);
      }
      if (execution.cancellation) {
        if (execution.cancellation.idempotencyKey !== request.idempotencyKey) {
          throw new TaskStorageError('task-not-ready');
        }
        if (execution.cancellation.fingerprint !== fingerprint) {
          throw new TaskStorageError('idempotency-conflict');
        }
        await this.eventTimeline.recordAttemptLifecycle(execution, 'cancellation-requested');
        return this.executionProjection.view(task);
      }
      const occurredAt = new Date(this.now()).toISOString();
      await this.appendVisible({
        type: 'CancellationRequested',
        version: 1,
        taskId: task.id,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
        fingerprint,
        occurredAt,
      });
      const cancelling = this.executionProjection.require(task.id);
      if (!this.eventTimeline.hasLifecycleEvent(task.id, execution.attempt.id,
        'attempt-started')) {
        await this.eventTimeline.recordAttemptLifecycle(cancelling, 'attempt-started', occurredAt);
      }
      await this.eventTimeline.recordAttemptLifecycle(cancelling, 'cancellation-requested',
        occurredAt);
      return this.executionProjection.view(task);
    });
  }

  cancel(taskId: string): Promise<TaskExecutionView> {
    return this.finish(taskId, 'cancelled');
  }

  execution(taskId: string): TaskExecutionView {
    const task = this.taskById(taskId);
    return this.executionProjection.view(task);
  }

  repairForPublication(taskId: string): Promise<void> {
    this.taskById(taskId);
    return this.enqueue(() => this.historyRepair.repair(taskId));
  }
  timeline(taskId: string): TaskTimelineView {
    this.taskById(taskId);
    return this.eventTimeline.view(taskId, this.execution(taskId));
  }

  hasCompleteProviderSessionObservation(
    taskId: string,
    attemptId: string,
    providerSessionId: string,
  ): boolean {
    return this.eventTimeline.hasMatchingProviderObservation(taskId, attemptId, providerSessionId);
  }
  hasAttemptLifecycleEvent(
    taskId: string,
    attemptId: string,
    kind: AttemptLifecycleKind,
  ): boolean {
    return this.eventTimeline.hasLifecycleEvent(taskId, attemptId, kind);
  }

  privateExecution(taskId: string): PrivateTaskExecutionView {
    const task = this.taskById(taskId);
    return this.executionProjection.privateView(task);
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
      return this.executionProjection.view(task);
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
      const current = this.executionProjection.require(task.id);
      if (isTerminalExecutionState(current.attempt?.state)) {
        await this.historyRepair.repair(task.id);
      }
      const execution = this.executionProjection.require(task.id);
      await this.eventTimeline.recordTerminalTransition(
        execution,
        requested,
        exitCode,
      );
      return this.executionProjection.view(task);
    });
  }

  private async appendVisible(event: TaskEvent): Promise<void> {
    try {
      await this.store.appendVisible(
        event,
        (applied) => this.apply(applied),
        () => this.list(),
      );
    } catch (error) {
      if (error instanceof TaskStorageError) {
        throw error;
      }
      throw new TaskStorageError('internal');
    }
  }

  private apply(event: TaskEvent): void {
    this.historyRepair.accept(event, 'taskId' in event
      ? this.executionProjection.optional(event.taskId)?.attempt?.id ?? null
      : null);
    switch (event.type) {
      case 'TaskCreated':
        this.applyTaskCreated(event);
        return;
      case 'RawProviderObservationRecorded': {
        const task = this.taskById(event.taskId);
        this.eventTimeline.apply(event, this.executionProjection.view(task));
        return;
      }
      case 'NormalizedRuntimeEventRecorded': {
        const task = this.taskById(event.taskId);
        this.eventTimeline.apply(event, this.executionProjection.view(task));
        return;
      }
      case 'ProviderSessionActionDecided':
        this.providerLifecycle.replay(event);
        this.executionProjection.apply(event);
        return;
      case 'ProviderSessionActionAborted':
        this.providerLifecycle.replayAbort(event);
        this.executionProjection.apply(event);
        return;
      case 'TaskReconciled':
      case 'TaskRecoveryDecided':
        this.recoveryJournal.replay(event);
        return;
      default:
        this.executionProjection.apply(event);
    }
  }

  private applyTaskCreated(event: TaskCreatedEvent): void {
    const existing = this.tasks.get(event.idempotencyKey);
    const matchingTask = this.taskIds.get(event.task.id);
    const ownershipKey = this.taskOwnershipKeys.get(event.task.id);
    if (existing || matchingTask || ownershipKey) {
      throw new TaskStorageError('internal');
    }
    this.eventTimeline.registerTaskCreated(
      event.task,
      event.idempotencyKey,
      event.correlationId,
    );
    this.tasks.set(event.idempotencyKey, event.task);
    this.taskIds.set(event.task.id, event.task);
    this.taskOwnershipKeys.set(event.task.id, event.idempotencyKey);
    this.fingerprints.set(event.idempotencyKey, event.fingerprint);
    this.taskCorrelations.set(event.idempotencyKey, event.correlationId);
  }

  private taskById(taskId: string): TaskView {
    const task = this.taskIds.get(taskId);
    if (!task) {
      throw new TaskStorageError('not-found');
    }
    return task;
  }

  private lifecycleView(taskId: string): PrivateTaskExecutionView | null {
    const task = this.taskIds.get(taskId);
    if (!task) {
      return null;
    }
    return this.executionProjection.privateView(task);
  }

  private async runProvider<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfPoisoned();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderSessionLifecycleError) {
        throw new TaskStorageError(error.code);
      }
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
      if (error instanceof TaskEventStoreError) {
        throw new TaskStorageError('internal');
      }
      throw error;
    }
  }
}

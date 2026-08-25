import { randomUUID } from 'node:crypto';
import type {
  CancelTaskRequest,
  ReconcileTaskRequest,
  RecoverTaskRequest,
  StartTaskRequest,
  ProviderSessionActionRequest,
  TaskExecutionView,
  TaskOutputEvent,
  TaskRecoveryView,
  TaskRecoveryDecisionView,
} from '../shared/runtime/runtime-interface';
import {
  GenericCliExecutionError,
  type GenericCliExecution,
  type GenericCliExecutionAdapter,
  type PlannedExecutionContext,
  type PrivateProviderSession,
  type ExecutionLaunchPlan,
} from './generic-cli-execution-adapter';
import { TaskModule } from './task-module';
import type { ProviderSessionOperationRequest } from './provider-session-lifecycle';
import type { PlannedProviderRepair } from './task-execution-state';
import type { PrivateTaskExecutionView } from './task-execution-projection';
import { ProviderObservationValidationError } from './task-event-timeline';
import { TaskOutputLog } from './task-output-log';
import { RecoveryReconciler } from './recovery-reconciler';
const MAX_OUTPUT_CHARS = 4 * 1024;
interface InFlightOperation {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly promise: Promise<TaskExecutionView>;
}
type TerminalTransition =
  | { readonly kind: 'start-failure' }
  | { readonly kind: 'process-exit'; readonly exitCode: number };
interface PlannedAttachment {
  readonly parentId: string | null;
  readonly repair: boolean;
  readonly lineage: 'new' | 'native-resume' | 'fork';
}
export class TaskExecutionError extends Error {
  constructor(readonly code: 'worktree-unavailable' | 'process-start-failed' | 'task-not-ready' | 'internal') {
    super(`Task execution failed: ${code}`);
    this.name = 'TaskExecutionError';
  }
}
/** Runtime-owned execution module: adapter lifecycle, transient output, and durable transitions. */
export class TaskExecutionModule {
  private readonly operations = new Map<string, InFlightOperation>();
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly exitWaits = new Map<string, ExitWait>();
  private readonly active = new Map<string, GenericCliExecution>();
  private readonly activeAttempts = new Map<string, GenericCliExecution>();
  private readonly subscribers = new Map<string, Set<(event: TaskOutputEvent) => void>>();
  private readonly outputSequences = new Map<string, number>();
  private readonly outputPoisoned = new Set<string>();
  private readonly outputLog: TaskOutputLog;
  private readonly recovery: RecoveryReconciler;
  constructor(
    private readonly tasks: TaskModule,
    private readonly adapter: GenericCliExecutionAdapter,
    private readonly randomId: () => string,
  ) {
    this.outputLog = new TaskOutputLog(tasks.runtimeDirectory);
    this.recovery = new RecoveryReconciler(randomId);
  }
  start(request: StartTaskRequest, correlationId: string): Promise<TaskExecutionView> {
    return this.runTaskOperation(
      request.taskId, request.idempotencyKey,
      JSON.stringify(['start', request.taskId]),
      () => this.startOwned(request, correlationId),
    );
  }
  resumeProvider(
    request: ProviderSessionActionRequest,
    correlationId: string,
  ): Promise<TaskExecutionView> {
    const operationRequest = { ...request, correlationId };
    return this.runTaskOperation(
      request.taskId,
      request.idempotencyKey,
      JSON.stringify(['resume', request.taskId, request.providerSessionId]),
      () => this.resumeProviderOwned(operationRequest),
    );
  }
  private async resumeProviderOwned(
    request: ProviderSessionOperationRequest,
  ): Promise<TaskExecutionView> {
    const prepared = await this.tasks.prepareProviderAction(request, 'resume');
    if (prepared.prior?.decision === 'exact-reattach') {
      return this.tasks.execution(request.taskId);
    }
    const current = this.tasks.execution(request.taskId);
    if (prepared.prior?.decision === 'native-resume' &&
      current.providerSession?.parentId === request.providerSessionId &&
      current.providerSession.lineage === 'native-resume') return current;
    const recovery = await this.tasks.recoverProviderAction(prepared.request, 'native-resume');
    if (recovery && !recovery.repair) return recovery.execution;
    if (recovery?.repair) return this.startReserved(
      { taskId: request.taskId, idempotencyKey: request.idempotencyKey },
      recovery.execution, recovery.repair,
    );
    if (prepared.prior?.decision === 'native-resume') {
      this.releaseLostActive(request.taskId);
      const reservation = await this.tasks.reserveNativeResume(prepared.request);
      return this.startNativeResumeReserved(request.taskId, reservation);
    }
    const observation = await this.adapter.observe(bindingFor(prepared));
    if (observation === 'unknown') {
      return this.tasks.rejectProviderAction(prepared, 'task-not-ready');
    }
    if (observation === 'live') {
      await this.tasks.acceptProviderAction(prepared, 'exact-reattach');
      return this.tasks.execution(request.taskId);
    }
    await this.tasks.acceptProviderAction(prepared, 'native-resume');
    this.releaseLostActive(request.taskId);
    const reservation = await this.tasks.reserveNativeResume(prepared.request);
    return this.startNativeResumeReserved(request.taskId, reservation);
  }
  private releaseLostActive(taskId: string): void {
    const active = this.active.get(taskId);
    active?.dispose();
    this.active.delete(taskId);
    for (const [attemptId, candidate] of this.activeAttempts) {
      if (candidate === active) this.activeAttempts.delete(attemptId);
    }
  }
  forkProvider(
    request: ProviderSessionActionRequest,
    correlationId: string,
  ): Promise<TaskExecutionView> {
    const operationRequest = { ...request, correlationId };
    return this.runTaskOperation(
      request.taskId,
      request.idempotencyKey,
      JSON.stringify(['fork', request.taskId, request.providerSessionId]),
      () => this.forkProviderOwned(operationRequest),
    );
  }
  private async forkProviderOwned(
    request: ProviderSessionOperationRequest,
  ): Promise<TaskExecutionView> {
    const prepared = await this.tasks.prepareProviderAction(request, 'fork');
    const current = this.tasks.execution(request.taskId);
    if (prepared.prior && current.providerSession?.parentId === request.providerSessionId) {
      return current;
    }
    const recovery = await this.tasks.recoverProviderAction(prepared.request, 'fork');
    if (recovery && !recovery.repair) return recovery.execution;
    if (recovery?.repair) return this.startReserved(
      { taskId: request.taskId, idempotencyKey: request.idempotencyKey },
      recovery.execution, recovery.repair,
    );
    if (await this.adapter.observe(bindingFor(prepared)) === 'unknown') {
      return this.tasks.rejectProviderAction(prepared, 'task-not-ready');
    }
    await this.tasks.acceptProviderAction(prepared, 'fork');
    if (current.attempt?.state !== 'superseded') {
      if (current.attempt?.state === 'running') {
        await this.tasks.requestProviderSupersession(prepared, 'fork');
      }
      await this.stopAndConfirmParentLost(prepared);
      await this.tasks.completeProviderSupersession(request.taskId, prepared.session.attemptId);
    }
    const reservation = await this.tasks.reserveProviderFork(prepared);
    return this.startProviderForkReserved(request.taskId, reservation);
  }
  private async stopAndConfirmParentLost(
    prepared: import('./provider-session-lifecycle').PreparedProviderAction,
  ): Promise<void> {
    const active = this.active.get(prepared.request.taskId);
    try {
      if (active) await active.stop();
      else await this.adapter.stop(bindingFor(prepared));
    } catch {
      const observation = await this.adapter.observe(bindingFor(prepared));
      if (observation === 'lost') {
        this.releaseSupersededActive(
          prepared.request.taskId, prepared.session.attemptId,
        );
        return;
      }
      if (observation === 'live') await this.tasks.abortProviderAction(prepared);
      throw new TaskExecutionError('internal');
    }
    const observation = await this.adapter.observe(bindingFor(prepared));
    if (observation === 'lost') return;
    if (observation === 'live') await this.tasks.abortProviderAction(prepared);
    throw new TaskExecutionError('internal');
  }
  private releaseSupersededActive(taskId: string, attemptId: string): void {
    const active = this.activeAttempts.get(attemptId);
    active?.dispose();
    this.activeAttempts.delete(attemptId);
    if (this.active.get(taskId) === active) this.active.delete(taskId);
  }
  private runTaskOperation(
    taskId: string,
    idempotencyKey: string,
    fingerprint: string,
    operation: () => Promise<TaskExecutionView>,
  ): Promise<TaskExecutionView> {
    const inFlight = this.operations.get(taskId);
    if (inFlight) {
      if (inFlight.idempotencyKey === idempotencyKey && inFlight.fingerprint === fingerprint) {
        return inFlight.promise;
      }
      return inFlight.promise.then(
        () => this.runTaskOperation(taskId, idempotencyKey, fingerprint, operation),
        () => this.runTaskOperation(taskId, idempotencyKey, fingerprint, operation),
      );
    }
    const promise = operation();
    const owned = { idempotencyKey, fingerprint, promise };
    this.operations.set(taskId, owned);
    void promise.then(() => this.releaseOperation(taskId, owned),
      () => this.releaseOperation(taskId, owned));
    return promise;
  }
  private releaseOperation(taskId: string, owned: InFlightOperation): void {
    if (this.operations.get(taskId) === owned) this.operations.delete(taskId);
  }
  private async startOwned(
    request: StartTaskRequest,
    correlationId: string,
  ): Promise<TaskExecutionView> {
    const reservation = await this.tasks.reserveExecution(request, correlationId);
    return reservation.created
      ? this.startReserved(
          request, reservation.execution, reservation.providerRepair,
        )
      : reservation.execution;
  }
  async cancel(
    request: CancelTaskRequest,
    correlationId: string,
  ): Promise<TaskExecutionView> {
    const operationRequest = { ...request, correlationId };
    const inFlight = this.operations.get(request.taskId);
    if (inFlight?.fingerprint === JSON.stringify(['start', request.taskId])) {
      return this.tasks.requestCancellation(operationRequest);
    }
    return this.runTaskOperation(
      request.taskId, request.idempotencyKey,
      JSON.stringify(['cancel', request.taskId]),
      () => this.cancelOwned(operationRequest),
    );
  }
  private async cancelOwned(
    request: CancelTaskRequest & { readonly correlationId: string },
  ): Promise<TaskExecutionView> {
    const view = await this.tasks.requestCancellation(request);
    if (view.attempt?.state !== 'cancelling') return view;
    const active = this.active.get(request.taskId);
    if (!active) return this.continueRecoveredCancellation(request.taskId);
    return this.stopCancelled(request.taskId, active);
  }
  private async continueRecoveredCancellation(
    taskId: string,
  ): Promise<TaskExecutionView> {
    const binding = privateBinding(this.tasks.privateExecution(taskId));
    const state = await this.adapter.observe(binding);
    if (state === 'unknown') {
      throw new TaskExecutionError('task-not-ready');
    }
    if (state === 'live') {
      try {
        await this.adapter.stop(binding);
      } catch {
        throw new TaskExecutionError('internal');
      }
    }
    return this.tasks.cancel(taskId);
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
  async settlePendingExits(): Promise<void> {
    while (this.settlements.size > 0) {
      const results = await Promise.allSettled([...this.settlements.values()]);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    }
  }
  async reconcile(request: ReconcileTaskRequest): Promise<TaskRecoveryView> {
    const existing = this.tasks.reconciliation(request);
    if (existing) return existing;
    const desired = this.tasks.privateExecution(request.taskId);
    const binding = recoveryBinding(desired, this.tasks.recoveryWorktrees());
    const observation = await this.adapter.observeRecovery(binding);
    return this.tasks.recordReconciliation(
      request,
      this.recovery.reconcile(desired, observation),
    );
  }
  recover(request: RecoverTaskRequest): Promise<TaskRecoveryDecisionView> {
    const existing = this.tasks.recoveryDecision(request);
    if (existing) return Promise.resolve(existing);
    const recovery = this.tasks.recovery(request);
    return this.tasks.recordRecoveryDecision(request, this.recovery.commit(recovery));
  }
  subscribe(
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
  ): { readonly replay: readonly TaskOutputEvent[]; readonly unsubscribe: () => void } {
    this.tasks.execution(taskId);
    const listeners = this.subscribers.get(taskId) ?? new Set<(event: TaskOutputEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return {
      replay: this.outputLog.replay(taskId),
      unsubscribe: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.subscribers.delete(taskId);
      },
    };
  }
  private async startReserved(
    request: StartTaskRequest,
    execution: TaskExecutionView,
    providerRepair?: PlannedProviderRepair,
  ): Promise<TaskExecutionView> {
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    const plannedContext = providerRepair
      ? plannedContextFor(
          execution, this.retryProviderContext(execution, providerRepair.plannedContext),
          (data) => this.publishOutput(request.taskId, execution.attempt!.id, data),
          (exitCode) => void this.settle(request.taskId, execution.attempt!.id, exitCode),
        )
      : this.newPlannedContext(request.taskId, execution);
    const sourceRepair = providerRepair;
    const plan: ExecutionLaunchPlan = providerRepair
      ? { kind: providerRepair.kind, source: providerSource(
          providerRepair.parentSession, providerRepair.parentContext,
        ), plannedContext } as ExecutionLaunchPlan
      : { kind: 'new',
          nativeSessionId: execution.task.provider === 'claude' ? randomUUID() : null,
          plannedContext };
    return this.launchPlannedAttempt(request.taskId, execution, plan, {
      parentId: sourceRepair?.parentSession.id ?? null,
      repair: sourceRepair !== undefined,
      lineage: providerRepair?.kind ?? 'new',
    });
  }

  private retryProviderContext(
    execution: TaskExecutionView,
    planned: import('./task-events').StoredContext,
  ): import('./task-events').StoredContext {
    if (!execution.executionContexts.some((context) => context.id === planned.id)) return planned;
    return {
      ...planned,
      id: this.randomId(),
      processId: this.randomId(),
      ptyId: this.randomId(),
    };
  }
  private async startNativeResumeReserved(
    taskId: string,
    reservation: import('./task-execution-state').NativeResumeReservation,
  ): Promise<TaskExecutionView> {
    const execution = reservation.execution;
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    const plannedContext = plannedContextFor(
      execution, reservation.plannedContext,
      (data) => this.publishOutput(taskId, execution.attempt!.id, data),
      (exitCode) => void this.settle(taskId, execution.attempt!.id, exitCode),
    );
    return this.launchPlannedAttempt(taskId, execution, {
      kind: 'native-resume',
      source: providerSource(reservation.parentSession, reservation.parentContext),
      plannedContext,
    }, { parentId: reservation.parentSession.id, repair: true, lineage: 'native-resume' });
  }
  private async startProviderForkReserved(
    taskId: string,
    reservation: import('./task-execution-state').ProviderForkReservation,
  ): Promise<TaskExecutionView> {
    const execution = reservation.execution;
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    const plannedContext = plannedContextFor(
      execution, reservation.plannedContext,
      (data) => this.publishOutput(taskId, execution.attempt!.id, data),
      (exitCode) => void this.settle(taskId, execution.attempt!.id, exitCode),
    );
    return this.launchPlannedAttempt(taskId, execution, {
      kind: 'fork', source: providerSource(reservation.parentSession, reservation.parentContext),
      plannedContext,
    }, { parentId: reservation.parentSession.id, repair: true, lineage: 'fork' });
  }
  private newPlannedContext(
    taskId: string,
    execution: TaskExecutionView,
  ): PlannedExecutionContext {
    return {
      task: execution.task,
      run: execution.run!,
      attempt: execution.attempt!,
      identities: {
        contextId: this.randomId(),
        worktreeId: this.randomId(),
        processId: this.randomId(),
        ptyId: this.randomId(),
      },
      onOutput: (data) => this.publishOutput(taskId, execution.attempt!.id, data),
      onExit: (exitCode) => void this.settle(taskId, execution.attempt!.id, exitCode),
    };
  }
  private async launchPlannedAttempt(
    taskId: string,
    execution: TaskExecutionView,
    plan: ExecutionLaunchPlan,
    attachment: PlannedAttachment,
  ): Promise<TaskExecutionView> {
    if (!execution.attempt) throw new TaskExecutionError('internal');
    let active: GenericCliExecution | null = null;
    try {
      const capabilities = await this.adapter.capabilities(execution.task);
      active = await this.adapter.launch(plan);
      assertPlannedLaunch(plan, active, capabilities);
      this.active.set(taskId, active);
      this.activeAttempts.set(execution.attempt.id, active);
      this.exitWaits.set(taskId, new ExitWait());
      await this.attachContext(
        taskId, execution, active, attachment.parentId,
        attachment.repair, attachment.lineage,
      );
      const started = await this.markStartedWithRepair(taskId, execution.attempt.id);
      active.activateExit();
      if (started.attempt?.state === 'cancelling') {
        void this.stopCancelled(taskId, active).catch(() => undefined);
        return started;
      }
      active.activateOutput();
      return started;
    } catch (error) {
      if (error instanceof ProviderObservationValidationError) {
        if (active) await active.stop().catch(() => undefined);
        this.releaseLostActive(taskId);
        this.resolveExitWait(taskId);
        throw new TaskExecutionError('internal');
      }
      return this.failStart(taskId, active, error);
    }
  }
  private async failStart(
    taskId: string,
    active: GenericCliExecution | null,
    error: unknown,
  ): Promise<never> {
    const failedContext = active?.context ??
      (error instanceof GenericCliExecutionError ? error.context : null);
    if (active) {
      await active.stop().catch(() => undefined);
      active.dispose();
      this.active.delete(taskId);
      for (const [attemptId, candidate] of this.activeAttempts) {
        if (candidate === active) this.activeAttempts.delete(attemptId);
      }
    }
    if (failedContext && !this.tasks.execution(taskId).context) {
      await this.allocateFailedContext(taskId, failedContext);
    }
    try {
      await this.persistTerminalWithRepair(taskId, { kind: 'start-failure' });
    } finally {
      this.resolveExitWait(taskId);
    }
    if (error instanceof GenericCliExecutionError) throw new TaskExecutionError(error.code);
    throw new TaskExecutionError('internal');
  }
  private async markStartedWithRepair(
    taskId: string,
    attemptId: string,
  ): Promise<TaskExecutionView> {
    try {
      return await this.tasks.markStarted(taskId);
    } catch (error) {
      if (this.tasks.execution(taskId).attempt?.state !== 'running') throw error;
      if (!this.tasks.hasAttemptLifecycleEvent(taskId, attemptId, 'attempt-started')) {
        return this.tasks.markStarted(taskId);
      }
      return this.tasks.execution(taskId);
    }
  }
  private async attachContext(
    taskId: string,
    execution: TaskExecutionView,
    active: GenericCliExecution,
    parentId: string | null,
    repair: boolean,
    lineage: 'new' | 'native-resume' | 'fork' = 'new',
  ): Promise<void> {
    if (!execution.attempt) throw new TaskExecutionError('internal');
    const providerSession = active.providerSession && execution.task.provider === 'claude'
      ? { id: this.randomId(), provider: 'claude' as const,
          nativeSessionId: active.providerSession.nativeSessionId, taskId,
          attemptId: execution.attempt.id, executionContextId: active.context.id,
          capabilities: active.providerSession.capabilities, parentId,
          lineage }
      : null;
    if (!repair) {
      try {
        await this.tasks.allocateContext(
          taskId, active.context, providerSession, active.providerObservation,
        );
      } catch (error) {
        if (this.tasks.execution(taskId).context?.id !== active.context.id) throw error;
        await this.tasks.allocateContext(
          taskId, active.context, providerSession, active.providerObservation,
        );
      }
      return;
    }
    await this.persistWithOneShotRepair(
      taskId,
      (view) => view.context?.id === active.context.id &&
        (providerSession === null || (view.providerSession?.id === providerSession.id &&
          this.tasks.hasCompleteProviderSessionObservation(
            taskId, execution.attempt!.id, providerSession.id,
          ))),
      () => this.tasks.allocateContext(
        taskId, active.context, providerSession, active.providerObservation,
      ),
    );
  }

  private async allocateFailedContext(
    taskId: string,
    context: GenericCliExecution['context'],
  ): Promise<void> {
    await this.persistWithOneShotRepair(
      taskId,
      (view) => view.executionContexts.some((candidate) => candidate.id === context.id),
      () => this.tasks.allocateContext(taskId, context, null, null, 'failed'),
    );
  }

  private settle(taskId: string, attemptId: string, exitCode: number): void {
    if (this.tasks.execution(taskId).attempt?.id !== attemptId) {
      this.activeAttempts.get(attemptId)?.dispose();
      this.activeAttempts.delete(attemptId);
      return;
    }
    if (this.settlements.has(attemptId)) return;
    const settlement = this.persistTerminalWithRepair(taskId, { kind: 'process-exit', exitCode })
      .then(() => this.release(taskId, attemptId))
      .catch((error: unknown) => {
        this.rejectExitWait(taskId, error);
        this.release(taskId, attemptId);
        throw error;
      });
    this.settlements.set(attemptId, settlement);
    void settlement.catch(() => undefined);
  }

  private async persistWithOneShotRepair(
    taskId: string,
    applied: (view: TaskExecutionView) => boolean,
    transition: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await transition();
    } catch {
      if (applied(this.tasks.execution(taskId))) return;
      await transition();
    }
  }

  private persistTerminalWithRepair(taskId: string, transition: TerminalTransition): Promise<void> {
    return this.persistWithOneShotRepair(
      taskId,
      (view) => this.hasPersistedTerminalLifecycle(taskId, view),
      () => this.persistTerminal(taskId, transition),
    );
  }

  private hasPersistedTerminalLifecycle(taskId: string, view: TaskExecutionView): boolean {
    const state = view.attempt?.state;
    if (state === 'superseded') return true;
    return (state === 'completed' || state === 'failed' || state === 'cancelled') &&
      this.tasks.hasAttemptLifecycleEvent(taskId, view.attempt!.id, `attempt-${state}`);
  }

  private release(taskId: string, attemptId: string): void {
    const active = this.activeAttempts.get(attemptId);
    active?.dispose();
    this.activeAttempts.delete(attemptId);
    if (this.active.get(taskId) === active) this.active.delete(taskId);
    this.settlements.delete(attemptId);
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

  private async persistTerminal(taskId: string, transition: TerminalTransition): Promise<void> {
    const view = this.tasks.execution(taskId);
    if (!view.attempt || view.attempt.state === 'superseded') return;
    if (view.attempt.state === 'completed') {
      await this.tasks.complete(taskId, view.attempt.exitCode ?? 0);
      return;
    }
    if (view.attempt.state === 'failed') {
      await this.tasks.fail(taskId);
      return;
    }
    if (view.attempt.state === 'cancelled') {
      await this.tasks.cancel(taskId);
      return;
    }
    if (view.attempt.state === 'superseding') {
      await this.tasks.completeProviderSupersession(taskId, view.attempt.id);
    } else if (view.attempt.state === 'cancelling') await this.tasks.cancel(taskId);
    else if (transition.kind === 'process-exit' && transition.exitCode === 0) {
      await this.tasks.complete(taskId, transition.exitCode);
    } else await this.tasks.fail(taskId);
  }

  private publishOutput(taskId: string, attemptId: string, value: string): void {
    if (this.outputPoisoned.has(taskId)) return;
    const data = sanitizeOutput(value);
    if (data.length === 0) return;
    const sequence = (this.outputSequences.get(taskId) ?? this.outputLog.lastSequence(taskId)) + 1;
    const event = { kind: 'data' as const, taskId, attemptId, sequence, data };
    if (!this.persistAndPublish(taskId, event)) return;
    if (data.length < value.length) {
      const droppedSequence = sequence + 1;
      const dropped = { kind: 'dropped' as const, taskId, attemptId, sequence: droppedSequence };
      this.persistAndPublish(taskId, dropped);
    }
  }

  private persistAndPublish(taskId: string, event: TaskOutputEvent): boolean {
    try {
      this.outputLog.append(event);
      this.outputSequences.set(taskId, event.sequence);
      this.publish(event);
      return true;
    } catch {
      this.outputPoisoned.add(taskId);
      return false;
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

function assertPlannedLaunch(
  plan: ExecutionLaunchPlan,
  active: GenericCliExecution,
  capabilities: import('../shared/runtime/runtime-interface').ProviderSessionCapabilities,
): void {
  const identities = plan.plannedContext.identities;
  if (active.context.id !== identities.contextId ||
    active.context.worktreeId !== identities.worktreeId ||
    active.context.processId !== identities.processId || active.context.ptyId !== identities.ptyId) {
    throw new GenericCliExecutionError('process-start-failed');
  }
  const observed = active.providerSession?.capabilities ?? { resume: false, fork: false };
  if (observed.resume !== capabilities.resume || observed.fork !== capabilities.fork) {
    throw new GenericCliExecutionError('process-start-failed');
  }
}

function providerSource(
  session: NonNullable<PrivateTaskExecutionView['providerSession']>,
  context: NonNullable<PrivateTaskExecutionView['context']>,
): PrivateProviderSession {
  return { ...session, context };
}

function plannedContextFor(
  execution: TaskExecutionView,
  context: NonNullable<PrivateTaskExecutionView['context']>,
  onOutput: (data: string) => void,
  onExit: (exitCode: number) => void,
): PlannedExecutionContext {
  return {
    task: execution.task,
    run: execution.run!,
    attempt: execution.attempt!,
    identities: {
      contextId: context.id, worktreeId: context.worktreeId,
      processId: context.processId, ptyId: context.ptyId,
    },
    onOutput,
    onExit,
  };
}

function bindingFor(
  prepared: import('./provider-session-lifecycle').PreparedProviderAction,
): import('./generic-cli-execution-adapter').PrivateExecutionBinding {
  return {
    task: prepared.execution.task,
    run: prepared.execution.run!,
    attempt: prepared.execution.attempt!,
    context: prepared.context,
    providerSession: providerSource(prepared.session, prepared.context),
  };
}

function privateBinding(view: PrivateTaskExecutionView) {
  if (!view.run || !view.attempt || !view.context) {
    throw new TaskExecutionError('task-not-ready');
  }
  return {
    task: view.task,
    run: view.run,
    attempt: view.attempt,
    context: view.context,
    providerSession: view.providerSession
      ? providerSource(view.providerSession, view.context)
      : null,
  };
}

function recoveryBinding(
  desired: PrivateTaskExecutionView,
  runtimeWorktrees: import('./generic-cli-execution-adapter').PrivateRecoveryBinding['runtimeWorktrees'],
): import('./generic-cli-execution-adapter').PrivateRecoveryBinding {
  if (!desired.run || !desired.attempt) {
    throw new TaskExecutionError('task-not-ready');
  }
  return {
    task: desired.task,
    run: desired.run,
    attempt: desired.attempt,
    context: desired.context,
    providerSession: desired.providerSession && desired.context
      ? providerSource(desired.providerSession, desired.context)
      : null,
    runtimeWorktrees,
  };
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

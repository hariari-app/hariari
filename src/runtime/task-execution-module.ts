import { randomUUID } from 'node:crypto';
import type {
  CancelTaskRequest,
  StartTaskRequest,
  ForkClaudeSessionRequest,
  ResumeClaudeSessionRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskOutputEvent,
} from '../shared/runtime/runtime-interface';
import {
  GenericCliExecutionError,
  type GenericCliExecution,
  type GenericCliExecutionAdapter,
} from './generic-cli-execution-adapter';
import { TaskModule } from './task-module';
import type { ClaudeForkRepair } from './claude-session-lifecycle';
import { TaskOutputLog } from './task-output-log';

const MAX_OUTPUT_CHARS = 4 * 1024;

interface InFlightStart {
  readonly idempotencyKey: string;
  readonly promise: Promise<TaskExecutionView>;
}

interface InFlightClaudeStart extends InFlightStart {
  readonly fingerprint: string;
}

type TerminalTransition =
  | { readonly kind: 'start-failure' }
  | { readonly kind: 'process-exit'; readonly exitCode: number };

export class TaskExecutionError extends Error {
  constructor(readonly code: 'worktree-unavailable' | 'process-start-failed' | 'internal') {
    super(`Task execution failed: ${code}`);
    this.name = 'TaskExecutionError';
  }
}

/** Runtime-owned execution module: adapter lifecycle, transient output, and durable transitions. */
export class TaskExecutionModule {
  private readonly starts = new Map<string, InFlightStart>();
  private readonly claudeStarts = new Map<string, InFlightClaudeStart>();
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly exitWaits = new Map<string, ExitWait>();
  private readonly active = new Map<string, GenericCliExecution>();
  private readonly subscribers = new Map<string, Set<(event: TaskOutputEvent) => void>>();
  private readonly outputSequences = new Map<string, number>();
  private readonly outputPoisoned = new Set<string>();
  private readonly outputLog: TaskOutputLog;

  constructor(
    private readonly tasks: TaskModule,
    private readonly adapter: GenericCliExecutionAdapter,
    private readonly randomId: () => string,
  ) {
    this.outputLog = new TaskOutputLog(tasks.runtimeDirectory);
  }

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
  resumeClaude(request: ResumeClaudeSessionRequest): Promise<TaskExecutionView> {
    return this.runClaudeStart(request.taskId, request.idempotencyKey, resumeStartFingerprint(request),
      () => this.resumeClaudeOwned(request));
  }
  private async resumeClaudeOwned(request: ResumeClaudeSessionRequest): Promise<TaskExecutionView> {
    const execution = await this.tasks.resumeClaude(request);
    const active = this.active.get(request.taskId);
    if (active?.isRunning()) return execution;
    active?.dispose();
    this.active.delete(request.taskId);
    return this.startResumedClaude(request.taskId, execution);
  }
  forkClaude(request: ForkClaudeSessionRequest): Promise<TaskExecutionView> {
    return this.runClaudeStart(request.taskId, request.idempotencyKey, forkStartFingerprint(request),
      () => this.forkClaudeOwned(request));
  }
  private async forkClaudeOwned(request: ForkClaudeSessionRequest): Promise<TaskExecutionView> {
    const reservation = await this.tasks.reserveClaudeFork(request);
    return reservation.created ? this.startForkReserved(request.taskId, reservation) : reservation.execution;
  }

  private runClaudeStart(
    taskId: string,
    idempotencyKey: string,
    fingerprint: string,
    operation: () => Promise<TaskExecutionView>,
  ): Promise<TaskExecutionView> {
    const inFlight = this.claudeStarts.get(taskId);
    if (inFlight) {
      if (inFlight.idempotencyKey === idempotencyKey && inFlight.fingerprint === fingerprint) {
        return inFlight.promise;
      }
      return inFlight.promise.then(
        () => this.runClaudeStart(taskId, idempotencyKey, fingerprint, operation),
        () => this.runClaudeStart(taskId, idempotencyKey, fingerprint, operation),
      );
    }
    const promise = operation();
    const owned = { idempotencyKey, fingerprint, promise };
    this.claudeStarts.set(taskId, owned);
    void promise.then(() => this.releaseClaudeStart(taskId, owned),
      () => this.releaseClaudeStart(taskId, owned));
    return promise;
  }

  private releaseClaudeStart(taskId: string, owned: InFlightClaudeStart): void {
    if (this.claudeStarts.get(taskId) === owned) this.claudeStarts.delete(taskId);
  }

  private async startOwned(request: StartTaskRequest): Promise<TaskExecutionView> {
    const reservation = await this.tasks.reserveExecution(request);
    return reservation.created
      ? this.startReserved(request, reservation.execution, reservation.claudeForkRepair)
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
    forkRepair?: ClaudeForkRepair,
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
          worktreeId: forkRepair?.parentContext.worktreeId ?? this.randomId(),
          processId: this.randomId(),
          ptyId: this.randomId(),
        },
        instruction: forkRepair
          ? { kind: 'fork-claude', parentNativeSessionId: forkRepair.parentSession.nativeSessionId,
              context: forkRepair.parentContext }
          : { kind: 'new', nativeSessionId: execution.task.provider === 'claude' ? randomUUID() : null },
        onOutput: (data) => this.publishOutput(request.taskId, execution.attempt!.id, data),
        onExit: (exitCode) => void this.settle(request.taskId, execution.attempt!.id, exitCode),
      });
      this.active.set(request.taskId, active);
      this.exitWaits.set(request.taskId, new ExitWait());
      await this.attachContext(
        request.taskId,
        execution,
        active,
        forkRepair?.parentSession.id ??
          (execution.attempt.number > 1 ? execution.providerSessions.at(-1)?.id ?? null : null),
        forkRepair !== undefined || execution.attempt.number > 1,
      );
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

  private async startForkReserved(
    taskId: string,
    reservation: import('./task-module').ClaudeForkReservation,
  ): Promise<TaskExecutionView> {
    const execution = reservation.execution;
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    let active: GenericCliExecution | null = null;
    try {
      active = await this.adapter.start({
        task: execution.task,
        run: execution.run,
        attempt: execution.attempt,
        identities: { contextId: this.randomId(), worktreeId: reservation.parentContext.worktreeId, processId: this.randomId(), ptyId: this.randomId() },
        instruction: {
          kind: 'fork-claude',
          parentNativeSessionId: reservation.parentSession.nativeSessionId,
          context: reservation.parentContext,
        },
        onOutput: (data) => this.publishOutput(taskId, execution.attempt!.id, data),
        onExit: (exitCode) => void this.settle(taskId, execution.attempt!.id, exitCode),
      });
      this.active.set(taskId, active);
      this.exitWaits.set(taskId, new ExitWait());
      await this.attachContext(taskId, execution, active, reservation.parentSession.id, true);
      const started = await this.tasks.markStarted(taskId);
      active.activateExit(); active.activateOutput();
      return started;
    } catch (error) { return this.failStart(taskId, active, error); }
  }

  private async startResumedClaude(
    taskId: string,
    execution: TaskExecutionView,
  ): Promise<TaskExecutionView> {
    if (!execution.run || !execution.attempt || !execution.context || !execution.providerSession) {
      throw new TaskExecutionError('internal');
    }
    let active: GenericCliExecution | null = null;
    try {
      active = await this.adapter.start({
        task: execution.task, run: execution.run, attempt: execution.attempt,
        identities: {
          contextId: execution.context.id,
          worktreeId: execution.context.worktreeId,
          processId: execution.context.processId,
          ptyId: execution.context.ptyId,
        },
        instruction: { kind: 'resume-claude', nativeSessionId: execution.providerSession.nativeSessionId, context: execution.context },
        onOutput: (data) => this.publishOutput(taskId, execution.attempt!.id, data),
        onExit: (exitCode) => void this.settle(taskId, execution.attempt!.id, exitCode),
      });
      assertResumedExecution(execution, active);
      this.active.set(taskId, active);
      this.exitWaits.set(taskId, new ExitWait());
      active.activateExit();
      active.activateOutput();
      return execution;
    } catch (error) {
      return this.failStart(taskId, active, error);
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
      await this.persistTerminalWithRepair(taskId, { kind: 'start-failure' });
    } finally {
      this.resolveExitWait(taskId);
    }
    if (error instanceof GenericCliExecutionError) throw new TaskExecutionError(error.code);
    throw new TaskExecutionError('internal');
  }

  private async attachContext(
    taskId: string,
    execution: TaskExecutionView,
    active: GenericCliExecution,
    parentId: string | null,
    repair: boolean,
  ): Promise<void> {
    if (!execution.attempt) throw new TaskExecutionError('internal');
    const providerSession = active.providerSession && execution.task.provider === 'claude'
      ? { id: this.randomId(), provider: 'claude' as const,
          nativeSessionId: active.providerSession.nativeSessionId, taskId,
          attemptId: execution.attempt.id, executionContextId: active.context.id,
          capabilities: active.providerSession.capabilities, parentId }
      : null;
    if (!repair) {
      await this.tasks.allocateContext(taskId, active.context, providerSession);
      return;
    }
    await this.persistWithOneShotRepair(
      taskId,
      (view) => view.context?.id === active.context.id &&
        (providerSession === null || view.providerSession?.id === providerSession.id),
      () => this.tasks.allocateContext(taskId, active.context, providerSession),
    );
  }

  private async allocateFailedContext(
    taskId: string,
    context: GenericCliExecution['context'],
  ): Promise<void> {
    await this.persistWithOneShotRepair(
      taskId,
      (view) => view.context !== null,
      () => this.tasks.allocateContext(taskId, context, null),
    );
  }

  private settle(taskId: string, attemptId: string, exitCode: number): void {
    if (this.tasks.execution(taskId).attempt?.id !== attemptId) return;
    if (this.settlements.has(taskId)) return;
    const settlement = this.persistTerminalWithRepair(taskId, { kind: 'process-exit', exitCode })
      .then(() => this.release(taskId))
      .catch((error: unknown) => {
        this.rejectExitWait(taskId, error);
        this.release(taskId);
        throw error;
      });
    this.settlements.set(taskId, settlement);
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
      (view) => isTerminal(view.attempt?.state),
      () => this.persistTerminal(taskId, transition),
    );
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

  private async persistTerminal(taskId: string, transition: TerminalTransition): Promise<void> {
    const view = this.tasks.execution(taskId);
    if (!view.attempt || isTerminal(view.attempt.state)) return;
    if (view.attempt.state === 'cancelling') await this.tasks.cancel(taskId);
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

function assertResumedExecution(execution: TaskExecutionView, active: GenericCliExecution): void {
  if (!execution.context || !execution.providerSession ||
    JSON.stringify(active.context) !== JSON.stringify(execution.context) ||
    active.providerSession?.nativeSessionId !== execution.providerSession.nativeSessionId) {
    throw new GenericCliExecutionError('process-start-failed', active.context);
  }
}

function resumeStartFingerprint(request: ResumeClaudeSessionRequest): string {
  return JSON.stringify(['resume', request.taskId, request.providerSessionId, request.repository,
    request.worktreeId, request.branchName]);
}

function forkStartFingerprint(request: ForkClaudeSessionRequest): string {
  return JSON.stringify(['fork', request.taskId, request.providerSessionId]);
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

function isTerminal(state: TaskExecutionState | undefined): boolean {
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

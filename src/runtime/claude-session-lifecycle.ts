import type {
  ForkClaudeSessionRequest,
  ResumeClaudeSessionRequest,
  TaskAttemptView,
  TaskExecutionView,
} from '../shared/runtime/runtime-interface';

export type ClaudeResumeRejectionReason = 'unsupported' | 'scope-mismatch' | 'not-current';

export interface ClaudeResumeRejectedEvent {
  readonly type: 'ClaudeResumeRejected';
  readonly version: 1;
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly reason: ClaudeResumeRejectionReason;
}

export interface ClaudeForkRequestedEvent {
  readonly type: 'ClaudeForkRequested';
  readonly version: 1;
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export interface AttemptForkedEvent {
  readonly type: 'AttemptForked';
  readonly version: 1;
  readonly taskId: string;
  readonly attempt: TaskAttemptView;
  readonly parentAttemptId: string;
  readonly parentSessionId: string;
  readonly forkKey: string;
}

export type ClaudeLifecycleEvent =
  | ClaudeResumeRejectedEvent
  | ClaudeForkRequestedEvent
  | AttemptForkedEvent;

type ClaudeFailureCode =
  | 'idempotency-conflict'
  | 'not-found'
  | 'task-not-ready'
  | 'unsupported-operation'
  | 'internal';

export class ClaudeSessionLifecycleError extends Error {
  constructor(readonly code: ClaudeFailureCode) {
    super(`Claude session lifecycle failed: ${code}`);
    this.name = 'ClaudeSessionLifecycleError';
  }
}

export interface ClaudeForkReservation {
  readonly execution: TaskExecutionView;
  readonly created: boolean;
  readonly parentContext: NonNullable<TaskExecutionView['context']>;
  readonly parentSession: NonNullable<TaskExecutionView['providerSession']>;
}

export type ClaudeForkRepair = Pick<ClaudeForkReservation, 'parentContext' | 'parentSession'>;

export interface ClaudeSessionLifecyclePort {
  view(taskId: string): TaskExecutionView | null;
  append(event: ClaudeLifecycleEvent): Promise<void>;
  randomId(): string;
}

interface ForkRecord {
  readonly fingerprint: string;
  readonly taskId: string;
  readonly parentContext: NonNullable<TaskExecutionView['context']>;
  readonly parentSession: NonNullable<TaskExecutionView['providerSession']>;
  readonly childAttemptId: string | null;
}

/** Owns Claude validation, durable decisions, idempotency, and fork linkage. */
export class ClaudeSessionLifecycle {
  private readonly resumeDecisions = new Map<string, {
    readonly fingerprint: string;
    readonly reason: ClaudeResumeRejectionReason | null;
  }>();
  private readonly forks = new Map<string, ForkRecord>();
  private readonly forksByChildAttempt = new Map<string, ForkRecord>();

  constructor(private readonly port: ClaudeSessionLifecyclePort) {}

  async resume(request: ResumeClaudeSessionRequest): Promise<TaskExecutionView> {
    const fingerprint = resumeFingerprint(request);
    const prior = this.resumeDecisions.get(request.idempotencyKey);
    if (prior) return this.replayResume(prior, fingerprint, request.taskId);
    const execution = this.requiredView(request.taskId);
    const reason = resumeRejection(execution, request);
    if (!reason) {
      this.resumeDecisions.set(request.idempotencyKey, { fingerprint, reason: null });
      return execution;
    }
    await this.port.append({
      type: 'ClaudeResumeRejected', version: 1, taskId: request.taskId,
      providerSessionId: request.providerSessionId, idempotencyKey: request.idempotencyKey,
      fingerprint, reason,
    });
    throw new ClaudeSessionLifecycleError(publicCode(reason));
  }

  async fork(request: ForkClaudeSessionRequest): Promise<ClaudeForkReservation> {
    const fingerprint = forkFingerprint(request);
    const prior = this.forks.get(request.idempotencyKey);
    if (prior) return this.replayFork(request, fingerprint, prior);
    const execution = this.requiredView(request.taskId);
    validateFork(execution, request.providerSessionId);
    requiredContext(execution);
    requiredSession(execution);
    await this.port.append({
      type: 'ClaudeForkRequested', version: 1, taskId: request.taskId,
      providerSessionId: request.providerSessionId, idempotencyKey: request.idempotencyKey,
      fingerprint,
    });
    return this.appendForkAttempt(request.idempotencyKey);
  }

  replay(event: ClaudeLifecycleEvent): void {
    if (event.type === 'ClaudeResumeRejected') {
      this.applyResumeRejected(event);
    } else if (event.type === 'ClaudeForkRequested') {
      this.applyForkRequested(event);
    } else {
      this.applyAttemptForked(event);
    }
  }

  repairFork(attemptId: string): ClaudeForkRepair {
    const record = this.forksByChildAttempt.get(attemptId);
    if (!record) throw new ClaudeSessionLifecycleError('internal');
    return { parentContext: record.parentContext, parentSession: record.parentSession };
  }

  private replayResume(
    prior: { readonly fingerprint: string; readonly reason: ClaudeResumeRejectionReason | null },
    fingerprint: string,
    taskId: string,
  ): TaskExecutionView {
    if (prior.fingerprint !== fingerprint) throw new ClaudeSessionLifecycleError('idempotency-conflict');
    if (prior.reason) throw new ClaudeSessionLifecycleError(publicCode(prior.reason));
    return this.requiredView(taskId);
  }

  private async replayFork(
    request: ForkClaudeSessionRequest,
    fingerprint: string,
    prior: ForkRecord,
  ): Promise<ClaudeForkReservation> {
    if (prior.fingerprint !== fingerprint) throw new ClaudeSessionLifecycleError('idempotency-conflict');
    if (!prior.childAttemptId) return this.appendForkAttempt(request.idempotencyKey);
    const execution = this.requiredView(prior.taskId);
    if (execution.attempt?.id !== prior.childAttemptId) throw new ClaudeSessionLifecycleError('task-not-ready');
    const attached = execution.context !== null && execution.providerSession !== null;
    return { execution, created: !attached, parentContext: prior.parentContext, parentSession: prior.parentSession };
  }

  private async appendForkAttempt(forkKey: string): Promise<ClaudeForkReservation> {
    const record = this.forks.get(forkKey);
    if (!record) throw new ClaudeSessionLifecycleError('internal');
    const execution = this.requiredView(record.taskId);
    const parentAttempt = execution.attempt;
    if (!parentAttempt) throw new ClaudeSessionLifecycleError('task-not-ready');
    const attempt = { id: this.port.randomId(), number: parentAttempt.number + 1, state: 'starting' as const };
    await this.port.append({
      type: 'AttemptForked', version: 1, taskId: record.taskId, attempt,
      parentAttemptId: parentAttempt.id, parentSessionId: record.parentSession.id, forkKey,
    });
    return { execution: this.requiredView(record.taskId), created: true,
      parentContext: record.parentContext, parentSession: record.parentSession };
  }

  private applyResumeRejected(event: ClaudeResumeRejectedEvent): void {
    const prior = this.resumeDecisions.get(event.idempotencyKey);
    if (prior && (prior.fingerprint !== event.fingerprint || prior.reason !== event.reason)) {
      throw new ClaudeSessionLifecycleError('internal');
    }
    this.resumeDecisions.set(event.idempotencyKey, { fingerprint: event.fingerprint, reason: event.reason });
  }

  private applyForkRequested(event: ClaudeForkRequestedEvent): void {
    const prior = this.forks.get(event.idempotencyKey);
    if (prior && (prior.fingerprint !== event.fingerprint || prior.taskId !== event.taskId)) {
      throw new ClaudeSessionLifecycleError('internal');
    }
    if (prior) return;
    const execution = this.requiredView(event.taskId);
    this.forks.set(event.idempotencyKey, {
      fingerprint: event.fingerprint,
      taskId: event.taskId,
      parentContext: requiredContext(execution),
      parentSession: requiredSession(execution),
      childAttemptId: null,
    });
  }

  private applyAttemptForked(event: AttemptForkedEvent): void {
    const record = this.forks.get(event.forkKey);
    if (!record || record.childAttemptId || record.taskId !== event.taskId ||
      record.parentSession.id !== event.parentSessionId) {
      throw new ClaudeSessionLifecycleError('internal');
    }
    const linked = { ...record, childAttemptId: event.attempt.id };
    this.forks.set(event.forkKey, linked);
    this.forksByChildAttempt.set(event.attempt.id, linked);
  }

  private requiredView(taskId: string): TaskExecutionView {
    const execution = this.port.view(taskId);
    if (!execution) throw new ClaudeSessionLifecycleError('not-found');
    return execution;
  }
}

function resumeRejection(
  execution: TaskExecutionView,
  request: ResumeClaudeSessionRequest,
): ClaudeResumeRejectionReason | null {
  const session = execution.providerSessions.find((candidate) => candidate.id === request.providerSessionId);
  const scopeMatches = execution.task.provider === 'claude' && session?.taskId === request.taskId &&
    execution.task.repository === request.repository && execution.context?.worktreeId === request.worktreeId &&
    execution.context.branchName === request.branchName;
  if (!scopeMatches) return 'scope-mismatch';
  if (execution.providerSession?.id !== session.id || isTerminal(execution.attempt?.state)) return 'not-current';
  return session.capabilities.resume ? null : 'unsupported';
}

function validateFork(execution: TaskExecutionView, providerSessionId: string): void {
  const session = execution.providerSessions.find((candidate) => candidate.id === providerSessionId);
  if (!session || execution.task.provider !== 'claude') throw new ClaudeSessionLifecycleError('not-found');
  if (execution.providerSession?.id !== session.id || isTerminal(execution.attempt?.state)) {
    throw new ClaudeSessionLifecycleError('task-not-ready');
  }
  if (!session.capabilities.fork) throw new ClaudeSessionLifecycleError('unsupported-operation');
}

function requiredContext(execution: TaskExecutionView): NonNullable<TaskExecutionView['context']> {
  if (!execution.context) throw new ClaudeSessionLifecycleError('task-not-ready');
  return { ...execution.context };
}

function requiredSession(execution: TaskExecutionView): NonNullable<TaskExecutionView['providerSession']> {
  if (!execution.providerSession) throw new ClaudeSessionLifecycleError('task-not-ready');
  return { ...execution.providerSession, capabilities: { ...execution.providerSession.capabilities } };
}

function publicCode(reason: ClaudeResumeRejectionReason): ClaudeFailureCode {
  if (reason === 'unsupported') return 'unsupported-operation';
  if (reason === 'not-current') return 'task-not-ready';
  return 'not-found';
}

function resumeFingerprint(request: ResumeClaudeSessionRequest): string {
  return JSON.stringify([request.taskId, request.providerSessionId, request.repository, request.worktreeId, request.branchName]);
}

function forkFingerprint(request: ForkClaudeSessionRequest): string {
  return JSON.stringify([request.taskId, request.providerSessionId]);
}

function isTerminal(state: TaskExecutionView['task']['executionState'] | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

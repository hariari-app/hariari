import type { TaskAttemptView } from '../shared/runtime/runtime-interface';
import type { PrivateTaskExecutionView } from './task-execution-projection';
import type { StoredContext } from './task-events';
import type { ProviderSessionActionDecidedEvent } from './provider-session-lifecycle';

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
  readonly plannedContext?: StoredContext;
}

export type ClaudeLifecycleEvent =
  | ClaudeResumeRejectedEvent
  | ClaudeForkRequestedEvent
  | AttemptForkedEvent;

export class ClaudeSessionLifecycleError extends Error {
  constructor() {
    super('Invalid legacy Claude session lifecycle');
    this.name = 'ClaudeSessionLifecycleError';
  }
}

export interface ClaudeForkRepair {
  readonly parentContext: NonNullable<PrivateTaskExecutionView['context']>;
  readonly parentSession: NonNullable<PrivateTaskExecutionView['providerSession']>;
}

interface LegacyForkRecord extends ClaudeForkRepair {
  readonly taskId: string;
  readonly fingerprint: string;
  readonly childAttemptId: string | null;
}

/** Read-only compatibility codec for replaying pre-provider-neutral Claude events. */
export class ClaudeSessionLifecycle {
  private readonly rejections = new Map<string, ClaudeResumeRejectedEvent>();
  private readonly forks = new Map<string, LegacyForkRecord>();
  private readonly forksByChildAttempt = new Map<string, LegacyForkRecord>();

  constructor(private readonly view: (taskId: string) => PrivateTaskExecutionView | null) {}

  replay(event: ClaudeLifecycleEvent): void {
    if (event.type === 'ClaudeResumeRejected') this.replayRejection(event);
    else if (event.type === 'ClaudeForkRequested') this.replayForkRequest(event);
    else this.replayForked(event);
  }

  repairFork(attemptId: string): ClaudeForkRepair {
    const record = this.forksByChildAttempt.get(attemptId);
    if (!record) throw new ClaudeSessionLifecycleError();
    return { parentContext: record.parentContext, parentSession: record.parentSession };
  }

  private replayRejection(event: ClaudeResumeRejectedEvent): void {
    const prior = this.rejections.get(event.idempotencyKey);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new ClaudeSessionLifecycleError();
    }
    this.rejections.set(event.idempotencyKey, event);
  }

  private replayForkRequest(event: ClaudeForkRequestedEvent): void {
    const prior = this.forks.get(event.idempotencyKey);
    if (prior) {
      if (prior.taskId !== event.taskId || prior.fingerprint !== event.fingerprint) {
        throw new ClaudeSessionLifecycleError();
      }
      return;
    }
    const execution = this.view(event.taskId);
    if (!execution?.context || !execution.providerSession) throw new ClaudeSessionLifecycleError();
    this.forks.set(event.idempotencyKey, {
      taskId: event.taskId,
      fingerprint: event.fingerprint,
      parentContext: execution.context,
      parentSession: execution.providerSession,
      childAttemptId: null,
    });
  }

  private replayForked(event: AttemptForkedEvent): void {
    const record = this.forks.get(event.forkKey);
    if (!record || record.childAttemptId || record.taskId !== event.taskId ||
      record.parentSession.id !== event.parentSessionId) throw new ClaudeSessionLifecycleError();
    const linked = { ...record, childAttemptId: event.attempt.id };
    this.forks.set(event.forkKey, linked);
    this.forksByChildAttempt.set(event.attempt.id, linked);
  }
}

export function providerDecisionForLegacy(
  event: ClaudeResumeRejectedEvent | ClaudeForkRequestedEvent,
): ProviderSessionActionDecidedEvent {
  const action = event.type === 'ClaudeResumeRejected' ? 'resume' : 'fork';
  const reason = event.type === 'ClaudeResumeRejected'
    ? legacyRejection(event.reason) : null;
  return {
    type: 'ProviderSessionActionDecided', version: 1, taskId: event.taskId,
    action, providerSessionId: event.providerSessionId,
    idempotencyKey: event.idempotencyKey,
    fingerprint: JSON.stringify([action, event.taskId, event.providerSessionId]),
    outcome: reason ? 'rejected' : 'accepted',
    decision: reason ? null : 'fork', reason,
  };
}

function legacyRejection(
  reason: ClaudeResumeRejectionReason,
): 'not-found' | 'task-not-ready' | 'unsupported-operation' {
  if (reason === 'scope-mismatch') return 'not-found';
  if (reason === 'not-current') return 'task-not-ready';
  return 'unsupported-operation';
}

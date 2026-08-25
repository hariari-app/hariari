import type { EventTimelineOperationIdentity } from '../shared/runtime/event-timeline-contract';
import type { ProviderSessionActionDecidedEvent } from './provider-session-lifecycle';
import type {
  AttemptForkedEvent,
  AttemptResumedEvent,
  StoredProviderSession,
} from './task-events';

export interface AcceptedProviderActionIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly kind: 'native-resume' | 'fork';
  readonly actionKey: string;
  readonly correlationId: string;
  readonly sourceAttemptId: string;
  readonly sourceSessionId: string;
}

/** Derives child-operation authority only from an accepted durable provider decision. */
export function acceptedProviderActionIdentity(
  event: ProviderSessionActionDecidedEvent,
  source: StoredProviderSession | null,
  runId: string,
): AcceptedProviderActionIdentity | null {
  if (event.outcome !== 'accepted' || event.decision === 'exact-reattach') return null;
  const validPair = (event.action === 'resume' && event.decision === 'native-resume') ||
    (event.action === 'fork' && event.decision === 'fork');
  if (!validPair || !source || source.id !== event.providerSessionId ||
    source.taskId !== event.taskId) throw new Error('invalid accepted provider action identity');
  return {
    taskId: event.taskId, runId, kind: event.decision,
    actionKey: event.idempotencyKey, correlationId: event.correlationId,
    sourceAttemptId: source.attemptId, sourceSessionId: source.id,
  };
}

/** Validates a child core record and returns its authoritative timeline operation. */
export function providerChildOperation(
  accepted: AcceptedProviderActionIdentity | null,
  event: AttemptResumedEvent | AttemptForkedEvent,
): EventTimelineOperationIdentity {
  if (!accepted || accepted.taskId !== event.taskId ||
    accepted.kind !== (event.type === 'AttemptResumed' ? 'native-resume' : 'fork')) {
    throw new Error('provider child has no accepted action identity');
  }
  const key = event.type === 'AttemptResumed' ? event.actionKey : event.forkKey;
  const sourceAttemptId = event.type === 'AttemptResumed'
    ? event.sourceAttemptId : event.parentAttemptId;
  const sourceSessionId = event.type === 'AttemptResumed'
    ? event.sourceSessionId : event.parentSessionId;
  if (key !== accepted.actionKey || event.correlationId !== accepted.correlationId ||
    sourceAttemptId !== accepted.sourceAttemptId || sourceSessionId !== accepted.sourceSessionId) {
    throw new Error('provider child replaced accepted action identity');
  }
  return { taskId: accepted.taskId, runId: accepted.runId, attemptId: event.attempt.id,
    idempotencyKey: accepted.actionKey, correlationId: accepted.correlationId };
}

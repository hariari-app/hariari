import type {
  ProviderSessionActionRequest,
  RuntimeOperationFailureCode,
} from '../shared/runtime/runtime-interface';
import type { PrivateTaskExecutionView } from './task-execution-projection';

export type ProviderSessionAction = 'resume' | 'fork';
export type ProviderActionDecision = 'exact-reattach' | 'native-resume' | 'fork';
export type ProviderActionRejection = Extract<
  RuntimeOperationFailureCode,
  'not-found' | 'task-not-ready' | 'unsupported-operation'
>;

export interface ProviderSessionOperationRequest extends ProviderSessionActionRequest {
  readonly correlationId: string;
}

export interface ProviderSessionActionDecidedEvent {
  readonly type: 'ProviderSessionActionDecided';
  readonly version: 1;
  readonly taskId: string;
  readonly action: ProviderSessionAction;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly fingerprint: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly decision: ProviderActionDecision | null;
  readonly reason: ProviderActionRejection | null;
}

export interface ProviderSessionActionAbortedEvent {
  readonly type: 'ProviderSessionActionAborted';
  readonly version: 1;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly reason: 'parent-still-live';
}

type ActionFailureCode = ProviderActionRejection | 'idempotency-conflict' | 'internal';

export class ProviderSessionLifecycleError extends Error {
  constructor(readonly code: ActionFailureCode) {
    super(`Provider session lifecycle failed: ${code}`);
    this.name = 'ProviderSessionLifecycleError';
  }
}

export interface ProviderActionSource {
  readonly execution: PrivateTaskExecutionView;
  readonly context: NonNullable<PrivateTaskExecutionView['context']>;
  readonly session: NonNullable<PrivateTaskExecutionView['providerSession']>;
}

export interface PreparedProviderAction extends ProviderActionSource {
  readonly request: ProviderSessionOperationRequest;
  readonly action: ProviderSessionAction;
  readonly fingerprint: string;
  readonly prior: ProviderSessionActionDecidedEvent | null;
}

export interface ProviderSessionLifecyclePort {
  view(taskId: string): PrivateTaskExecutionView | null;
  append(event: ProviderSessionActionDecidedEvent | ProviderSessionActionAbortedEvent): Promise<void>;
}

/** Owns provider-neutral action validation, durable decisions, and idempotent replay. */
export class ProviderSessionLifecycle {
  private readonly decisions = new Map<string, ProviderSessionActionDecidedEvent>();
  private readonly aborted = new Set<string>();

  constructor(private readonly port: ProviderSessionLifecyclePort) {}

  async prepare(
    request: ProviderSessionOperationRequest,
    action: ProviderSessionAction,
  ): Promise<PreparedProviderAction> {
    const fingerprint = actionFingerprint(request, action);
    const prior = this.decisions.get(request.idempotencyKey) ?? null;
    if (this.aborted.has(request.idempotencyKey)) {
      if (!prior || prior.action !== action || prior.fingerprint !== fingerprint) {
        throw new ProviderSessionLifecycleError('idempotency-conflict');
      }
      throw new ProviderSessionLifecycleError('internal');
    }
    if (prior) return this.replayPrior(request, action, fingerprint, prior);
    const source = sourceFor(this.port.view(request.taskId), request, action);
    if ('reason' in source) {
      await this.decide(request, action, fingerprint, 'rejected', null, source.reason);
      throw new ProviderSessionLifecycleError(source.reason);
    }
    return { request, action, fingerprint, prior: null, ...source };
  }

  async accept(
    prepared: PreparedProviderAction,
    decision: ProviderActionDecision,
  ): Promise<void> {
    if (prepared.prior) return;
    await this.decide(
      prepared.request, prepared.action, prepared.fingerprint,
      'accepted', decision, null,
    );
  }

  async reject(
    prepared: PreparedProviderAction,
    reason: ProviderActionRejection,
  ): Promise<never> {
    if (!prepared.prior) {
      await this.decide(
        prepared.request, prepared.action, prepared.fingerprint,
        'rejected', null, reason,
      );
    }
    throw new ProviderSessionLifecycleError(reason);
  }

  async rejectWithFingerprint(
    request: ProviderSessionOperationRequest,
    action: ProviderSessionAction,
    fingerprint: string,
    reason: ProviderActionRejection,
  ): Promise<never> {
    const prior = this.decisions.get(request.idempotencyKey);
    if (prior) {
      if (prior.action !== action || prior.fingerprint !== fingerprint) {
        throw new ProviderSessionLifecycleError('idempotency-conflict');
      }
      throw new ProviderSessionLifecycleError(prior.reason ?? 'internal');
    }
    await this.decide(request, action, fingerprint, 'rejected', null, reason);
    throw new ProviderSessionLifecycleError(reason);
  }

  replay(event: ProviderSessionActionDecidedEvent): void {
    const prior = this.decisions.get(event.idempotencyKey);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      throw new ProviderSessionLifecycleError('internal');
    }
    this.decisions.set(event.idempotencyKey, event);
  }

  async abort(prepared: PreparedProviderAction): Promise<void> {
    await this.port.append({
      type: 'ProviderSessionActionAborted', version: 1,
      taskId: prepared.request.taskId,
      idempotencyKey: prepared.request.idempotencyKey,
      reason: 'parent-still-live',
    });
  }

  replayAbort(event: ProviderSessionActionAbortedEvent): void {
    if (this.aborted.has(event.idempotencyKey)) return;
    const decision = this.decisions.get(event.idempotencyKey);
    if (!decision || decision.taskId !== event.taskId || decision.outcome !== 'accepted' ||
      decision.action !== 'fork' || decision.decision !== 'fork') {
      throw new ProviderSessionLifecycleError('internal');
    }
    this.aborted.add(event.idempotencyKey);
  }

  private replayPrior(
    request: ProviderSessionOperationRequest,
    action: ProviderSessionAction,
    fingerprint: string,
    prior: ProviderSessionActionDecidedEvent,
  ): PreparedProviderAction {
    if (prior.fingerprint !== fingerprint || prior.action !== action) {
      throw new ProviderSessionLifecycleError('idempotency-conflict');
    }
    if (prior.outcome === 'rejected') {
      throw new ProviderSessionLifecycleError(prior.reason ?? 'internal');
    }
    const source = sourceForHistory(this.port.view(request.taskId), request.providerSessionId);
    return {
      request: { ...request, correlationId: prior.correlationId },
      action,
      fingerprint,
      prior,
      ...source,
    };
  }

  private async decide(
    request: ProviderSessionOperationRequest,
    action: ProviderSessionAction,
    fingerprint: string,
    outcome: 'accepted' | 'rejected',
    decision: ProviderActionDecision | null,
    reason: ProviderActionRejection | null,
  ): Promise<void> {
    await this.port.append({
      type: 'ProviderSessionActionDecided', version: 1, taskId: request.taskId,
      action, providerSessionId: request.providerSessionId,
      idempotencyKey: request.idempotencyKey,
      correlationId: request.correlationId,
      fingerprint,
      outcome, decision, reason,
    });
  }
}

function sourceFor(
  execution: PrivateTaskExecutionView | null,
  request: ProviderSessionOperationRequest,
  action: ProviderSessionAction,
): ProviderActionSource | { readonly reason: ProviderActionRejection } {
  if (!execution) return { reason: 'not-found' };
  const session = execution.providerSessions.find((candidate) =>
    candidate.id === request.providerSessionId);
  if (!session || session.taskId !== request.taskId) return { reason: 'not-found' };
  if (execution.providerSession?.id !== session.id || !execution.attempt ||
    execution.attempt.id !== session.attemptId || execution.attempt.state !== 'running') {
    return { reason: 'task-not-ready' };
  }
  const capability = action === 'resume' ? session.capabilities.resume : session.capabilities.fork;
  if (!capability) return { reason: 'unsupported-operation' };
  if (!execution.context || execution.context.id !== session.executionContextId) {
    return { reason: 'task-not-ready' };
  }
  return { execution, context: execution.context, session };
}

function sourceForHistory(
  execution: PrivateTaskExecutionView | null,
  providerSessionId: string,
): ProviderActionSource {
  if (!execution) throw new ProviderSessionLifecycleError('internal');
  const session = execution.providerSessions.find((candidate) => candidate.id === providerSessionId);
  const context = session && execution.executionContexts.find((candidate) =>
    candidate.id === session.executionContextId);
  if (!session || !context) throw new ProviderSessionLifecycleError('internal');
  return { execution, context, session };
}

function actionFingerprint(
  request: ProviderSessionOperationRequest,
  action: ProviderSessionAction,
): string {
  return JSON.stringify([action, request.taskId, request.providerSessionId]);
}

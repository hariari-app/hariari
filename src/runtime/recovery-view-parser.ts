import {
  RECOVERY_ATTENTION_REASON,
  RUNTIME_IDENTIFIER_MAX_LENGTH,
  isRecoveryClassification,
  isRecoveryDecision,
  isRecoveryResourceKind,
  recoveryNeedsAttention,
  type TaskExecutionState,
  type TaskRecoveryDecisionView,
  type TaskRecoveryView,
} from '../shared/runtime/runtime-interface';

/** Owns recovery result invariants shared by durable replay and wire decoding. */
export function parseRecoveryView(value: unknown): TaskRecoveryView {
  const recovery = object(value);
  exactKeys(recovery, [
    'id', 'taskId', 'desiredState', 'status', 'decision', 'resources', 'attention',
  ]);
  const status = recovery.status;
  if (status !== 'ready' && status !== 'attention') invalid();
  const decision = recovery.decision;
  if (!isRecoveryDecision(decision)) invalid();
  const attention = recovery.attention === null ? null : parseAttention(recovery.attention);
  if ((status === 'attention') !== (attention !== null) ||
    recoveryNeedsAttention(decision) !== (attention !== null)) invalid();
  return {
    id: identifier(recovery.id),
    taskId: identifier(recovery.taskId),
    desiredState: executionState(recovery.desiredState),
    status,
    decision,
    resources: array(recovery.resources).map(parseResource),
    attention,
  };
}

/** Parses the smaller committed-decision projection with the same Attention invariant. */
export function parseRecoveryDecisionView(value: unknown): TaskRecoveryDecisionView {
  const result = object(value);
  exactKeys(result, [
    'id', 'taskId', 'recoveryId', 'decision', 'status', 'attention',
  ]);
  const status = result.status;
  if (status !== 'decided' && status !== 'attention') invalid();
  const decision = result.decision;
  if (!isRecoveryDecision(decision)) invalid();
  const attention = result.attention === null ? null : parseAttention(result.attention);
  if ((status === 'attention') !== (attention !== null) ||
    recoveryNeedsAttention(decision) !== (attention !== null)) invalid();
  return {
    id: identifier(result.id),
    taskId: identifier(result.taskId),
    recoveryId: identifier(result.recoveryId),
    decision,
    status,
    attention,
  };
}

function parseResource(value: unknown): TaskRecoveryView['resources'][number] {
  const resource = object(value);
  exactKeys(resource, ['kind', 'classification']);
  if (!isRecoveryResourceKind(resource.kind) ||
    !isRecoveryClassification(resource.classification)) invalid();
  return { kind: resource.kind, classification: resource.classification };
}

function parseAttention(value: unknown): NonNullable<TaskRecoveryView['attention']> {
  const attention = object(value);
  exactKeys(attention, ['id', 'reason']);
  if (attention.reason !== RECOVERY_ATTENTION_REASON) invalid();
  return { id: identifier(attention.id), reason: attention.reason };
}

function executionState(value: unknown): TaskExecutionState {
  if (value !== 'ready' && value !== 'starting' && value !== 'running' &&
    value !== 'completed' && value !== 'failed' && value !== 'cancelling' &&
    value !== 'cancelled' && value !== 'superseding' && value !== 'superseded') invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 ||
    value.length > RUNTIME_IDENTIFIER_MAX_LENGTH) invalid();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function invalid(): never {
  throw new Error('invalid recovery view');
}

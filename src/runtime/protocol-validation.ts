import {
  RUNTIME_IDENTIFIER_MAX_LENGTH,
  TASK_PROVIDERS,
  type CancelTaskRequest,
  type CreateTaskRequest,
  type RuntimeHealth,
  type RuntimeOperationFailureCode,
  type RuntimeProtocolRange,
  type RuntimeShutdownRequest,
  type StartTaskRequest,
  type ProviderSessionActionRequest,
  type ReconcileTaskRequest,
  type RecoverTaskRequest,
  type TaskExecutionState,
  type TaskExecutionView,
  type TaskOutputEvent,
  type TaskRecoveryView,
  type TaskRecoveryDecisionView,
} from '../shared/runtime/runtime-interface';
import {
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_HEALTH_OPERATION,
  RUNTIME_OPERATION_VERSION,
  RUNTIME_SHUTDOWN_OPERATION,
  TASK_CREATE_OPERATION,
  TASK_CANCEL_OPERATION,
  TASK_EXECUTION_OPERATION,
  TASK_LIST_OPERATION,
  TASK_OUTPUT_SUBSCRIBE_OPERATION,
  TASK_START_OPERATION,
  PROVIDER_SESSION_FORK_OPERATION,
  PROVIDER_SESSION_RESUME_OPERATION,
  TASK_RECONCILE_OPERATION,
  TASK_RECOVER_OPERATION,
  type RuntimeAuthenticateFrame,
  type RuntimeAuthenticatedReplyEnvelope,
  type RuntimeChallengeFrame,
  type RuntimeIncompatibleFrame,
  type RuntimeOperationFrame,
  type RuntimeRequestFrame,
  type RuntimeResponseFrame,
  type RuntimeOutputFrame,
  type RuntimeUnauthorizedFrame,
  type RuntimeWelcomeFrame,
} from './protocol';
import {
  parseRecoveryDecisionView,
  parseRecoveryView,
} from './recovery-view-parser';

const MAX_VERSION_LENGTH = 128;
const MAX_PROOF_LENGTH = 128;
const MAX_TASK_FIELD_LENGTH = 512;
const TASK_PROVIDER_SET = new Set<string>(TASK_PROVIDERS);

export class RuntimeProtocolValidationError extends Error {
  constructor() {
    super('Runtime protocol frame is invalid');
    this.name = 'RuntimeProtocolValidationError';
  }
}

export function parseChallengeFrame(value: unknown): RuntimeChallengeFrame {
  const frame = object(value);
  if (frame.kind !== 'runtime.challenge' || frame.handshakeVersion !== RUNTIME_HANDSHAKE_VERSION) {
    invalid();
  }
  return {
    kind: 'runtime.challenge',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: identifier(frame.challengeId),
    serverNonce: nonce(frame.serverNonce),
    expiresAt: timestamp(frame.expiresAt),
  };
}

export function parseAuthenticateFrame(value: unknown): RuntimeAuthenticateFrame {
  const frame = object(value);
  if (
    frame.kind !== 'runtime.authenticate' ||
    frame.handshakeVersion !== RUNTIME_HANDSHAKE_VERSION
  ) {
    invalid();
  }
  const client = object(frame.client);
  const name = client.name;
  if (name !== 'hariari-desktop' && name !== 'hariari-cli') invalid();
  return {
    kind: 'runtime.authenticate',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: identifier(frame.challengeId),
    requestId: identifier(frame.requestId),
    clientNonce: nonce(frame.clientNonce),
    client: { name, version: boundedString(client.version, MAX_VERSION_LENGTH) },
    protocolRange: protocolRange(frame.protocolRange),
    proof: boundedString(frame.proof, MAX_PROOF_LENGTH),
  };
}

export function parseHandshakeReply(
  value: unknown,
): RuntimeWelcomeFrame | RuntimeIncompatibleFrame | RuntimeUnauthorizedFrame {
  const frame = object(value);
  if (frame.handshakeVersion !== RUNTIME_HANDSHAKE_VERSION) invalid();
  if (frame.kind === 'runtime.unauthorized') {
    return { kind: 'runtime.unauthorized', handshakeVersion: RUNTIME_HANDSHAKE_VERSION };
  }
  const envelope = authenticatedReplyEnvelope(frame);
  if (frame.kind === 'runtime.incompatible') {
    return {
      kind: 'runtime.incompatible',
      ...envelope,
      runtimeVersion: boundedString(frame.runtimeVersion, MAX_VERSION_LENGTH),
      buildId: identifier(frame.buildId),
    };
  }
  if (frame.kind !== 'runtime.welcome') invalid();
  const runtime = object(frame.runtime);
  return {
    kind: 'runtime.welcome',
    ...envelope,
    sessionId: identifier(frame.sessionId),
    selectedProtocolVersion: positiveInteger(frame.selectedProtocolVersion),
    runtime: {
      instanceId: identifier(runtime.instanceId),
      runtimeVersion: boundedString(runtime.runtimeVersion, MAX_VERSION_LENGTH),
      buildId: identifier(runtime.buildId),
      startedAt: timestamp(runtime.startedAt),
    },
  };
}

function authenticatedReplyEnvelope(
  frame: Record<string, unknown>,
): RuntimeAuthenticatedReplyEnvelope {
  return {
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: identifier(frame.challengeId),
    requestId: identifier(frame.requestId),
    serverNonce: nonce(frame.serverNonce),
    clientNonce: nonce(frame.clientNonce),
    runtimeRange: protocolRange(frame.runtimeRange),
    proof: boundedString(frame.proof, MAX_PROOF_LENGTH),
  };
}

export function parseRequestFrame(value: unknown): RuntimeRequestFrame {
  const frame = object(value);
  if (frame.kind !== 'runtime.request') invalid();
  return {
    kind: 'runtime.request',
    protocolVersion: positiveInteger(frame.protocolVersion),
    requestId: identifier(frame.requestId),
    operation: operation(frame.operation),
    correlationId: identifier(frame.correlationId),
    causationId: optionalIdentifier(frame.causationId),
    idempotencyKey: optionalTaskIdempotencyKey(frame.idempotencyKey),
    payload: object(frame.payload),
  };
}

export function parseResponseFrame(value: unknown): RuntimeResponseFrame {
  const frame = object(value);
  if (frame.kind !== 'runtime.response' || typeof frame.ok !== 'boolean') invalid();
  const base = {
    kind: 'runtime.response' as const,
    protocolVersion: positiveInteger(frame.protocolVersion),
    requestId: identifier(frame.requestId),
    operation: operation(frame.operation),
    correlationId: identifier(frame.correlationId),
  };
  if (frame.ok) return { ...base, ok: true, result: object(frame.result) };
  const error = object(frame.error);
  const code = error.code;
  if (typeof code !== 'string' || !OPERATION_FAILURE_CODES.has(code)) invalid();
  if (typeof error.retryable !== 'boolean') invalid();
  return {
    ...base,
    ok: false,
    error: { code: code as RuntimeOperationFailureCode, retryable: error.retryable },
  };
}

export function parseHealthResult(
  value: Record<string, unknown>,
  selectedProtocolVersion: number,
): RuntimeHealth {
  if (value.status !== 'ready') invalid();
  const protocolVersion = positiveInteger(value.protocolVersion);
  if (protocolVersion !== selectedProtocolVersion) invalid();
  const startedAt = timestamp(value.startedAt);
  const checkedAt = timestamp(value.checkedAt);
  if (Date.parse(checkedAt) < Date.parse(startedAt)) invalid();
  return {
    status: 'ready',
    instanceId: identifier(value.instanceId),
    runtimeVersion: boundedString(value.runtimeVersion, MAX_VERSION_LENGTH),
    buildId: identifier(value.buildId),
    protocolVersion,
    startedAt,
    checkedAt,
  };
}

export function parseShutdownRequest(request: RuntimeRequestFrame): RuntimeShutdownRequest {
  if (request.operation.name !== RUNTIME_SHUTDOWN_OPERATION || !request.idempotencyKey) invalid();
  return {
    idempotencyKey: request.idempotencyKey,
    expectedInstanceId: identifier(request.payload.expectedInstanceId),
    reason: shutdownReason(request.payload.reason),
  };
}

export function parseCreateTaskRequest(request: RuntimeRequestFrame): CreateTaskRequest {
  if (request.operation.name !== TASK_CREATE_OPERATION || !request.idempotencyKey) invalid();
  return parseTaskRequest({ ...request.payload, idempotencyKey: request.idempotencyKey });
}

export function parseStartTaskRequest(request: RuntimeRequestFrame): StartTaskRequest {
  if (request.operation.name !== TASK_START_OPERATION || !request.idempotencyKey) invalid();
  return { taskId: identifier(request.payload.taskId), idempotencyKey: request.idempotencyKey };
}

export function parseCancelTaskRequest(request: RuntimeRequestFrame): CancelTaskRequest {
  if (request.operation.name !== TASK_CANCEL_OPERATION || !request.idempotencyKey) invalid();
  return { taskId: identifier(request.payload.taskId), idempotencyKey: request.idempotencyKey };
}
export function parseProviderSessionActionRequest(
  request: RuntimeRequestFrame,
): ProviderSessionActionRequest {
  const operation = request.operation.name;
  if ((operation !== PROVIDER_SESSION_RESUME_OPERATION &&
    operation !== PROVIDER_SESSION_FORK_OPERATION) || !request.idempotencyKey) invalid();
  return {
    taskId: identifier(request.payload.taskId),
    providerSessionId: identifier(request.payload.providerSessionId),
    idempotencyKey: request.idempotencyKey,
  };
}

export function parseReconcileTaskRequest(request: RuntimeRequestFrame): ReconcileTaskRequest {
  if (request.operation.name !== TASK_RECONCILE_OPERATION || !request.idempotencyKey) invalid();
  return {
    taskId: identifier(request.payload.taskId),
    idempotencyKey: request.idempotencyKey,
  };
}

export function parseRecoverTaskRequest(request: RuntimeRequestFrame): RecoverTaskRequest {
  if (request.operation.name !== TASK_RECOVER_OPERATION || !request.idempotencyKey) invalid();
  return {
    taskId: identifier(request.payload.taskId),
    recoveryId: identifier(request.payload.recoveryId),
    idempotencyKey: request.idempotencyKey,
  };
}

export function parseTaskLifecycleRequest(value: unknown): StartTaskRequest {
  const request = object(value);
  return {
    taskId: identifier(request.taskId),
    idempotencyKey: requiredTaskIdentifier(request.idempotencyKey),
  };
}

export function parseTaskExecutionTaskId(value: unknown): string {
  return identifier(value);
}

export function parseTaskExecutionId(request: RuntimeRequestFrame, operationName: string): string {
  if (request.operation.name !== operationName || request.idempotencyKey !== null) invalid();
  return identifier(request.payload.taskId);
}

export function parseTaskRequest(value: unknown): CreateTaskRequest {
  const request = object(value);
  const provider = boundedString(request.provider, MAX_TASK_FIELD_LENGTH);
  if (!TASK_PROVIDER_SET.has(provider)) invalid();
  return {
    objective: requiredTaskField(request.objective),
    project: requiredTaskField(request.project),
    repository: requiredTaskField(request.repository),
    baseRef: requiredTaskField(request.baseRef),
    provider: provider as CreateTaskRequest['provider'],
    idempotencyKey: requiredTaskIdentifier(request.idempotencyKey),
  };
}

export function parseTaskView(value: Record<string, unknown>) {
  const provider = boundedString(value.provider, MAX_TASK_FIELD_LENGTH);
  if (!TASK_PROVIDER_SET.has(provider)) invalid();
  return {
    id: identifier(value.id),
    objective: requiredTaskField(value.objective),
    project: requiredTaskField(value.project),
    repository: requiredTaskField(value.repository),
    baseRef: requiredTaskField(value.baseRef),
    provider: provider as CreateTaskRequest['provider'],
    createdAt: timestamp(value.createdAt),
  };
}

export function parseTaskList(value: Record<string, unknown>) {
  if (!Array.isArray(value.tasks)) invalid();
  return value.tasks.map((task) => parseTaskView(object(task)));
}

export function parseTaskExecutionView(value: Record<string, unknown>): TaskExecutionView {
  const taskValue = object(value.task);
  const task = parseTaskView(taskValue);
  const executionState = executionStateValue(taskValue.executionState);
  const run = value.run === null ? null : parseRun(object(value.run));
  const attempt = value.attempt === null ? null : parseAttempt(object(value.attempt));
  const attempts = array(value.attempts).map((entry) => parseAttempt(object(entry)));
  const context = value.context === null ? null : parseContext(object(value.context));
  const executionContexts = value.executionContexts === undefined
    ? (context ? [context] : [])
    : array(value.executionContexts).map((entry) => parseContext(object(entry)));
  const providerSession = value.providerSession === undefined || value.providerSession === null ? null : parseProviderSession(object(value.providerSession));
  const providerSessions = array(value.providerSessions).map((entry) => parseProviderSession(object(entry)));
  if (executionState === 'ready' && (run !== null || attempt !== null || context !== null)) invalid();
  if (executionState !== 'ready' && run === null) invalid();
  if (executionState !== 'starting' && executionState !== 'ready' && attempt === null) invalid();
  if (providerSession && (!attempt || !context || providerSession.attemptId !== attempt.id || providerSession.executionContextId !== context.id)) invalid();
  if ((attempt === null) !== (attempts.length === 0) || (attempt && !attempts.some((entry) => entry.id === attempt.id))) invalid();
  if (providerSession && !providerSessions.some((entry) => entry.id === providerSession.id)) invalid();
  return {
    task: { ...task, executionState }, run, attempt, attempts, context,
    executionContexts, providerSession, providerSessions,
  };
}

export function parseTaskRecoveryView(value: Record<string, unknown>): TaskRecoveryView {
  try {
    return parseRecoveryView(value);
  } catch {
    invalid();
  }
}

export function parseTaskRecoveryDecisionView(
  value: Record<string, unknown>,
): TaskRecoveryDecisionView {
  try {
    return parseRecoveryDecisionView(value);
  } catch {
    invalid();
  }
}

export function parseOutputFrame(value: unknown, protocolVersion: number): RuntimeOutputFrame {
  const frame = object(value);
  if (frame.kind !== 'runtime.output' || positiveInteger(frame.protocolVersion) !== protocolVersion) invalid();
  const taskId = identifier(frame.taskId);
  const event = parseTaskOutputEvent(object(frame.event));
  if (event.taskId !== taskId) invalid();
  return { kind: 'runtime.output', protocolVersion, taskId, event };
}

export function parseTaskOutputEvent(value: Record<string, unknown>): TaskOutputEvent {
  const kind = value.kind;
  const base = {
    taskId: identifier(value.taskId),
    attemptId: identifier(value.attemptId),
    sequence: positiveInteger(value.sequence),
  };
  if (kind === 'dropped') return { kind, ...base };
  if (kind === 'data') return { kind, ...base, data: boundedString(value.data, 4 * 1024) };
  invalid();
}

function requiredTaskField(value: unknown): string {
  const field = boundedString(value, MAX_TASK_FIELD_LENGTH);
  if (field.trim().length === 0) invalid();
  return field;
}

function requiredTaskIdentifier(value: unknown): string {
  const field = boundedString(value, RUNTIME_IDENTIFIER_MAX_LENGTH);
  if (field.trim().length === 0) invalid();
  return field;
}

export function parseStoppedResult(value: Record<string, unknown>): {
  readonly state: 'stopped';
  readonly instanceId: string;
} {
  if (value.state !== 'stopped') invalid();
  return { state: 'stopped', instanceId: identifier(value.instanceId) };
}

function operation(value: unknown): RuntimeOperationFrame {
  const candidate = object(value);
  if (candidate.version !== RUNTIME_OPERATION_VERSION) invalid();
  const name = candidate.name;
  if (
    name !== RUNTIME_HEALTH_OPERATION &&
    name !== RUNTIME_SHUTDOWN_OPERATION &&
    name !== TASK_CREATE_OPERATION &&
    name !== TASK_LIST_OPERATION &&
    name !== TASK_START_OPERATION &&
    name !== PROVIDER_SESSION_RESUME_OPERATION &&
    name !== PROVIDER_SESSION_FORK_OPERATION &&
    name !== TASK_RECONCILE_OPERATION &&
    name !== TASK_RECOVER_OPERATION &&
    name !== TASK_CANCEL_OPERATION &&
    name !== TASK_EXECUTION_OPERATION &&
    name !== TASK_OUTPUT_SUBSCRIBE_OPERATION
  )
    invalid();
  return { name, version: RUNTIME_OPERATION_VERSION };
}

function parseRun(value: Record<string, unknown>): { readonly id: string; readonly number: number } {
  return { id: identifier(value.id), number: positiveInteger(value.number) };
}

function parseAttempt(value: Record<string, unknown>): NonNullable<TaskExecutionView['attempt']> {
  const state = executionStateValue(value.state);
  const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode);
  return {
    id: identifier(value.id),
    number: positiveInteger(value.number),
    state,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function parseContext(value: Record<string, unknown>): NonNullable<TaskExecutionView['context']> {
  return {
    id: identifier(value.id),
    worktreeId: identifier(value.worktreeId),
    branchName: boundedString(value.branchName, MAX_TASK_FIELD_LENGTH),
    baseCommit: identifier(value.baseCommit),
  };
}

function parseProviderSession(value: Record<string, unknown>): NonNullable<TaskExecutionView['providerSession']> {
  const capabilities = object(value.capabilities);
  const provider = boundedString(value.provider, MAX_TASK_FIELD_LENGTH);
  if (!TASK_PROVIDER_SET.has(provider) || typeof capabilities.resume !== 'boolean' || typeof capabilities.fork !== 'boolean') invalid();
  const lineage = value.lineage === undefined
    ? (value.parentId === null ? 'new' : 'fork')
    : providerLineage(value.lineage);
  return { id: identifier(value.id), provider: provider as TaskExecutionView['task']['provider'],
    attemptId: identifier(value.attemptId), executionContextId: identifier(value.executionContextId),
    capabilities: { resume: capabilities.resume, fork: capabilities.fork },
    parentId: optionalIdentifier(value.parentId), lineage };
}

function providerLineage(value: unknown): NonNullable<TaskExecutionView['providerSession']>['lineage'] {
  if (value !== 'new' && value !== 'native-resume' && value !== 'fork') invalid();
  return value;
}

function executionStateValue(value: unknown): TaskExecutionState {
  if (
    value !== 'ready' &&
    value !== 'starting' &&
    value !== 'running' &&
    value !== 'completed' &&
    value !== 'failed' &&
    value !== 'cancelling' &&
    value !== 'cancelled' &&
    value !== 'superseding' &&
    value !== 'superseded'
  ) {
    invalid();
  }
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalid();
  return value as number;
}

function protocolRange(value: unknown): RuntimeProtocolRange {
  const range = object(value);
  const min = positiveInteger(range.min);
  const max = positiveInteger(range.max);
  if (max < min) invalid();
  return { min, max };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalid();
  return value;
}

function identifier(value: unknown): string {
  return boundedString(value, RUNTIME_IDENTIFIER_MAX_LENGTH);
}

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function optionalTaskIdempotencyKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}

function nonce(value: unknown): string {
  const result = boundedString(value, RUNTIME_IDENTIFIER_MAX_LENGTH);
  if (result.length < 4 || !/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  return result;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function timestamp(value: unknown): string {
  const result = boundedString(value, RUNTIME_IDENTIFIER_MAX_LENGTH);
  if (!result.endsWith('Z') || !Number.isFinite(Date.parse(result))) invalid();
  return result;
}

function shutdownReason(value: unknown): RuntimeShutdownRequest['reason'] {
  if (value !== 'user-request' && value !== 'desktop-update' && value !== 'test') invalid();
  return value;
}

function invalid(): never {
  throw new RuntimeProtocolValidationError();
}

const OPERATION_FAILURE_CODES = new Set([
  'invalid-request',
  'unsupported-operation',
  'stale-instance',
  'idempotency-conflict',
  'not-found',
  'task-not-ready',
  'worktree-unavailable',
  'process-start-failed',
  'runtime-stopping',
  'internal',
]);

import type {
  RuntimeHealth,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
} from '../shared/runtime/runtime-interface';
import {
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_HEALTH_OPERATION,
  RUNTIME_OPERATION_VERSION,
  RUNTIME_SHUTDOWN_OPERATION,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeIncompatibleFrame,
  type RuntimeOperationFrame,
  type RuntimeRequestFrame,
  type RuntimeResponseFrame,
  type RuntimeUnauthorizedFrame,
  type RuntimeWelcomeFrame,
} from './protocol';

const MAX_ID_LENGTH = 128;
const MAX_VERSION_LENGTH = 128;
const MAX_PROOF_LENGTH = 128;

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
  if (frame.kind === 'runtime.incompatible') {
    return {
      kind: 'runtime.incompatible',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: identifier(frame.challengeId),
      requestId: identifier(frame.requestId),
      serverNonce: nonce(frame.serverNonce),
      clientNonce: nonce(frame.clientNonce),
      runtimeRange: protocolRange(frame.runtimeRange),
      runtimeVersion: boundedString(frame.runtimeVersion, MAX_VERSION_LENGTH),
      buildId: identifier(frame.buildId),
      proof: boundedString(frame.proof, MAX_PROOF_LENGTH),
    };
  }
  if (frame.kind !== 'runtime.welcome') invalid();
  const runtime = object(frame.runtime);
  return {
    kind: 'runtime.welcome',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: identifier(frame.challengeId),
    requestId: identifier(frame.requestId),
    serverNonce: nonce(frame.serverNonce),
    clientNonce: nonce(frame.clientNonce),
    sessionId: identifier(frame.sessionId),
    selectedProtocolVersion: positiveInteger(frame.selectedProtocolVersion),
    runtimeRange: protocolRange(frame.runtimeRange),
    runtime: {
      instanceId: identifier(runtime.instanceId),
      runtimeVersion: boundedString(runtime.runtimeVersion, MAX_VERSION_LENGTH),
      buildId: identifier(runtime.buildId),
      startedAt: timestamp(runtime.startedAt),
    },
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
    idempotencyKey: optionalIdentifier(frame.idempotencyKey),
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
  if (
    code !== 'invalid-request' &&
    code !== 'unsupported-operation' &&
    code !== 'stale-instance' &&
    code !== 'idempotency-conflict' &&
    code !== 'runtime-stopping' &&
    code !== 'internal'
  ) {
    invalid();
  }
  if (typeof error.retryable !== 'boolean') invalid();
  return { ...base, ok: false, error: { code, retryable: error.retryable } };
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
  if (name !== RUNTIME_HEALTH_OPERATION && name !== RUNTIME_SHUTDOWN_OPERATION) invalid();
  return { name, version: RUNTIME_OPERATION_VERSION };
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

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalid();
  return value;
}

function identifier(value: unknown): string {
  return boundedString(value, MAX_ID_LENGTH);
}

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function nonce(value: unknown): string {
  const result = boundedString(value, MAX_ID_LENGTH);
  if (result.length < 4 || !/^[A-Za-z0-9_-]+$/.test(result)) invalid();
  return result;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function timestamp(value: unknown): string {
  const result = boundedString(value, MAX_ID_LENGTH);
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

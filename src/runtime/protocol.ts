import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  RuntimeOperationFailureCode,
  RuntimeProtocolRange,
  TaskOutputEvent,
} from '../shared/runtime/runtime-interface';

export const RUNTIME_HANDSHAKE_VERSION = 1 as const;
export const RUNTIME_HEALTH_OPERATION = 'runtime.health' as const;
export const RUNTIME_SHUTDOWN_OPERATION = 'runtime.shutdown' as const;
export const TASK_CREATE_OPERATION = 'task.create' as const;
export const TASK_LIST_OPERATION = 'task.list' as const;
export const TASK_START_OPERATION = 'task.start' as const;
export const PROVIDER_SESSION_RESUME_OPERATION = 'provider-session.resume' as const;
export const PROVIDER_SESSION_FORK_OPERATION = 'provider-session.fork' as const;
export const TASK_RECONCILE_OPERATION = 'task.reconcile' as const;
export const TASK_RECOVER_OPERATION = 'task.recover' as const;
export const TASK_CANCEL_OPERATION = 'task.cancel' as const;
export const TASK_EXECUTION_OPERATION = 'task.execution.get' as const;
export const TASK_TIMELINE_OPERATION = 'task.timeline.get' as const;
export const TASK_OUTPUT_SUBSCRIBE_OPERATION = 'task.output.subscribe' as const;
export const RUNTIME_OPERATION_VERSION = 1 as const;

export interface RuntimeChallengeFrame {
  readonly kind: 'runtime.challenge';
  readonly handshakeVersion: typeof RUNTIME_HANDSHAKE_VERSION;
  readonly challengeId: string;
  readonly serverNonce: string;
  readonly expiresAt: string;
}

export interface RuntimeAuthenticateFrame {
  readonly kind: 'runtime.authenticate';
  readonly handshakeVersion: typeof RUNTIME_HANDSHAKE_VERSION;
  readonly challengeId: string;
  readonly requestId: string;
  readonly clientNonce: string;
  readonly client: {
    readonly name: 'hariari-desktop' | 'hariari-cli';
    readonly version: string;
  };
  readonly protocolRange: RuntimeProtocolRange;
  readonly proof: string;
}

export interface RuntimeIdentityFrame {
  readonly instanceId: string;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly startedAt: string;
}

export interface RuntimeAuthenticatedReplyEnvelope {
  readonly handshakeVersion: typeof RUNTIME_HANDSHAKE_VERSION;
  readonly challengeId: string;
  readonly requestId: string;
  readonly serverNonce: string;
  readonly clientNonce: string;
  readonly runtimeRange: RuntimeProtocolRange;
  readonly proof: string;
}

export type RuntimeUnsignedAuthenticatedReplyEnvelope = Omit<
  RuntimeAuthenticatedReplyEnvelope,
  'proof'
>;

export interface RuntimeWelcomeFrame extends RuntimeAuthenticatedReplyEnvelope {
  readonly kind: 'runtime.welcome';
  readonly sessionId: string;
  readonly selectedProtocolVersion: number;
  readonly runtime: RuntimeIdentityFrame;
}

export interface RuntimeIncompatibleFrame extends RuntimeAuthenticatedReplyEnvelope {
  readonly kind: 'runtime.incompatible';
  readonly runtimeVersion: string;
  readonly buildId: string;
}

export interface RuntimeUnauthorizedFrame {
  readonly kind: 'runtime.unauthorized';
  readonly handshakeVersion: typeof RUNTIME_HANDSHAKE_VERSION;
}

export type RuntimeOperationName =
  | typeof RUNTIME_HEALTH_OPERATION
  | typeof RUNTIME_SHUTDOWN_OPERATION
  | typeof TASK_CREATE_OPERATION
  | typeof TASK_LIST_OPERATION
  | typeof TASK_START_OPERATION
  | typeof PROVIDER_SESSION_RESUME_OPERATION
  | typeof PROVIDER_SESSION_FORK_OPERATION
  | typeof TASK_RECONCILE_OPERATION
  | typeof TASK_RECOVER_OPERATION
  | typeof TASK_CANCEL_OPERATION
  | typeof TASK_EXECUTION_OPERATION
  | typeof TASK_TIMELINE_OPERATION
  | typeof TASK_OUTPUT_SUBSCRIBE_OPERATION;

export interface RuntimeOperationFrame {
  readonly name: RuntimeOperationName;
  readonly version: typeof RUNTIME_OPERATION_VERSION;
}

export interface RuntimeRequestFrame {
  readonly kind: 'runtime.request';
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly operation: RuntimeOperationFrame;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string | null;
  readonly payload: Record<string, unknown>;
}

export interface RuntimeProtocolErrorFrame {
  readonly code: RuntimeOperationFailureCode;
  readonly retryable: boolean;
}

export type RuntimeResponseFrame =
  | {
      readonly kind: 'runtime.response';
      readonly protocolVersion: number;
      readonly requestId: string;
      readonly operation: RuntimeOperationFrame;
      readonly correlationId: string;
      readonly ok: true;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: 'runtime.response';
      readonly protocolVersion: number;
      readonly requestId: string;
      readonly operation: RuntimeOperationFrame;
      readonly correlationId: string;
      readonly ok: false;
      readonly error: RuntimeProtocolErrorFrame;
    };

export interface RuntimeOutputFrame {
  readonly kind: 'runtime.output';
  readonly protocolVersion: number;
  readonly taskId: string;
  readonly event: TaskOutputEvent;
}

type RuntimeProvenReply = RuntimeWelcomeFrame | RuntimeIncompatibleFrame;
export type RuntimeReplyWithoutProof =
  | Omit<RuntimeWelcomeFrame, 'proof'>
  | Omit<RuntimeIncompatibleFrame, 'proof'>;

export function createAuthenticatedReplyEnvelope(
  challenge: RuntimeChallengeFrame,
  authenticate: Omit<RuntimeAuthenticateFrame, 'proof'>,
  runtimeRange: RuntimeProtocolRange,
): RuntimeUnsignedAuthenticatedReplyEnvelope {
  return {
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: challenge.challengeId,
    requestId: authenticate.requestId,
    serverNonce: challenge.serverNonce,
    clientNonce: authenticate.clientNonce,
    runtimeRange,
  };
}

export function selectHighestMutualVersion(
  client: RuntimeProtocolRange,
  runtime: RuntimeProtocolRange,
): number | null {
  if (!isProtocolRange(client) || !isProtocolRange(runtime)) return null;
  const selected = Math.min(client.max, runtime.max);
  return selected >= Math.max(client.min, runtime.min) ? selected : null;
}

export function createClientProof(
  token: Uint8Array,
  challenge: RuntimeChallengeFrame,
  authenticate: Omit<RuntimeAuthenticateFrame, 'proof'>,
): string {
  return sign(token, [
    'hariari-runtime-client-v1',
    challenge.challengeId,
    challenge.serverNonce,
    challenge.expiresAt,
    authenticate.requestId,
    authenticate.clientNonce,
    authenticate.client.name,
    authenticate.client.version,
    authenticate.protocolRange.min,
    authenticate.protocolRange.max,
  ]);
}

export function verifyClientProof(
  token: Uint8Array,
  challenge: RuntimeChallengeFrame,
  authenticate: RuntimeAuthenticateFrame,
): boolean {
  const { proof, ...withoutProof } = authenticate;
  return proofsEqual(proof, createClientProof(token, challenge, withoutProof));
}

export function createServerProof(token: Uint8Array, reply: RuntimeReplyWithoutProof): string {
  return sign(token, ['hariari-runtime-server-v1', reply]);
}

export function verifyServerProof(token: Uint8Array, reply: RuntimeProvenReply): boolean {
  const { proof, ...withoutProof } = reply;
  return proofsEqual(proof, createServerProof(token, withoutProof));
}

export function proofsEqual(left: string, right: string): boolean {
  if (!isCanonicalProof(left) || !isCanonicalProof(right)) return false;
  try {
    const leftBytes = Buffer.from(left, 'base64url');
    const rightBytes = Buffer.from(right, 'base64url');
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function isCanonicalProof(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

function sign(token: Uint8Array, transcript: readonly unknown[]): string {
  return createHmac('sha256', token).update(JSON.stringify(transcript)).digest('base64url');
}

function isProtocolRange(value: RuntimeProtocolRange): boolean {
  return (
    Number.isSafeInteger(value.min) &&
    Number.isSafeInteger(value.max) &&
    value.min >= 1 &&
    value.max >= value.min
  );
}

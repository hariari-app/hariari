import { describe, expect, it } from 'vitest';
import {
  createAuthenticatedReplyEnvelope,
  createClientProof,
  createServerProof,
  selectHighestMutualVersion,
  verifyClientProof,
  verifyServerProof,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeWelcomeFrame,
} from '../../src/runtime/protocol';
import { parseRequestFrame } from '../../src/runtime/protocol-validation';

const TOKEN = new Uint8Array(32).fill(19);
const CHALLENGE: RuntimeChallengeFrame = {
  kind: 'runtime.challenge',
  handshakeVersion: 1,
  challengeId: 'challenge-1',
  serverNonce: 'server-nonce-123456',
  expiresAt: '2026-08-20T10:00:05.000Z',
};
const AUTHENTICATE: Omit<RuntimeAuthenticateFrame, 'proof'> = {
  kind: 'runtime.authenticate',
  handshakeVersion: 1,
  challengeId: CHALLENGE.challengeId,
  requestId: 'request-1',
  clientNonce: 'client-nonce-123456',
  client: { name: 'hariari-desktop', version: '0.6.8' },
  protocolRange: { min: 1, max: 4 },
};

describe('Runtime protocol', registerRuntimeProtocolTests);

function registerRuntimeProtocolTests(): void {
  registerVersionSelectionTest();
  registerClientProofTest();
  registerServerProofTest();
  registerAuthenticatedEnvelopeTest();
  registerRequestMetadataTest();
  registerProviderSpecificOperationRejectionTest();
}

function registerProviderSpecificOperationRejectionTest(): void {
  it.each(['claude.resume', 'claude.fork'])('rejects the unsupported %s Runtime operation', (name) => {
    expect(() => parseRequestFrame({
      kind: 'runtime.request', protocolVersion: 1, requestId: 'request-claude',
      operation: { name, version: 1 }, correlationId: 'correlation-claude',
      causationId: null, idempotencyKey: 'claude-action', payload: {},
    })).toThrow('Runtime protocol frame is invalid');
  });
}

function registerVersionSelectionTest(): void {
  it('selects the highest mutually supported protocol version', () => {
    expect(selectHighestMutualVersion({ min: 1, max: 4 }, { min: 2, max: 3 })).toBe(3);
    expect(selectHighestMutualVersion({ min: 1, max: 2 }, { min: 3, max: 5 })).toBeNull();
  });
}

function registerClientProofTest(): void {
  it('binds client authentication to the challenge, identity, and complete range', () => {
    const proof = createClientProof(TOKEN, CHALLENGE, AUTHENTICATE);
    const frame: RuntimeAuthenticateFrame = { ...AUTHENTICATE, proof };

    expect(verifyClientProof(TOKEN, CHALLENGE, frame)).toBe(true);
    expect(
      verifyClientProof(TOKEN, CHALLENGE, {
        ...frame,
        protocolRange: { min: 1, max: 3 },
      }),
    ).toBe(false);
    expect(verifyClientProof(new Uint8Array(32).fill(20), CHALLENGE, frame)).toBe(false);
    expect(verifyClientProof(TOKEN, CHALLENGE, { ...frame, proof: `${proof}!` })).toBe(false);
  });
}

function registerServerProofTest(): void {
  it('binds the Runtime proof to the complete authenticated response', () => {
    const replyWithoutProof: Omit<RuntimeWelcomeFrame, 'proof'> = {
      kind: 'runtime.welcome',
      handshakeVersion: 1,
      challengeId: CHALLENGE.challengeId,
      requestId: AUTHENTICATE.requestId,
      serverNonce: CHALLENGE.serverNonce,
      clientNonce: AUTHENTICATE.clientNonce,
      sessionId: 'session-1',
      selectedProtocolVersion: 3,
      runtimeRange: { min: 2, max: 3 },
      runtime: {
        instanceId: 'runtime-1',
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
        startedAt: '2026-08-20T10:00:00.000Z',
      },
    };
    const reply: RuntimeWelcomeFrame = {
      ...replyWithoutProof,
      proof: createServerProof(TOKEN, replyWithoutProof),
    };

    expect(verifyServerProof(TOKEN, reply)).toBe(true);
    expect(verifyServerProof(TOKEN, { ...reply, selectedProtocolVersion: 2 })).toBe(false);
  });
}

function registerAuthenticatedEnvelopeTest(): void {
  it('builds one authenticated envelope for every proven Runtime reply', () => {
    expect(createAuthenticatedReplyEnvelope(CHALLENGE, AUTHENTICATE, { min: 2, max: 3 })).toEqual({
      handshakeVersion: 1,
      challengeId: 'challenge-1',
      requestId: 'request-1',
      serverNonce: 'server-nonce-123456',
      clientNonce: 'client-nonce-123456',
      runtimeRange: { min: 2, max: 3 },
    });
  });
}

function registerRequestMetadataTest(): void {
  it('reserves correlation, causation, and idempotency without accepting extra operations', () => {
    expect(
      parseRequestFrame({
        kind: 'runtime.request',
        protocolVersion: 1,
        requestId: 'request-1',
        operation: { name: 'runtime.shutdown', version: 1 },
        correlationId: 'correlation-1',
        causationId: 'cause-1',
        idempotencyKey: 'shutdown-1',
        payload: { expectedInstanceId: 'runtime-1', reason: 'test' },
        additiveFutureField: true,
      }),
    ).toMatchObject({
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      idempotencyKey: 'shutdown-1',
    });
    expect(() =>
      parseRequestFrame({
        kind: 'runtime.request',
        protocolVersion: 1,
        requestId: 'request-2',
        operation: { name: 'agent.execute', version: 1 },
        correlationId: 'correlation-2',
        causationId: null,
        idempotencyKey: null,
        payload: {},
      }),
    ).toThrow('Runtime protocol frame is invalid');
  });
}

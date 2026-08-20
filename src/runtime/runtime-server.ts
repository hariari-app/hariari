import type { RuntimeProtocolRange } from '../shared/runtime/runtime-interface';
import type {
  RuntimeFrameConnection,
  RuntimeLocalEndpoint,
  RuntimeLocalTransport,
  RuntimeTransportListener,
} from './local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_HEALTH_OPERATION,
  RUNTIME_OPERATION_VERSION,
  RUNTIME_SHUTDOWN_OPERATION,
  createServerProof,
  selectHighestMutualVersion,
  verifyClientProof,
  type RuntimeChallengeFrame,
  type RuntimeIdentityFrame,
  type RuntimeRequestFrame,
  type RuntimeResponseFrame,
} from './protocol';
import {
  parseAuthenticateFrame,
  parseRequestFrame,
  parseShutdownRequest,
} from './protocol-validation';

export interface RuntimeServerOptions {
  readonly transport: RuntimeLocalTransport;
  readonly endpoint: RuntimeLocalEndpoint;
  readonly token: Uint8Array;
  readonly supportedProtocolRange: RuntimeProtocolRange;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly now: () => number;
  readonly randomId: () => string;
  readonly randomNonce: () => string;
  readonly handshakeDeadlineMs: number;
  readonly requestDeadlineMs: number;
}

interface ShutdownRecord {
  readonly fingerprint: string;
  readonly result: Record<string, unknown>;
}

export class RuntimeServer {
  readonly identity: RuntimeIdentityFrame;
  private listener: RuntimeTransportListener | null = null;
  private readonly connections = new Set<RuntimeFrameConnection>();
  private readonly shutdownRecords = new Map<string, ShutdownRecord>();
  private stopping = false;
  private stopInFlight: Promise<void> | null = null;

  constructor(private readonly options: RuntimeServerOptions) {
    this.identity = {
      instanceId: options.randomId(),
      runtimeVersion: options.runtimeVersion,
      buildId: options.buildId,
      startedAt: new Date(options.now()).toISOString(),
    };
  }

  async start(): Promise<void> {
    if (this.listener) return;
    this.listener = await this.options.transport.listen(this.options.endpoint, (connection) =>
      this.serveConnection(connection),
    );
  }

  stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    this.stopping = true;
    const listener = this.listener;
    this.listener = null;
    this.stopInFlight = (async () => {
      for (const connection of this.connections) connection.close();
      this.connections.clear();
      if (listener) await listener.close();
    })();
    return this.stopInFlight;
  }

  private async serveConnection(connection: RuntimeFrameConnection): Promise<void> {
    this.connections.add(connection);
    try {
      if (this.stopping) return;
      const selectedProtocol = await this.authenticate(connection);
      if (selectedProtocol === null) return;
      while (!this.stopping) {
        const frame = await connection.readFrame(this.options.requestDeadlineMs);
        const request = parseRequestFrame(frame);
        const response = this.handleRequest(request, selectedProtocol);
        await connection.writeFrame({ ...response }, this.options.requestDeadlineMs);
        if (
          request.operation.name === RUNTIME_SHUTDOWN_OPERATION &&
          response.ok &&
          response.result.state === 'stopped'
        ) {
          setTimeout(() => void this.stop(), 0);
          return;
        }
      }
    } catch {
      // Protocol and transport failures are intentionally redacted at this seam.
    } finally {
      this.connections.delete(connection);
      connection.close();
    }
  }

  private async authenticate(connection: RuntimeFrameConnection): Promise<number | null> {
    const challenge: RuntimeChallengeFrame = {
      kind: 'runtime.challenge',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: this.options.randomId(),
      serverNonce: this.options.randomNonce(),
      expiresAt: new Date(this.options.now() + this.options.handshakeDeadlineMs).toISOString(),
    };
    await connection.writeFrame({ ...challenge }, this.options.handshakeDeadlineMs);

    let authenticate;
    try {
      authenticate = parseAuthenticateFrame(
        await connection.readFrame(this.options.handshakeDeadlineMs),
      );
    } catch {
      await this.rejectAuthentication(connection);
      return null;
    }
    if (
      authenticate.challengeId !== challenge.challengeId ||
      this.options.now() > Date.parse(challenge.expiresAt) ||
      !verifyClientProof(this.options.token, challenge, authenticate)
    ) {
      await this.rejectAuthentication(connection);
      return null;
    }

    const selected = selectHighestMutualVersion(
      authenticate.protocolRange,
      this.options.supportedProtocolRange,
    );
    if (selected === null) {
      const withoutProof = {
        kind: 'runtime.incompatible' as const,
        handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
        challengeId: challenge.challengeId,
        requestId: authenticate.requestId,
        serverNonce: challenge.serverNonce,
        clientNonce: authenticate.clientNonce,
        runtimeRange: this.options.supportedProtocolRange,
        runtimeVersion: this.identity.runtimeVersion,
        buildId: this.identity.buildId,
      };
      await connection.writeFrame(
        { ...withoutProof, proof: createServerProof(this.options.token, withoutProof) },
        this.options.handshakeDeadlineMs,
      );
      return null;
    }

    const withoutProof = {
      kind: 'runtime.welcome' as const,
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: challenge.challengeId,
      requestId: authenticate.requestId,
      serverNonce: challenge.serverNonce,
      clientNonce: authenticate.clientNonce,
      sessionId: this.options.randomId(),
      selectedProtocolVersion: selected,
      runtimeRange: this.options.supportedProtocolRange,
      runtime: this.identity,
    };
    await connection.writeFrame(
      { ...withoutProof, proof: createServerProof(this.options.token, withoutProof) },
      this.options.handshakeDeadlineMs,
    );
    return selected;
  }

  private handleRequest(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): RuntimeResponseFrame {
    if (request.protocolVersion !== protocolVersion) {
      return failure(request, protocolVersion, 'invalid-request', false);
    }
    if (request.operation.name === RUNTIME_HEALTH_OPERATION) {
      if (request.idempotencyKey !== null || Object.keys(request.payload).length !== 0) {
        return failure(request, protocolVersion, 'invalid-request', false);
      }
      if (this.stopping) return failure(request, protocolVersion, 'runtime-stopping', true);
      return success(request, protocolVersion, {
        status: 'ready',
        ...this.identity,
        protocolVersion,
        checkedAt: new Date(this.options.now()).toISOString(),
      });
    }
    return this.handleShutdown(request, protocolVersion);
  }

  private handleShutdown(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): RuntimeResponseFrame {
    let shutdownRequest;
    try {
      shutdownRequest = parseShutdownRequest(request);
    } catch {
      return failure(request, protocolVersion, 'invalid-request', false);
    }
    const fingerprint = JSON.stringify([
      shutdownRequest.expectedInstanceId,
      shutdownRequest.reason,
    ]);
    const existing = this.shutdownRecords.get(shutdownRequest.idempotencyKey);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? success(request, protocolVersion, existing.result)
        : failure(request, protocolVersion, 'idempotency-conflict', false);
    }
    if (shutdownRequest.expectedInstanceId !== this.identity.instanceId) {
      return failure(request, protocolVersion, 'stale-instance', false);
    }
    const result = { state: 'stopped', instanceId: this.identity.instanceId };
    this.shutdownRecords.set(shutdownRequest.idempotencyKey, { fingerprint, result });
    this.stopping = true;
    return success(request, protocolVersion, result);
  }

  private async rejectAuthentication(connection: RuntimeFrameConnection): Promise<void> {
    await connection
      .writeFrame(
        {
          kind: 'runtime.unauthorized',
          handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
        },
        this.options.handshakeDeadlineMs,
      )
      .catch(() => undefined);
  }
}

function success(
  request: RuntimeRequestFrame,
  protocolVersion: number,
  result: Record<string, unknown>,
): RuntimeResponseFrame {
  return {
    kind: 'runtime.response',
    protocolVersion,
    requestId: request.requestId,
    operation: { ...request.operation, version: RUNTIME_OPERATION_VERSION },
    correlationId: request.correlationId,
    ok: true,
    result,
  };
}

function failure(
  request: RuntimeRequestFrame,
  protocolVersion: number,
  code: Extract<RuntimeResponseFrame, { ok: false }>['error']['code'],
  retryable: boolean,
): RuntimeResponseFrame {
  return {
    kind: 'runtime.response',
    protocolVersion,
    requestId: request.requestId,
    operation: request.operation,
    correlationId: request.correlationId,
    ok: false,
    error: { code, retryable },
  };
}

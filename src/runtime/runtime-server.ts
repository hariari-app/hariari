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
  TASK_CREATE_OPERATION,
  TASK_LIST_OPERATION,
  createAuthenticatedReplyEnvelope,
  createServerProof,
  selectHighestMutualVersion,
  verifyClientProof,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeIdentityFrame,
  type RuntimeRequestFrame,
  type RuntimeReplyWithoutProof,
  type RuntimeResponseFrame,
} from './protocol';
import {
  parseAuthenticateFrame,
  parseRequestFrame,
  parseCreateTaskRequest,
  parseShutdownRequest,
} from './protocol-validation';
import { TaskModule, TaskStorageError } from './task-module';

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

type RuntimeServerLifecycle =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting'; readonly listener: Promise<RuntimeTransportListener> }
  | { readonly phase: 'listening'; readonly listener: RuntimeTransportListener }
  | { readonly phase: 'stop-requested'; readonly listener: RuntimeTransportListener }
  | { readonly phase: 'stopping'; readonly settled: Promise<void> }
  | { readonly phase: 'stopped' };

export class RuntimeServer {
  readonly identity: RuntimeIdentityFrame;
  private readonly connections = new Set<RuntimeFrameConnection>();
  private readonly shutdownRecords = new Map<string, ShutdownRecord>();
  private readonly tasks: TaskModule;
  private lifecycle: RuntimeServerLifecycle = { phase: 'idle' };

  constructor(private readonly options: RuntimeServerOptions) {
    this.identity = {
      instanceId: options.randomId(),
      runtimeVersion: options.runtimeVersion,
      buildId: options.buildId,
      startedAt: new Date(options.now()).toISOString(),
    };
    this.tasks = new TaskModule(options.endpoint.runtimeDirectory, options.now, options.randomId);
  }

  async start(): Promise<void> {
    if (this.lifecycle.phase === 'starting') return void (await this.lifecycle.listener);
    if (this.lifecycle.phase !== 'idle') return;
    const listener = this.tasks
      .start()
      .then(() =>
        this.options.transport.listen(this.options.endpoint, (connection) =>
          this.serveConnection(connection),
        ),
      );
    const starting = { phase: 'starting' as const, listener };
    this.lifecycle = starting;
    try {
      const resolved = await listener;
      if (this.lifecycle === starting) this.lifecycle = { phase: 'listening', listener: resolved };
    } catch (error) {
      if (this.lifecycle === starting) this.lifecycle = { phase: 'idle' };
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.lifecycle.phase === 'stopping') return this.lifecycle.settled;
    if (this.lifecycle.phase === 'stopped') return Promise.resolve();
    const owned = this.lifecycle;
    const settled = Promise.resolve().then(() => this.finishStop(owned));
    this.lifecycle = { phase: 'stopping', settled };
    return settled;
  }

  private async finishStop(owned: RuntimeServerLifecycle): Promise<void> {
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    const listener = await ownedListener(owned);
    await listener?.close();
    this.lifecycle = { phase: 'stopped' };
  }

  private async serveConnection(connection: RuntimeFrameConnection): Promise<void> {
    this.connections.add(connection);
    try {
      if (this.isStopping()) return;
      const selectedProtocol = await this.authenticate(connection);
      if (selectedProtocol === null) return;
      while (!this.isStopping()) {
        const frame = await connection.readFrame(this.options.requestDeadlineMs);
        const request = parseRequestFrame(frame);
        const response = await this.handleRequest(request, selectedProtocol);
        const acceptedShutdown = stopsRuntime(request, response);
        try {
          await connection.writeFrame({ ...response }, this.options.requestDeadlineMs);
        } finally {
          if (acceptedShutdown) setTimeout(() => void this.stop(), 0);
        }
        if (acceptedShutdown) return;
      }
    } catch {
      // Protocol and transport failures are intentionally redacted at this seam.
    } finally {
      this.connections.delete(connection);
      connection.close();
    }
  }

  private async authenticate(connection: RuntimeFrameConnection): Promise<number | null> {
    const challenge = this.createChallenge();
    await connection.writeFrame({ ...challenge }, this.options.handshakeDeadlineMs);
    const authenticate = await this.readAuthentication(connection, challenge);
    if (!authenticate) return null;
    const selected = selectHighestMutualVersion(
      authenticate.protocolRange,
      this.options.supportedProtocolRange,
    );
    const envelope = createAuthenticatedReplyEnvelope(
      challenge,
      authenticate,
      this.options.supportedProtocolRange,
    );
    if (selected === null) {
      const withoutProof = {
        kind: 'runtime.incompatible' as const,
        ...envelope,
        runtimeVersion: this.identity.runtimeVersion,
        buildId: this.identity.buildId,
      };
      await this.writeAuthenticatedReply(connection, withoutProof);
      return null;
    }
    const withoutProof = {
      kind: 'runtime.welcome' as const,
      ...envelope,
      sessionId: this.options.randomId(),
      selectedProtocolVersion: selected,
      runtime: this.identity,
    };
    await this.writeAuthenticatedReply(connection, withoutProof);
    return selected;
  }

  private createChallenge(): RuntimeChallengeFrame {
    return {
      kind: 'runtime.challenge',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: this.options.randomId(),
      serverNonce: this.options.randomNonce(),
      expiresAt: new Date(this.options.now() + this.options.handshakeDeadlineMs).toISOString(),
    };
  }

  private async readAuthentication(
    connection: RuntimeFrameConnection,
    challenge: RuntimeChallengeFrame,
  ): Promise<RuntimeAuthenticateFrame | null> {
    try {
      const authenticate = parseAuthenticateFrame(
        await connection.readFrame(this.options.handshakeDeadlineMs),
      );
      const valid =
        authenticate.challengeId === challenge.challengeId &&
        this.options.now() <= Date.parse(challenge.expiresAt) &&
        verifyClientProof(this.options.token, challenge, authenticate);
      if (valid) return authenticate;
    } catch {
      // Authentication failures share one redacted response.
    }
    await this.rejectAuthentication(connection);
    return null;
  }

  private async writeAuthenticatedReply(
    connection: RuntimeFrameConnection,
    reply: RuntimeReplyWithoutProof,
  ): Promise<void> {
    await connection.writeFrame(
      { ...reply, proof: createServerProof(this.options.token, reply) },
      this.options.handshakeDeadlineMs,
    );
  }

  private async handleRequest(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): Promise<RuntimeResponseFrame> {
    if (request.protocolVersion !== protocolVersion) {
      return failure(request, protocolVersion, 'invalid-request', false);
    }
    if (request.operation.name === RUNTIME_HEALTH_OPERATION) {
      if (request.idempotencyKey !== null || Object.keys(request.payload).length !== 0) {
        return failure(request, protocolVersion, 'invalid-request', false);
      }
      if (this.isStopping()) return failure(request, protocolVersion, 'runtime-stopping', true);
      return success(request, protocolVersion, {
        status: 'ready',
        ...this.identity,
        protocolVersion,
        checkedAt: new Date(this.options.now()).toISOString(),
      });
    }
    if (request.operation.name === TASK_LIST_OPERATION) {
      if (request.idempotencyKey !== null || Object.keys(request.payload).length !== 0) {
        return failure(request, protocolVersion, 'invalid-request', false);
      }
      return success(request, protocolVersion, { tasks: this.tasks.list() });
    }
    if (request.operation.name === TASK_CREATE_OPERATION) {
      try {
        return success(
          request,
          protocolVersion,
          (await this.tasks.create(parseCreateTaskRequest(request))) as unknown as Record<
            string,
            unknown
          >,
        );
      } catch (error) {
        if (error instanceof TaskStorageError) {
          return failure(request, protocolVersion, error.code, error.code === 'internal');
        }
        return failure(request, protocolVersion, 'internal', true);
      }
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
    this.requestStop();
    return success(request, protocolVersion, result);
  }

  private requestStop(): void {
    if (this.lifecycle.phase === 'listening') {
      this.lifecycle = { phase: 'stop-requested', listener: this.lifecycle.listener };
    }
  }

  private isStopping(): boolean {
    return ['stop-requested', 'stopping', 'stopped'].includes(this.lifecycle.phase);
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

async function ownedListener(
  lifecycle: RuntimeServerLifecycle,
): Promise<RuntimeTransportListener | null> {
  if (lifecycle.phase === 'starting') return lifecycle.listener.catch(() => null);
  if (lifecycle.phase === 'listening' || lifecycle.phase === 'stop-requested') {
    return lifecycle.listener;
  }
  return null;
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

function stopsRuntime(request: RuntimeRequestFrame, response: RuntimeResponseFrame): boolean {
  return (
    request.operation.name === RUNTIME_SHUTDOWN_OPERATION &&
    response.ok &&
    response.result.state === 'stopped'
  );
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

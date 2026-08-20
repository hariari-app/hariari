import type {
  RuntimeHealth,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';
import type {
  RuntimeFrameConnection,
  RuntimeLocalTransport,
  RuntimeTransportError,
} from '../../runtime/local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_HEALTH_OPERATION,
  RUNTIME_OPERATION_VERSION,
  RUNTIME_SHUTDOWN_OPERATION,
  createClientProof,
  selectHighestMutualVersion,
  verifyServerProof,
  type RuntimeAuthenticateFrame,
  type RuntimeIdentityFrame,
  type RuntimeOperationName,
  type RuntimeRequestFrame,
} from '../../runtime/protocol';
import {
  parseChallengeFrame,
  parseHandshakeReply,
  parseHealthResult,
  parseResponseFrame,
  parseStoppedResult,
} from '../../runtime/protocol-validation';
import {
  RuntimePortError,
  type RuntimeClientConnectOptions,
  type RuntimeClientConnection,
  type RuntimeClientPort,
  type RuntimeClientSession,
  type RuntimeEndpoint,
} from './runtime-ports';

export interface NodeRuntimeClientOptions {
  readonly transport: RuntimeLocalTransport;
  readonly randomId: () => string;
  readonly randomNonce: () => string;
}

export class NodeRuntimeClient implements RuntimeClientPort {
  constructor(private readonly options: NodeRuntimeClientOptions) {}

  async connect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    options: RuntimeClientConnectOptions,
  ): Promise<RuntimeClientConnection> {
    const connection = await this.connectTransport(endpoint, options.deadlineMs);
    if (!token) {
      connection.close();
      throw new RuntimePortError('credentials-unavailable');
    }

    try {
      const challenge = parseChallengeFrame(await connection.readFrame(options.deadlineMs));
      const authenticateWithoutProof: Omit<RuntimeAuthenticateFrame, 'proof'> = {
        kind: 'runtime.authenticate',
        handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
        challengeId: challenge.challengeId,
        requestId: this.options.randomId(),
        clientNonce: this.options.randomNonce(),
        client: options.clientIdentity,
        protocolRange: options.supportedProtocolRange,
      };
      const authenticate: RuntimeAuthenticateFrame = {
        ...authenticateWithoutProof,
        proof: createClientProof(token, challenge, authenticateWithoutProof),
      };
      await connection.writeFrame({ ...authenticate }, options.deadlineMs);
      const reply = parseHandshakeReply(await connection.readFrame(options.deadlineMs));
      if (reply.kind === 'runtime.unauthorized') {
        throw new RuntimePortError('authentication-rejected');
      }
      if (
        reply.challengeId !== challenge.challengeId ||
        reply.requestId !== authenticate.requestId ||
        reply.serverNonce !== challenge.serverNonce ||
        reply.clientNonce !== authenticate.clientNonce ||
        !verifyServerProof(token, reply)
      ) {
        throw new RuntimePortError('protocol-error');
      }
      const selected = selectHighestMutualVersion(
        options.supportedProtocolRange,
        reply.runtimeRange,
      );
      if (reply.kind === 'runtime.incompatible') {
        if (selected !== null) throw new RuntimePortError('protocol-error');
        connection.close();
        return {
          kind: 'incompatible',
          runtimeRange: reply.runtimeRange,
          runtimeVersion: reply.runtimeVersion,
          buildId: reply.buildId,
        };
      }
      if (selected === null || reply.selectedProtocolVersion !== selected) {
        throw new RuntimePortError('protocol-error');
      }
      return {
        kind: 'connected',
        session: new NodeRuntimeClientSession(
          connection,
          reply.selectedProtocolVersion,
          reply.runtime,
          this.options.randomId,
        ),
      };
    } catch (error) {
      connection.close();
      if (error instanceof RuntimePortError) throw error;
      throw new RuntimePortError('protocol-error');
    }
  }

  private async connectTransport(
    endpoint: RuntimeEndpoint,
    deadlineMs: number,
  ): Promise<RuntimeFrameConnection> {
    try {
      return await this.options.transport.connect(endpoint, deadlineMs);
    } catch (error) {
      const code = (error as RuntimeTransportError | undefined)?.code;
      if (code === 'endpoint-unavailable') {
        throw new RuntimePortError('endpoint-unavailable');
      }
      if (code === 'deadline') throw new RuntimePortError('timeout');
      if (code === 'protocol') throw new RuntimePortError('protocol-error');
      throw new RuntimePortError('connection-failed');
    }
  }
}

class NodeRuntimeClientSession implements RuntimeClientSession {
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: RuntimeFrameConnection,
    private readonly protocolVersion: number,
    private readonly runtimeIdentity: RuntimeIdentityFrame,
    private readonly randomId: () => string,
  ) {}

  queryHealth(deadlineMs = 2_000): Promise<RuntimeHealth> {
    return this.enqueue(async () => {
      const result = await this.request(RUNTIME_HEALTH_OPERATION, {}, null, deadlineMs);
      const health = parseHealthResult(result, this.protocolVersion);
      if (
        health.instanceId !== this.runtimeIdentity.instanceId ||
        health.runtimeVersion !== this.runtimeIdentity.runtimeVersion ||
        health.buildId !== this.runtimeIdentity.buildId ||
        health.startedAt !== this.runtimeIdentity.startedAt
      ) {
        throw new RuntimePortError('protocol-error');
      }
      return health;
    });
  }

  shutdown(request: RuntimeShutdownRequest, deadlineMs = 2_000): Promise<RuntimeShutdownResult> {
    return this.enqueue(async () => {
      const result = await this.request(
        RUNTIME_SHUTDOWN_OPERATION,
        { expectedInstanceId: request.expectedInstanceId, reason: request.reason },
        request.idempotencyKey,
        deadlineMs,
      );
      return parseStoppedResult(result);
    });
  }

  async disconnect(): Promise<void> {
    this.connection.close();
  }

  onDisconnect(listener: () => void): () => void {
    return this.connection.onClose(listener);
  }

  private async request(
    operationName: RuntimeOperationName,
    payload: Record<string, unknown>,
    idempotencyKey: string | null,
    deadlineMs: number,
  ): Promise<Record<string, unknown>> {
    const requestId = this.randomId();
    const correlationId = this.randomId();
    const request: RuntimeRequestFrame = {
      kind: 'runtime.request',
      protocolVersion: this.protocolVersion,
      requestId,
      operation: { name: operationName, version: RUNTIME_OPERATION_VERSION },
      correlationId,
      causationId: null,
      idempotencyKey,
      payload,
    };
    try {
      await this.connection.writeFrame({ ...request }, deadlineMs);
      const response = parseResponseFrame(await this.connection.readFrame(deadlineMs));
      if (
        response.protocolVersion !== this.protocolVersion ||
        response.requestId !== requestId ||
        response.correlationId !== correlationId ||
        response.operation.name !== operationName ||
        response.operation.version !== RUNTIME_OPERATION_VERSION
      ) {
        throw new RuntimePortError('protocol-error');
      }
      if (!response.ok) {
        throw new RuntimePortError(
          response.error.code === 'runtime-stopping' ? 'transport-lost' : 'protocol-error',
        );
      }
      return response.result;
    } catch (error) {
      if (error instanceof RuntimePortError) throw error;
      const code = (error as RuntimeTransportError | undefined)?.code;
      if (code === 'deadline') throw new RuntimePortError('timeout');
      if (code === 'closed') throw new RuntimePortError('transport-lost');
      throw new RuntimePortError('protocol-error');
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation);
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

import type {
  CancelTaskRequest,
  CreateTaskRequest,
  RuntimeHealth,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
  StartTaskRequest,
  TaskExecutionView,
  TaskOutputEvent,
  TaskView,
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
  TASK_CREATE_OPERATION,
  TASK_CANCEL_OPERATION,
  TASK_EXECUTION_OPERATION,
  TASK_LIST_OPERATION,
  TASK_OUTPUT_SUBSCRIBE_OPERATION,
  TASK_START_OPERATION,
  createClientProof,
  selectHighestMutualVersion,
  verifyServerProof,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeIdentityFrame,
  type RuntimeIncompatibleFrame,
  type RuntimeOperationName,
  type RuntimeRequestFrame,
  type RuntimeWelcomeFrame,
} from '../../runtime/protocol';
import {
  parseChallengeFrame,
  parseHandshakeReply,
  parseHealthResult,
  parseResponseFrame,
  parseOutputFrame,
  parseStoppedResult,
  parseTaskExecutionView,
  parseTaskList,
  parseTaskView,
} from '../../runtime/protocol-validation';
import {
  RuntimePortError,
  type RuntimeClientConnectOptions,
  type RuntimeClientConnection,
  type RuntimeClientPort,
  type RuntimeClientSession,
  type RuntimeEndpoint,
} from './runtime-ports';

const TASK_START_DEADLINE_MS = 10_000;

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
      const reply = await this.authenticate(connection, token, options);
      return this.createConnection(connection, reply, endpoint, token, options);
    } catch (error) {
      connection.close();
      if (error instanceof RuntimePortError) throw error;
      throw handshakePortError(error);
    }
  }

  private async authenticate(
    connection: RuntimeFrameConnection,
    token: Uint8Array,
    options: RuntimeClientConnectOptions,
  ): Promise<RuntimeWelcomeFrame | RuntimeIncompatibleFrame> {
    const challenge = parseChallengeFrame(await connection.readFrame(options.deadlineMs));
    const authenticate = this.createAuthenticate(challenge, token, options);
    await connection.writeFrame({ ...authenticate }, options.deadlineMs);
    const reply = parseHandshakeReply(await connection.readFrame(options.deadlineMs));
    if (reply.kind === 'runtime.unauthorized') {
      throw new RuntimePortError('authentication-rejected');
    }
    if (!authenticatedReplyMatches(reply, challenge, authenticate, token)) {
      throw new RuntimePortError('protocol-error');
    }
    return reply;
  }

  private createAuthenticate(
    challenge: RuntimeChallengeFrame,
    token: Uint8Array,
    options: RuntimeClientConnectOptions,
  ): RuntimeAuthenticateFrame {
    const frame: Omit<RuntimeAuthenticateFrame, 'proof'> = {
      kind: 'runtime.authenticate',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: challenge.challengeId,
      requestId: this.options.randomId(),
      clientNonce: this.options.randomNonce(),
      client: options.clientIdentity,
      protocolRange: options.supportedProtocolRange,
    };
    return { ...frame, proof: createClientProof(token, challenge, frame) };
  }

  private createConnection(
    connection: RuntimeFrameConnection,
    reply: RuntimeWelcomeFrame | RuntimeIncompatibleFrame,
    endpoint: RuntimeEndpoint,
    token: Uint8Array,
    options: RuntimeClientConnectOptions,
  ): RuntimeClientConnection {
    const selected = selectHighestMutualVersion(options.supportedProtocolRange, reply.runtimeRange);
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
        (taskId, listener, deadlineMs) =>
          this.openOutputSession(endpoint, token, options, taskId, listener, deadlineMs),
      ),
    };
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

  private async openOutputSession(
    endpoint: RuntimeEndpoint,
    token: Uint8Array,
    options: RuntimeClientConnectOptions,
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
    deadlineMs: number,
  ): Promise<() => void> {
    const connection = await this.connectTransport(endpoint, deadlineMs);
    try {
      const reply = await this.authenticate(connection, token, options);
      if (reply.kind !== 'runtime.welcome') throw new RuntimePortError('protocol-error');
      const request = createOutputSubscribeRequest(
        reply.selectedProtocolVersion,
        this.options.randomId(),
        this.options.randomId(),
        taskId,
      );
      await connection.writeFrame({ ...request }, deadlineMs);
      const acknowledgement = parseResponseFrame(await connection.readFrame(deadlineMs));
      assertOutputSubscriptionAcknowledged(acknowledgement, reply.selectedProtocolVersion, request);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        connection.close();
      };
      void this.readOutput(connection, reply.selectedProtocolVersion, taskId, listener, deadlineMs, close);
      return close;
    } catch (error) {
      connection.close();
      if (error instanceof RuntimePortError) throw error;
      throw handshakePortError(error);
    }
  }

  private async readOutput(
    connection: RuntimeFrameConnection,
    protocolVersion: number,
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
    deadlineMs: number,
    close: () => void,
  ): Promise<void> {
    try {
      while (true) {
        const frame = parseOutputFrame(await connection.readFrame(deadlineMs), protocolVersion);
        if (frame.taskId !== taskId) throw new RuntimePortError('protocol-error');
        listener(frame.event);
      }
    } catch {
      close();
    }
  }
}

function createOutputSubscribeRequest(
  protocolVersion: number,
  requestId: string,
  correlationId: string,
  taskId: string,
): RuntimeRequestFrame {
  return {
    kind: 'runtime.request',
    protocolVersion,
    requestId,
    operation: { name: TASK_OUTPUT_SUBSCRIBE_OPERATION, version: RUNTIME_OPERATION_VERSION },
    correlationId,
    causationId: null,
    idempotencyKey: null,
    payload: { taskId },
  };
}

function assertOutputSubscriptionAcknowledged(
  acknowledgement: ReturnType<typeof parseResponseFrame>,
  protocolVersion: number,
  request: RuntimeRequestFrame,
): void {
  if (!acknowledgement.ok) {
    throw new RuntimePortError(acknowledgement.error.code, acknowledgement.error.retryable);
  }
  if (
    acknowledgement.protocolVersion !== protocolVersion ||
    acknowledgement.requestId !== request.requestId ||
    acknowledgement.correlationId !== request.correlationId ||
    acknowledgement.operation.name !== TASK_OUTPUT_SUBSCRIBE_OPERATION ||
    acknowledgement.result.subscribed !== true
  ) {
    throw new RuntimePortError('protocol-error');
  }
}

function handshakePortError(error: unknown): RuntimePortError {
  const code = (error as RuntimeTransportError | undefined)?.code;
  if (code === 'deadline') return new RuntimePortError('timeout');
  if (code === 'closed') return new RuntimePortError('transport-lost');
  return new RuntimePortError('protocol-error');
}

function authenticatedReplyMatches(
  reply: RuntimeWelcomeFrame | RuntimeIncompatibleFrame,
  challenge: RuntimeChallengeFrame,
  authenticate: RuntimeAuthenticateFrame,
  token: Uint8Array,
): boolean {
  return (
    reply.challengeId === challenge.challengeId &&
    reply.requestId === authenticate.requestId &&
    reply.serverNonce === challenge.serverNonce &&
    reply.clientNonce === authenticate.clientNonce &&
    verifyServerProof(token, reply)
  );
}

class NodeRuntimeClientSession implements RuntimeClientSession {
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly connection: RuntimeFrameConnection,
    private readonly protocolVersion: number,
    private readonly runtimeIdentity: RuntimeIdentityFrame,
    private readonly randomId: () => string,
    private readonly subscribeOutput: (
      taskId: string,
      listener: (event: TaskOutputEvent) => void,
      deadlineMs: number,
    ) => Promise<() => void>,
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

  createTask(request: CreateTaskRequest, deadlineMs = 2_000): Promise<TaskView> {
    return this.enqueue(async () =>
      parseTaskView(
        await this.request(
          TASK_CREATE_OPERATION,
          {
            objective: request.objective,
            project: request.project,
            repository: request.repository,
            baseRef: request.baseRef,
            provider: request.provider,
          },
          request.idempotencyKey,
          deadlineMs,
        ),
      ),
    );
  }

  listTasks(deadlineMs = 2_000): Promise<readonly TaskView[]> {
    return this.enqueue(async () =>
      parseTaskList(await this.request(TASK_LIST_OPERATION, {}, null, deadlineMs)),
    );
  }

  startTask(request: StartTaskRequest, deadlineMs = TASK_START_DEADLINE_MS): Promise<TaskExecutionView> {
    return this.enqueue(async () =>
      parseTaskExecutionView(
        await this.request(
          TASK_START_OPERATION,
          { taskId: request.taskId },
          request.idempotencyKey,
          deadlineMs,
        ),
      ),
    );
  }

  cancelTask(request: CancelTaskRequest, deadlineMs = 2_000): Promise<TaskExecutionView> {
    return this.enqueue(async () =>
      parseTaskExecutionView(
        await this.request(
          TASK_CANCEL_OPERATION,
          { taskId: request.taskId },
          request.idempotencyKey,
          deadlineMs,
        ),
      ),
    );
  }

  getTaskExecution(taskId: string, deadlineMs = 2_000): Promise<TaskExecutionView> {
    return this.enqueue(async () =>
      parseTaskExecutionView(
        await this.request(TASK_EXECUTION_OPERATION, { taskId }, null, deadlineMs),
      ),
    );
  }

  subscribeTaskOutput(
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
    deadlineMs = 2_000,
  ): Promise<() => void> {
    return this.subscribeOutput(taskId, listener, deadlineMs);
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
        throw new RuntimePortError(response.error.code, response.error.retryable);
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

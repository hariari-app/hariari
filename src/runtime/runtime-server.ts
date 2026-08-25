import type { RuntimeProtocolRange, TaskOutputEvent } from '../shared/runtime/runtime-interface';
import {
  RuntimeTransportError,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeLocalTransport,
  type RuntimeTransportListener,
} from './local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_HEALTH_OPERATION,
  RUNTIME_OPERATION_VERSION,
  RUNTIME_SHUTDOWN_OPERATION,
  TASK_CREATE_OPERATION,
  TASK_CANCEL_OPERATION,
  TASK_EXECUTION_OPERATION,
  TASK_TIMELINE_OPERATION,
  TASK_LIST_OPERATION,
  TASK_OUTPUT_SUBSCRIBE_OPERATION,
  TASK_START_OPERATION,
  TASK_RECONCILE_OPERATION,
  TASK_RECOVER_OPERATION,
  PROVIDER_SESSION_FORK_OPERATION,
  PROVIDER_SESSION_RESUME_OPERATION,
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
  RuntimeProtocolValidationError,
  parseAuthenticateFrame,
  parseRequestFrame,
  parseCreateTaskRequest,
  parseCancelTaskRequest,
  parseStartTaskRequest,
  parseProviderSessionActionRequest,
  parseReconcileTaskRequest,
  parseRecoverTaskRequest,
  parseTaskExecutionId,
  parseShutdownRequest,
} from './protocol-validation';
import {
  LocalGenericCliExecutionAdapter,
  type GenericCliExecutionAdapter,
} from './generic-cli-execution-adapter';
import { ClaudeCodeExecutionAdapter } from './claude-code-execution-adapter';
import { ProviderExecutionAdapterRouter } from './provider-execution-adapter-router';
import { TaskExecutionError, TaskExecutionModule } from './task-execution-module';
import { TaskModule } from './task-module';
import { TaskStorageError } from './task-storage-error';

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
  readonly nodeModulesRoot?: string;
  readonly executionAdapter?: GenericCliExecutionAdapter;
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
  private readonly executions: TaskExecutionModule;
  private lifecycle: RuntimeServerLifecycle = { phase: 'idle' };

  constructor(private readonly options: RuntimeServerOptions) {
    this.identity = {
      instanceId: options.randomId(),
      runtimeVersion: options.runtimeVersion,
      buildId: options.buildId,
      startedAt: new Date(options.now()).toISOString(),
    };
    this.tasks = new TaskModule(options.endpoint.runtimeDirectory, options.now, options.randomId);
    this.executions = new TaskExecutionModule(
      this.tasks,
      options.executionAdapter ??
        new ProviderExecutionAdapterRouter({
          shell: new LocalGenericCliExecutionAdapter({
            runtimeDirectory: options.endpoint.runtimeDirectory,
            nodeModulesRoot: options.nodeModulesRoot,
          }),
          claude: new ClaudeCodeExecutionAdapter({
            runtimeDirectory: options.endpoint.runtimeDirectory,
            nodeModulesRoot: options.nodeModulesRoot,
          }),
        }),
      options.randomId,
    );
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
    let failure: unknown;
    try {
      await this.executions.settlePendingExits();
    } catch (error) {
      failure = error;
    }
    try {
      const listener = await ownedListener(owned);
      await listener?.close();
    } catch (error) {
      failure ??= error;
    }
    this.lifecycle = { phase: 'stopped' };
    if (failure) throw failure;
  }

  private async serveConnection(connection: RuntimeFrameConnection): Promise<void> {
    this.connections.add(connection);
    try {
      if (this.isStopping()) return;
      const selectedProtocol = await this.authenticate(connection);
      if (selectedProtocol === null) return;
      while (!this.isStopping()) {
        let frame: Record<string, unknown>;
        try {
          frame = await connection.readFrame(this.options.requestDeadlineMs);
        } catch (error) {
          if (error instanceof RuntimeTransportError && error.code === 'deadline') continue;
          throw error;
        }
        const request = parseRequestFrame(frame);
        if (request.operation.name === TASK_OUTPUT_SUBSCRIBE_OPERATION) {
          await this.serveOutputSubscription(connection, request, selectedProtocol);
          return;
        }
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
      return this.handleHealth(request, protocolVersion);
    }
    if (request.operation.name === TASK_LIST_OPERATION) {
      return this.handleTaskList(request, protocolVersion);
    }
    if (request.operation.name === TASK_CREATE_OPERATION) {
      return this.handleTaskCreate(request, protocolVersion);
    }
    if (request.operation.name === TASK_START_OPERATION) {
      return this.handleExecutionRequest(request, protocolVersion, (parsed, correlationId) =>
        this.executions.start(parsed, correlationId),
      );
    }
    if (request.operation.name === PROVIDER_SESSION_RESUME_OPERATION) {
      return this.handleProviderSessionAction(request, protocolVersion, 'resume');
    }
    if (request.operation.name === PROVIDER_SESSION_FORK_OPERATION) {
      return this.handleProviderSessionAction(request, protocolVersion, 'fork');
    }
    if (request.operation.name === TASK_RECONCILE_OPERATION) {
      return this.handleReconciliation(request, protocolVersion);
    }
    if (request.operation.name === TASK_RECOVER_OPERATION) {
      return this.handleRecovery(request, protocolVersion);
    }
    if (request.operation.name === TASK_CANCEL_OPERATION) {
      return this.handleExecutionRequest(request, protocolVersion, (parsed, correlationId) =>
        this.executions.cancel(parsed, correlationId),
      );
    }
    if (request.operation.name === TASK_EXECUTION_OPERATION) {
      return this.handleTaskExecutionLookup(request, protocolVersion);
    }
    if (request.operation.name === TASK_TIMELINE_OPERATION) {
      return this.handleTaskTimelineLookup(request, protocolVersion);
    }
    return this.handleShutdown(request, protocolVersion);
  }

  private async handleProviderSessionAction(
    request: RuntimeRequestFrame,
    protocolVersion: number,
    action: 'resume' | 'fork',
  ): Promise<RuntimeResponseFrame> {
    try {
      const parsed = parseProviderSessionActionRequest(request);
      const execution = action === 'resume'
        ? await this.executions.resumeProvider(parsed, request.correlationId)
        : await this.executions.forkProvider(parsed, request.correlationId);
      return success(request, protocolVersion, execution as unknown as Record<string, unknown>);
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private async handleReconciliation(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): Promise<RuntimeResponseFrame> {
    try {
      const recovery = await this.executions.reconcile(parseReconcileTaskRequest(request));
      return success(request, protocolVersion, recovery as unknown as Record<string, unknown>);
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private async handleRecovery(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): Promise<RuntimeResponseFrame> {
    try {
      const recovery = await this.executions.recover(parseRecoverTaskRequest(request));
      return success(request, protocolVersion, recovery as unknown as Record<string, unknown>);
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private handleHealth(request: RuntimeRequestFrame, protocolVersion: number): RuntimeResponseFrame {
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

  private handleTaskList(request: RuntimeRequestFrame, protocolVersion: number): RuntimeResponseFrame {
    if (request.idempotencyKey !== null || Object.keys(request.payload).length !== 0) {
      return failure(request, protocolVersion, 'invalid-request', false);
    }
    return success(request, protocolVersion, { tasks: this.tasks.list() });
  }

  private async handleTaskCreate(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): Promise<RuntimeResponseFrame> {
    let taskRequest;
    try {
      taskRequest = parseCreateTaskRequest(request);
    } catch {
      return failure(request, protocolVersion, 'invalid-request', false);
    }
    try {
      const task = await this.tasks.create(taskRequest, request.correlationId);
      return success(request, protocolVersion, task as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof TaskStorageError) {
        return failure(request, protocolVersion, error.code, error.code === 'internal');
      }
      return failure(request, protocolVersion, 'internal', true);
    }
  }

  private handleTaskExecutionLookup(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): RuntimeResponseFrame {
    try {
      const taskId = parseTaskExecutionId(request, TASK_EXECUTION_OPERATION);
      return success(request, protocolVersion, this.executions.get(taskId) as unknown as Record<string, unknown>);
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private handleTaskTimelineLookup(
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): RuntimeResponseFrame {
    try {
      const taskId = parseTaskExecutionId(request, TASK_TIMELINE_OPERATION);
      return success(
        request,
        protocolVersion,
        this.tasks.timeline(taskId) as unknown as Record<string, unknown>,
      );
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private async handleExecutionRequest(
    request: RuntimeRequestFrame,
    protocolVersion: number,
    operation: (
      parsed: { readonly taskId: string; readonly idempotencyKey: string },
      correlationId: string,
    ) => Promise<unknown>,
  ): Promise<RuntimeResponseFrame> {
    try {
      const parsed =
        request.operation.name === TASK_START_OPERATION
          ? parseStartTaskRequest(request)
          : parseCancelTaskRequest(request);
      return success(
        request,
        protocolVersion,
        (await operation(parsed, request.correlationId)) as Record<string, unknown>,
      );
    } catch (error) {
      return executionFailure(request, protocolVersion, error);
    }
  }

  private async serveOutputSubscription(
    connection: RuntimeFrameConnection,
    request: RuntimeRequestFrame,
    protocolVersion: number,
  ): Promise<void> {
    let taskId: string;
    try {
      taskId = parseTaskExecutionId(request, TASK_OUTPUT_SUBSCRIBE_OPERATION);
    } catch {
      await connection.writeFrame(
        failure(request, protocolVersion, 'invalid-request', false),
        this.options.requestDeadlineMs,
      );
      return;
    }
    const writer = new OutputWriter(connection, this.options.requestDeadlineMs);
    const pending: TaskOutputEvent[] = [];
    let acknowledged = false;
    let unsubscribe: (() => void) | null = null;
    try {
      const subscription = this.executions.subscribe(taskId, (event) => {
        if (!acknowledged) {
          pending.push(event);
          return;
        }
        writer.push(event, protocolVersion);
      });
      unsubscribe = subscription.unsubscribe;
      await connection.writeFrame(
        success(request, protocolVersion, { subscribed: true }),
        this.options.requestDeadlineMs,
      );
      acknowledged = true;
      for (const event of subscription.replay) writer.push(event, protocolVersion);
      for (const event of pending) writer.push(event, protocolVersion);
      await writer.settled();
    } catch (error) {
      if (!acknowledged) {
        await connection
          .writeFrame(executionFailure(request, protocolVersion, error), this.options.requestDeadlineMs)
          .catch(() => undefined);
      }
    } finally {
      unsubscribe?.();
    }
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

function executionFailure(
  request: RuntimeRequestFrame,
  protocolVersion: number,
  error: unknown,
): RuntimeResponseFrame {
  if (error instanceof RuntimeProtocolValidationError) {
    return failure(request, protocolVersion, 'invalid-request', false);
  }
  if (error instanceof TaskStorageError) {
    return failure(request, protocolVersion, error.code, error.code === 'internal');
  }
  if (error instanceof TaskExecutionError) {
    return failure(
      request,
      protocolVersion,
      error.code,
      error.code === 'internal' || error.code === 'worktree-unavailable' || error.code === 'process-start-failed',
    );
  }
  return failure(request, protocolVersion, 'internal', true);
}

class OutputWriter {
  private readonly queued: Array<{ readonly event: TaskOutputEvent; readonly protocolVersion: number }> = [];
  private writing = false;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed: () => void = () => undefined;

  constructor(
    private readonly connection: RuntimeFrameConnection,
    private readonly deadlineMs: number,
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    connection.onClose(() => this.close());
  }

  push(event: TaskOutputEvent, protocolVersion: number): void {
    if (this.closed) return;
    this.queued.push({ event, protocolVersion });
    void this.flush();
  }

  settled(): Promise<void> {
    return this.closedPromise;
  }

  private async flush(): Promise<void> {
    if (this.writing || this.closed) return;
    this.writing = true;
    try {
      while (!this.closed && this.queued.length > 0) {
        const next = this.queued.shift();
        if (!next) continue;
        await this.connection.writeFrame(
          {
            kind: 'runtime.output',
            protocolVersion: next.protocolVersion,
            taskId: next.event.taskId,
            event: { ...next.event },
          },
          this.deadlineMs,
        );
      }
    } catch {
      this.connection.close();
    } finally {
      this.writing = false;
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queued.splice(0);
    this.resolveClosed();
  }
}

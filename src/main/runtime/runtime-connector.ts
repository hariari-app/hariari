import type {
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';
import {
  RuntimePortError,
  type RuntimeArtifactPort,
  type RuntimeClientIdentity,
  type RuntimeClientPort,
  type RuntimeClientSession,
  type RuntimeEndpoint,
  type RuntimeEndpointPort,
  type RuntimeProcessPort,
  type RuntimeStartupLease,
  type RuntimeStartupLeasePort,
  type RuntimeTokenPort,
} from './runtime-ports';
import {
  RuntimeConnectionSupervisor,
  type RuntimeSupervisionSchedule,
} from './runtime-connection-supervisor';
import { waitForRuntimeTermination } from './runtime-termination-probe';

export interface RuntimeConnectorDependencies {
  readonly clients: RuntimeClientPort;
  readonly endpoints: RuntimeEndpointPort;
  readonly tokens: RuntimeTokenPort;
  readonly processes: RuntimeProcessPort;
  readonly leases: RuntimeStartupLeasePort;
  readonly artifacts: RuntimeArtifactPort;
  readonly clientIdentity: RuntimeClientIdentity;
  readonly supportedProtocolRange: RuntimeProtocolRange;
  readonly connectDeadlineMs: number;
  readonly startupDeadlineMs: number;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly reconnectDelayMs: number;
  readonly healthPollIntervalMs: number;
  readonly schedule: RuntimeSupervisionSchedule;
}

type ConnectResult =
  | {
      readonly kind: 'connected';
      readonly state: Extract<RuntimeConnectionState, { state: 'connected' }>;
    }
  | {
      readonly kind: 'incompatible';
      readonly state: Extract<RuntimeConnectionState, { state: 'incompatible' }>;
    }
  | { readonly kind: 'failed'; readonly error: RuntimePortError }
  | { readonly kind: 'cancelled' };

class RuntimeConnector implements RuntimeInterface {
  private session: RuntimeClientSession | null = null;
  private removeDisconnectListener: (() => void) | null = null;
  private connectInFlight: {
    readonly generation: number;
    readonly promise: Promise<RuntimeConnectionState>;
  } | null = null;
  private readonly supervisor: RuntimeConnectionSupervisor;

  constructor(private readonly dependencies: RuntimeConnectorDependencies) {
    this.supervisor = new RuntimeConnectionSupervisor({
      reconnectDelayMs: dependencies.reconnectDelayMs,
      healthPollIntervalMs: dependencies.healthPollIntervalMs,
      schedule: dependencies.schedule,
    });
  }

  connectOrStart(): Promise<RuntimeConnectionState> {
    return this.startConnectAttempt(this.supervisor.start());
  }

  private startConnectAttempt(generation: number): Promise<RuntimeConnectionState> {
    if (!this.supervisor.isActive(generation)) {
      return Promise.resolve(this.supervisor.currentState());
    }
    if (this.connectInFlight?.generation === generation) return this.connectInFlight.promise;
    const attempt = this.performConnectOrStart(generation)
      .catch(() =>
        this.supervisor.isActive(generation)
          ? this.supervisor.publishUnavailable('connection-failed', true)
          : this.supervisor.currentState(),
      )
      .then((state) => {
        this.supervise(state, generation);
        return state;
      })
      .finally(() => {
        if (this.connectInFlight?.promise === attempt) this.connectInFlight = null;
      });
    this.connectInFlight = { generation, promise: attempt };
    return attempt;
  }

  async queryHealth(): Promise<RuntimeConnectionState> {
    const generation = this.supervisor.currentGeneration();
    const session = this.session;
    if (!session || generation === null) return this.supervisor.currentState();
    const state = await this.querySessionHealth(session, generation);
    this.supervise(state, generation);
    return state;
  }

  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void {
    return this.supervisor.subscribe(listener);
  }

  async disconnect(): Promise<void> {
    this.supervisor.cancel();
    await this.releaseSession();
    this.supervisor.publish({
      state: 'unavailable',
      reason: 'client-disconnected',
      retryable: true,
    });
  }

  async shutdown(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
    const generation = this.supervisor.suspend();
    if (!this.session) return this.shutdownExisting(request, generation);
    return this.shutdownSession(this.session, request);
  }

  private async performConnectOrStart(generation: number): Promise<RuntimeConnectionState> {
    if (this.session) {
      this.adoptSession(this.session, generation);
      return this.querySessionHealth(this.session, generation);
    }
    const endpoint = await this.dependencies.endpoints.resolve();
    if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
    let token: Uint8Array | null;
    try {
      token = await this.dependencies.tokens.read();
    } catch {
      if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
      return this.supervisor.publishUnavailable('credentials-unavailable', false);
    }

    const existing = await this.tryConnect(endpoint, token, generation);
    if (existing.kind === 'cancelled') return this.supervisor.currentState();
    if (existing.kind !== 'failed') return existing.state;
    if (existing.error.code !== 'endpoint-unavailable') {
      return this.supervisor.publishPortError(existing.error);
    }

    return this.startAndConnect(endpoint, token, generation);
  }

  private async startAndConnect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    generation: number,
  ): Promise<RuntimeConnectionState> {
    const deadlineAt = this.dependencies.now() + this.dependencies.startupDeadlineMs;
    let lease: RuntimeStartupLease | null;
    try {
      lease = await this.dependencies.leases.acquire(deadlineAt);
    } catch {
      if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
      return this.supervisor.publishUnavailable('connection-failed', true);
    }
    if (!this.supervisor.isActive(generation)) {
      await lease?.release().catch(() => undefined);
      return this.supervisor.currentState();
    }
    if (!lease) return this.waitForRuntime(endpoint, token, deadlineAt, generation);

    try {
      const recheck = await this.tryConnect(endpoint, token, generation);
      if (recheck.kind === 'cancelled') return this.supervisor.currentState();
      if (recheck.kind !== 'failed') return recheck.state;
      if (recheck.error.code !== 'endpoint-unavailable') {
        return this.supervisor.publishPortError(recheck.error);
      }

      try {
        token = token ?? (await this.dependencies.tokens.ensure());
      } catch {
        if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
        return this.supervisor.publishUnavailable('credentials-unavailable', false);
      }
      if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();

      try {
        const artifact = await this.dependencies.artifacts.resolve();
        if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
        await this.dependencies.processes.start({ artifact, endpoint });
      } catch (error) {
        if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
        const code = error instanceof RuntimePortError ? error.code : 'start-failed';
        return code === 'artifact-unavailable'
          ? this.supervisor.publishUnavailable('artifact-unavailable', false)
          : this.supervisor.publishUnavailable('start-failed', true);
      }

      return this.waitForRuntime(endpoint, token, deadlineAt, generation);
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  private async waitForRuntime(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    deadlineAt: number,
    generation: number,
  ): Promise<RuntimeConnectionState> {
    do {
      if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
      if (!token) {
        try {
          token = await this.dependencies.tokens.read();
        } catch {
          if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
          return this.supervisor.publishUnavailable('credentials-unavailable', false);
        }
      }
      const result = await this.tryConnect(endpoint, token, generation);
      if (result.kind === 'cancelled') return this.supervisor.currentState();
      if (result.kind !== 'failed') return result.state;
      if (result.error.code !== 'endpoint-unavailable') {
        return this.supervisor.publishPortError(result.error);
      }
      await this.dependencies.delay(25);
    } while (this.dependencies.now() < deadlineAt);
    if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
    return this.supervisor.publishUnavailable('startup-timeout', true);
  }

  private async tryConnect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    generation: number,
  ): Promise<ConnectResult> {
    try {
      const connection = await this.dependencies.clients.connect(endpoint, token, {
        clientIdentity: this.dependencies.clientIdentity,
        supportedProtocolRange: this.dependencies.supportedProtocolRange,
        deadlineMs: this.dependencies.connectDeadlineMs,
      });
      if (!this.supervisor.isActive(generation)) {
        if (connection.kind === 'connected') await connection.session.disconnect();
        return { kind: 'cancelled' };
      }
      if (connection.kind === 'incompatible') {
        const state = this.supervisor.publish({
          state: 'incompatible',
          desktopRange: this.dependencies.supportedProtocolRange,
          runtimeRange: connection.runtimeRange,
          runtimeVersion: connection.runtimeVersion,
          buildId: connection.buildId,
        });
        return { kind: 'incompatible', state };
      }
      this.adoptSession(connection.session, generation);
      const state = await this.querySessionHealth(connection.session, generation);
      if (state.state !== 'connected') {
        return { kind: 'failed', error: new RuntimePortError('timeout') };
      }
      return { kind: 'connected', state };
    } catch (error) {
      if (!this.supervisor.isActive(generation)) return { kind: 'cancelled' };
      const portError =
        error instanceof RuntimePortError ? error : new RuntimePortError('connection-failed');
      return { kind: 'failed', error: portError };
    }
  }

  private adoptSession(session: RuntimeClientSession, generation: number): void {
    this.removeDisconnectListener?.();
    this.session = session;
    this.removeDisconnectListener = session.onDisconnect(() => {
      if (this.session !== session || !this.supervisor.isActive(generation)) return;
      this.session = null;
      this.removeDisconnectListener = null;
      this.supervisor.clearHealthPoll(generation);
      const state = this.supervisor.publishUnavailable('transport-lost', true);
      this.supervise(state, generation);
    });
  }

  private supervise(state: RuntimeConnectionState, generation: number): void {
    if (!this.supervisor.isActive(generation)) return;
    if (state.state === 'connected') {
      this.supervisor.clearRetry(generation);
      this.supervisor.scheduleHealthPoll(generation, () => void this.pollHealth(generation));
      return;
    }
    this.supervisor.clearHealthPoll(generation);
    if (state.state === 'unavailable' && state.retryable) {
      this.supervisor.scheduleRetry(generation, () => void this.startConnectAttempt(generation));
      return;
    }
    this.supervisor.clearRetry(generation);
  }

  private async pollHealth(generation: number): Promise<void> {
    const session = this.session;
    if (!session || !this.supervisor.isActive(generation)) return;
    const state = await this.querySessionHealth(session, generation);
    this.supervise(state, generation);
  }

  private async querySessionHealth(
    session: RuntimeClientSession,
    generation: number,
  ): Promise<RuntimeConnectionState> {
    try {
      const health = await session.queryHealth(this.dependencies.connectDeadlineMs);
      if (!this.supervisor.isActive(generation) || this.session !== session) {
        return this.supervisor.currentState();
      }
      return this.supervisor.publish({ state: 'connected', health });
    } catch (error) {
      return this.handleSessionFailure(session, generation, error, 'health-timeout');
    }
  }

  private async handleSessionFailure(
    session: RuntimeClientSession,
    generation: number,
    error: unknown,
    fallback: 'health-timeout' | 'transport-lost',
  ): Promise<RuntimeConnectionState> {
    await this.releaseSession(session);
    if (!this.supervisor.isActive(generation)) return this.supervisor.currentState();
    const reason =
      error instanceof RuntimePortError && error.code === 'timeout' ? 'health-timeout' : fallback;
    return this.supervisor.publishUnavailable(reason, true);
  }

  private async shutdownExisting(
    request: RuntimeShutdownRequest,
    generation: number,
  ): Promise<RuntimeShutdownResult> {
    const endpoint = await this.dependencies.endpoints.resolve();
    let token: Uint8Array | null;
    try {
      token = await this.dependencies.tokens.read();
    } catch {
      return this.supervisor.publishUnavailable('credentials-unavailable', false);
    }
    const connection = await this.tryConnect(endpoint, token, generation);
    if (connection.kind === 'cancelled') {
      return { state: 'unavailable', reason: 'client-disconnected', retryable: true };
    }
    if (connection.kind === 'incompatible') return connection.state;
    if (connection.kind === 'failed') {
      if (connection.error.code === 'endpoint-unavailable') return { state: 'not-running' };
      return this.supervisor.publishPortError(connection.error);
    }
    if (!this.session) return { state: 'not-running' };
    return this.shutdownSession(this.session, request);
  }

  private async shutdownSession(
    session: RuntimeClientSession,
    request: RuntimeShutdownRequest,
  ): Promise<RuntimeShutdownResult> {
    try {
      const result = await session.shutdown(request, this.dependencies.connectDeadlineMs);
      await this.releaseSession(session);
      if (result.state === 'stopped' && !(await waitForRuntimeTermination(this.dependencies))) {
        return this.supervisor.publishUnavailable('health-timeout', true);
      }
      if (result.state === 'stopped' || result.state === 'not-running') {
        this.supervisor.publishUnavailable('runtime-stopped', false);
      }
      return result;
    } catch (error) {
      return this.supervisor.publishPortError(
        error instanceof RuntimePortError ? error : new RuntimePortError('connection-failed'),
      );
    }
  }

  private async releaseSession(session = this.session): Promise<void> {
    if (!session) return;
    if (this.session === session) {
      this.session = null;
      this.removeDisconnectListener?.();
      this.removeDisconnectListener = null;
    }
    await session.disconnect().catch(() => undefined);
  }
}

export function createRuntimeConnector(
  dependencies: RuntimeConnectorDependencies,
): RuntimeInterface {
  return new RuntimeConnector(dependencies);
}

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
  readonly reconnectDelayMs?: number;
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
  | { readonly kind: 'failed'; readonly error: RuntimePortError };

class RuntimeConnector implements RuntimeInterface {
  private state: RuntimeConnectionState = {
    state: 'unavailable',
    reason: 'not-connected',
    retryable: true,
  };
  private readonly listeners = new Set<(state: RuntimeConnectionState) => void>();
  private session: RuntimeClientSession | null = null;
  private removeDisconnectListener: (() => void) | null = null;
  private connectInFlight: Promise<RuntimeConnectionState> | null = null;
  private manualDisconnect = false;
  private suppressReconnect = false;

  constructor(private readonly dependencies: RuntimeConnectorDependencies) {}

  connectOrStart(): Promise<RuntimeConnectionState> {
    if (this.connectInFlight) return this.connectInFlight;
    this.manualDisconnect = false;
    this.suppressReconnect = false;
    const attempt = this.performConnectOrStart()
      .catch(() => this.publishUnavailable('connection-failed', true))
      .finally(() => {
        if (this.connectInFlight === attempt) this.connectInFlight = null;
      });
    this.connectInFlight = attempt;
    return attempt;
  }

  async queryHealth(): Promise<RuntimeConnectionState> {
    if (!this.session) return this.state;
    try {
      const health = await this.session.queryHealth(this.dependencies.connectDeadlineMs);
      return this.publish({ state: 'connected', health });
    } catch (error) {
      return this.handleSessionFailure(error, 'health-timeout');
    }
  }

  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.suppressReconnect = true;
    await this.releaseSession();
    this.publish({ state: 'unavailable', reason: 'client-disconnected', retryable: true });
  }

  async shutdown(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
    this.suppressReconnect = true;
    if (!this.session) return this.shutdownExisting(request);
    return this.shutdownSession(this.session, request);
  }

  private async performConnectOrStart(): Promise<RuntimeConnectionState> {
    if (this.session) return this.queryHealth();
    const endpoint = await this.dependencies.endpoints.resolve();
    let token: Uint8Array | null;
    try {
      token = await this.dependencies.tokens.read();
    } catch {
      return this.publishUnavailable('credentials-unavailable', false);
    }

    const existing = await this.tryConnect(endpoint, token);
    if (existing.kind !== 'failed') return existing.state;
    if (existing.error.code !== 'endpoint-unavailable') {
      return this.publishPortError(existing.error);
    }

    return this.startAndConnect(endpoint, token);
  }

  private async startAndConnect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
  ): Promise<RuntimeConnectionState> {
    const deadlineAt = this.dependencies.now() + this.dependencies.startupDeadlineMs;
    let lease: RuntimeStartupLease | null;
    try {
      lease = await this.dependencies.leases.acquire(deadlineAt);
    } catch {
      return this.publishUnavailable('connection-failed', true);
    }
    if (!lease) return this.waitForRuntime(endpoint, token, deadlineAt);

    try {
      const recheck = await this.tryConnect(endpoint, token);
      if (recheck.kind !== 'failed') return recheck.state;
      if (recheck.error.code !== 'endpoint-unavailable') {
        return this.publishPortError(recheck.error);
      }

      try {
        token = token ?? (await this.dependencies.tokens.ensure());
      } catch {
        return this.publishUnavailable('credentials-unavailable', false);
      }

      try {
        const artifact = await this.dependencies.artifacts.resolve();
        await this.dependencies.processes.start({ artifact, endpoint });
      } catch (error) {
        const code = error instanceof RuntimePortError ? error.code : 'start-failed';
        return code === 'artifact-unavailable'
          ? this.publishUnavailable('artifact-unavailable', false)
          : this.publishUnavailable('start-failed', true);
      }

      return this.waitForRuntime(endpoint, token, deadlineAt);
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  private async waitForRuntime(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    deadlineAt: number,
  ): Promise<RuntimeConnectionState> {
    do {
      if (!token) {
        try {
          token = await this.dependencies.tokens.read();
        } catch {
          return this.publishUnavailable('credentials-unavailable', false);
        }
      }
      const result = await this.tryConnect(endpoint, token);
      if (result.kind !== 'failed') return result.state;
      if (result.error.code !== 'endpoint-unavailable') return this.publishPortError(result.error);
      await this.dependencies.delay(25);
    } while (this.dependencies.now() < deadlineAt);
    return this.publishUnavailable('startup-timeout', true);
  }

  private async tryConnect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
  ): Promise<ConnectResult> {
    try {
      const connection = await this.dependencies.clients.connect(endpoint, token, {
        clientIdentity: this.dependencies.clientIdentity,
        supportedProtocolRange: this.dependencies.supportedProtocolRange,
        deadlineMs: this.dependencies.connectDeadlineMs,
      });
      if (connection.kind === 'incompatible') {
        const state = this.publish({
          state: 'incompatible',
          desktopRange: this.dependencies.supportedProtocolRange,
          runtimeRange: connection.runtimeRange,
          runtimeVersion: connection.runtimeVersion,
          buildId: connection.buildId,
        });
        return { kind: 'incompatible', state };
      }
      this.adoptSession(connection.session);
      const state = await this.queryHealth();
      if (state.state !== 'connected') {
        return { kind: 'failed', error: new RuntimePortError('timeout') };
      }
      return { kind: 'connected', state };
    } catch (error) {
      const portError =
        error instanceof RuntimePortError ? error : new RuntimePortError('connection-failed');
      return { kind: 'failed', error: portError };
    }
  }

  private adoptSession(session: RuntimeClientSession): void {
    this.removeDisconnectListener?.();
    this.session = session;
    this.removeDisconnectListener = session.onDisconnect(() => {
      if (this.session !== session) return;
      this.session = null;
      this.removeDisconnectListener = null;
      if (this.manualDisconnect || this.suppressReconnect) return;
      this.publishUnavailable('transport-lost', true);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = this.dependencies.reconnectDelayMs ?? 100;
    void this.dependencies
      .delay(delay)
      .then(() => {
        if (!this.manualDisconnect && !this.suppressReconnect) void this.connectOrStart();
      })
      .catch(() => undefined);
  }

  private handleSessionFailure(
    error: unknown,
    fallback: 'health-timeout' | 'transport-lost',
  ): RuntimeConnectionState {
    void this.releaseSession();
    const reason =
      error instanceof RuntimePortError && error.code === 'timeout' ? 'health-timeout' : fallback;
    const state = this.publishUnavailable(reason, true);
    if (!this.manualDisconnect && !this.suppressReconnect) this.scheduleReconnect();
    return state;
  }

  private async shutdownExisting(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
    const endpoint = await this.dependencies.endpoints.resolve();
    let token: Uint8Array | null;
    try {
      token = await this.dependencies.tokens.read();
    } catch {
      return this.publishUnavailable('credentials-unavailable', false);
    }
    const connection = await this.tryConnect(endpoint, token);
    if (connection.kind === 'incompatible') return connection.state;
    if (connection.kind === 'failed') {
      if (connection.error.code === 'endpoint-unavailable') return { state: 'not-running' };
      return this.publishPortError(connection.error);
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
      await this.releaseSession();
      if (result.state === 'stopped' || result.state === 'not-running') {
        this.publishUnavailable('runtime-stopped', false);
      }
      return result;
    } catch (error) {
      return this.publishPortError(
        error instanceof RuntimePortError ? error : new RuntimePortError('connection-failed'),
      );
    }
  }

  private async releaseSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.removeDisconnectListener?.();
    this.removeDisconnectListener = null;
    if (session) await session.disconnect().catch(() => undefined);
  }

  private publishPortError(
    error: RuntimePortError,
  ): Extract<RuntimeConnectionState, { state: 'unavailable' }> {
    switch (error.code) {
      case 'credentials-unavailable':
        return this.publishUnavailable('credentials-unavailable', false);
      case 'authentication-rejected':
        return this.publishUnavailable('authentication-rejected', false);
      case 'artifact-unavailable':
        return this.publishUnavailable('artifact-unavailable', false);
      case 'start-failed':
        return this.publishUnavailable('start-failed', true);
      case 'timeout':
        return this.publishUnavailable('health-timeout', true);
      case 'protocol-error':
        return this.publishUnavailable('protocol-error', false);
      case 'endpoint-unavailable':
      case 'transport-lost':
      default:
        return this.publishUnavailable('connection-failed', true);
    }
  }

  private publishUnavailable(
    reason: Extract<RuntimeConnectionState, { state: 'unavailable' }>['reason'],
    retryable: boolean,
  ): Extract<RuntimeConnectionState, { state: 'unavailable' }> {
    return this.publish({ state: 'unavailable', reason, retryable });
  }

  private publish<T extends RuntimeConnectionState>(state: T): T {
    if (JSON.stringify(this.state) === JSON.stringify(state)) return state;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Observers cannot break the Runtime connection lifecycle.
      }
    }
    return state;
  }
}

export function createRuntimeConnector(
  dependencies: RuntimeConnectorDependencies,
): RuntimeInterface {
  return new RuntimeConnector(dependencies);
}

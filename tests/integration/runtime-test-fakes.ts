import type {
  RuntimeHealth,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../src/shared/runtime/runtime-interface';
import {
  RuntimePortError,
  type RuntimeArtifactPort,
  type RuntimeClientConnectOptions,
  type RuntimeClientPort,
  type RuntimeClientSession,
  type RuntimeEndpoint,
  type RuntimeEndpointPort,
  type RuntimeProcessPort,
  type RuntimeStartupLease,
  type RuntimeStartupLeasePort,
  type RuntimeTokenPort,
} from '../../src/main/runtime/runtime-ports';

const DEFAULT_TOKEN = new Uint8Array(32).fill(7);

export class FakeRuntimeEnvironment {
  readonly endpoint: RuntimeEndpoint = {
    kind: 'unix',
    address: '/tmp/hariari-runtime-test.sock',
    runtimeDirectory: '/tmp/hariari-runtime-test',
  };
  readonly health: RuntimeHealth = {
    status: 'ready',
    instanceId: 'runtime-1',
    runtimeVersion: '0.6.8',
    buildId: 'build-19',
    protocolVersion: 2,
    startedAt: '2026-08-20T10:00:00.000Z',
    checkedAt: '2026-08-20T10:00:01.000Z',
  };
  readonly token = DEFAULT_TOKEN;
  readonly endpoints: RuntimeEndpointPort = { resolve: async () => this.endpoint };
  readonly tokens: RuntimeTokenPort = {
    read: async () => {
      if (this.credentialFailure) throw new Error('credential read failed');
      return this.tokenAvailable ? this.token : null;
    },
    ensure: async () => {
      if (this.credentialFailure) throw new Error('credential create failed');
      this.tokenAvailable = true;
      return this.token;
    },
  };
  readonly artifacts: RuntimeArtifactPort = {
    resolve: async () => {
      if (this.artifactFailure) throw new RuntimePortError('artifact-unavailable');
      return {
        executablePath: '/test/hariari',
        buildId: this.health.buildId,
      };
    },
  };
  readonly processes: RuntimeProcessPort = {
    start: async (request) => {
      this.launchRequests.push(request);
      if (this.startFailure) throw new RuntimePortError('start-failed');
      this.launchCount += 1;
      this.running = true;
    },
  };
  readonly leases: RuntimeStartupLeasePort = {
    acquire: async () => {
      if (this.leaseHeld) return null;
      this.leaseHeld = true;
      let released = false;
      const lease: RuntimeStartupLease = {
        release: async () => {
          if (released) return;
          released = true;
          this.leaseHeld = false;
        },
      };
      return lease;
    },
  };
  readonly clients: RuntimeClientPort = {
    connect: async (_endpoint, token, options) => this.connect(token, options),
  };
  readonly shutdownResults = new Map<string, RuntimeShutdownResult>();
  readonly launchRequests: unknown[] = [];
  serverRange: RuntimeProtocolRange = { min: 1, max: 2 };
  running = false;
  tokenAvailable = true;
  credentialFailure = false;
  authenticationFailure = false;
  connectionFailure = false;
  protocolFailure = false;
  artifactFailure = false;
  startFailure = false;
  healthFailure = false;
  healthQueryCount = 0;
  availabilityFailures = 0;
  launchCount = 0;
  connectCount = 0;
  shutdownCount = 0;
  shutdownLeavesRunning = false;
  nowMs = Date.parse('2026-08-20T10:00:01.000Z');
  private leaseHeld = false;
  private readonly sessions = new Set<FakeRuntimeSession>();

  readonly now = (): number => this.nowMs;
  readonly delay = async (milliseconds: number): Promise<void> => {
    this.nowMs += milliseconds;
  };

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  dropConnections(): void {
    for (const session of [...this.sessions]) session.forceDisconnect();
  }

  private async connect(token: Uint8Array | null, options: RuntimeClientConnectOptions) {
    this.connectCount += 1;
    if (!this.running) {
      throw new RuntimePortError('endpoint-unavailable');
    }
    if (this.availabilityFailures > 0) {
      this.availabilityFailures -= 1;
      throw new RuntimePortError('endpoint-unavailable');
    }
    if (this.connectionFailure) throw new RuntimePortError('connection-failed');
    if (this.authenticationFailure || !tokensEqual(token, this.token)) {
      throw new RuntimePortError('authentication-rejected');
    }
    if (this.protocolFailure) throw new RuntimePortError('protocol-error');
    const selected = Math.min(options.supportedProtocolRange.max, this.serverRange.max);
    if (selected < Math.max(options.supportedProtocolRange.min, this.serverRange.min)) {
      return {
        kind: 'incompatible' as const,
        runtimeRange: this.serverRange,
        runtimeVersion: this.health.runtimeVersion,
        buildId: this.health.buildId,
      };
    }
    const session = new FakeRuntimeSession(this, selected);
    this.sessions.add(session);
    return { kind: 'connected' as const, session };
  }

  removeSession(session: FakeRuntimeSession): void {
    this.sessions.delete(session);
  }
}

class FakeRuntimeSession implements RuntimeClientSession {
  private readonly disconnectListeners = new Set<() => void>();
  private disconnected = false;

  constructor(
    private readonly environment: FakeRuntimeEnvironment,
    private readonly protocolVersion: number,
  ) {}

  async queryHealth(): Promise<RuntimeHealth> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    if (this.environment.healthFailure) throw new RuntimePortError('timeout');
    this.environment.healthQueryCount += 1;
    return { ...this.environment.health, protocolVersion: this.protocolVersion };
  }

  async shutdown(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    if (request.expectedInstanceId !== this.environment.health.instanceId) {
      throw new RuntimePortError('protocol-error');
    }
    const existing = this.environment.shutdownResults.get(request.idempotencyKey);
    if (existing) return existing;
    const result: RuntimeShutdownResult = {
      state: 'stopped',
      instanceId: this.environment.health.instanceId,
    };
    this.environment.shutdownResults.set(request.idempotencyKey, result);
    this.environment.shutdownCount += 1;
    if (!this.environment.shutdownLeavesRunning) this.environment.running = false;
    return result;
  }

  async disconnect(): Promise<void> {
    this.forceDisconnect();
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  forceDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.environment.removeSession(this);
    for (const listener of this.disconnectListeners) listener();
    this.disconnectListeners.clear();
  }
}

function tokensEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(Buffer.from(right));
}

import type {
  CreateTaskRequest,
  RuntimeHealth,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
  TaskView,
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
  type RuntimeProcessLaunch,
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
  health: RuntimeHealth = {
    status: 'ready',
    instanceId: 'runtime-1',
    runtimeVersion: '0.6.8',
    buildId: 'build-19',
    protocolVersion: 2,
    startedAt: '2026-08-20T10:00:00.000Z',
    checkedAt: '2026-08-20T10:00:01.000Z',
  };
  private packagedRuntimeVersion = '0.6.8';
  private packagedBuildId = 'build-19';
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
        runtimeVersion: this.packagedRuntimeVersion,
        buildId: this.packagedBuildId,
      };
    },
  };
  readonly processes: RuntimeProcessPort = {
    start: async (request) => {
      this.launchRequests.push(request);
      if (this.launchedProcessAlive && this.launchedProcess) return this.launchedProcess;
      if (this.startFailure) throw new RuntimePortError('start-failed');
      this.launchCount += 1;
      this.launchedProcessAlive = true;
      if (this.launchMakesReady) {
        this.health = {
          ...this.health,
          instanceId: `runtime-${this.launchCount}`,
          runtimeVersion: request.artifact.runtimeVersion,
          buildId: request.artifact.buildId,
        };
        this.running = true;
      }
      this.launchedProcess = this.createProcessLaunch();
      return this.launchedProcess;
    },
  };
  readonly leases: RuntimeStartupLeasePort = {
    acquire: async () => {
      if (this.leaseHeld) return null;
      this.leaseHeld = true;
      let released = false;
      const lease: RuntimeStartupLease = {
        renew: async () => !released,
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
  readonly tasks = new Map<string, TaskView>();
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
  launchMakesReady = true;
  healthFailure = false;
  healthFailureCode: RuntimePortError['code'] = 'timeout';
  healthQueryCount = 0;
  availabilityFailures = 0;
  launchCount = 0;
  connectCount = 0;
  shutdownCount = 0;
  shutdownLeavesRunning = false;
  nowMs = Date.parse('2026-08-20T10:00:01.000Z');
  private leaseHeld = false;
  private launchedProcessAlive = false;
  private launchedProcess: RuntimeProcessLaunch | null = null;
  private readonly processExitListeners = new Set<() => void>();
  private readonly sessions = new Set<FakeRuntimeSession>();

  readonly now = (): number => this.nowMs;
  readonly delay = async (milliseconds: number): Promise<void> => {
    this.nowMs += milliseconds;
  };

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  setRunningIdentity(runtimeVersion: string, buildId: string, instanceId = 'runtime-old'): void {
    this.health = { ...this.health, runtimeVersion, buildId, instanceId };
  }

  setPackagedIdentity(runtimeVersion: string, buildId: string): void {
    this.packagedRuntimeVersion = runtimeVersion;
    this.packagedBuildId = buildId;
  }

  dropConnections(): void {
    for (const session of [...this.sessions]) session.forceDisconnect();
  }

  exitLaunchedProcess(): void {
    this.launchedProcessAlive = false;
    this.launchedProcess = null;
    this.running = false;
    for (const listener of this.processExitListeners) listener();
    this.processExitListeners.clear();
  }

  private createProcessLaunch(): RuntimeProcessLaunch {
    return {
      terminate: async () => this.exitLaunchedProcess(),
      settled: async () => {
        if (!this.launchedProcessAlive) return;
        await new Promise<void>((resolve) => this.processExitListeners.add(resolve));
      },
    };
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
    if (this.environment.healthFailure) {
      throw new RuntimePortError(this.environment.healthFailureCode);
    }
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
    if (!this.environment.shutdownLeavesRunning) this.environment.exitLaunchedProcess();
    return result;
  }

  async createTask(request: CreateTaskRequest): Promise<TaskView> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    const existing = this.environment.tasks.get(request.idempotencyKey);
    if (existing) return existing;
    const task: TaskView = {
      id: `task-${this.environment.tasks.size + 1}`,
      objective: request.objective,
      project: request.project,
      repository: request.repository,
      baseRef: request.baseRef,
      provider: request.provider,
      createdAt: this.environment.health.checkedAt,
    };
    this.environment.tasks.set(request.idempotencyKey, task);
    return task;
  }

  async listTasks(): Promise<readonly TaskView[]> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    return [...this.environment.tasks.values()];
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

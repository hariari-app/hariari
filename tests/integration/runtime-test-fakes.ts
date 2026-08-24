import type {
  CancelTaskRequest,
  CreateTaskRequest,
  RuntimeHealth,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
  StartTaskRequest,
  ProviderSessionActionRequest,
  TaskExecutionView,
  TaskOutputEvent,
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
import type {
  GenericCliExecution,
  GenericCliExecutionAdapter,
  GenericCliStartRequest,
  ExecutionLaunchPlan,
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
  PrivateExecutionBinding,
  PrivateRecoveryBinding,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  executionStartRequest,
  recoveryObservation,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';

const DEFAULT_TOKEN = new Uint8Array(32).fill(7);

export class ObservedRuntimeTransport extends NodeLocalRuntimeTransport {
  private readonly requestCounts = new Map<string, number>();
  private readonly requestWaiters = new Map<string, Set<() => void>>();
  private readonly responseDrops = new Set<string>();

  override listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    return super.listen(endpoint, (connection) => onConnection(this.observe(connection)));
  }

  waitForRequests(operation: string, count: number): Promise<void> {
    if ((this.requestCounts.get(operation) ?? 0) >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const key = `${operation}:${count}`;
      const waiters = this.requestWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.requestWaiters.set(key, waiters);
    });
  }

  dropNextResponse(operation: string): void {
    this.responseDrops.add(operation);
  }

  private observe(connection: RuntimeFrameConnection): RuntimeFrameConnection {
    return {
      readFrame: async (deadlineMs) => {
        const frame = await connection.readFrame(deadlineMs);
        this.record(frame);
        return frame;
      },
      writeFrame: (frame, deadlineMs) => {
        const operation = responseOperation(frame);
        if (operation && this.responseDrops.delete(operation)) {
          connection.close();
          return Promise.resolve();
        }
        return connection.writeFrame(frame, deadlineMs);
      },
      onClose: (listener) => connection.onClose(listener),
      close: () => connection.close(),
    };
  }

  private record(frame: Record<string, unknown>): void {
    const operation = frame.operation;
    if (!operation || typeof operation !== 'object' || !('name' in operation)) return;
    const name = operation.name;
    if (typeof name !== 'string') return;
    const count = (this.requestCounts.get(name) ?? 0) + 1;
    this.requestCounts.set(name, count);
    const key = `${name}:${count}`;
    for (const resolve of this.requestWaiters.get(key) ?? []) resolve();
    this.requestWaiters.delete(key);
  }
}

function responseOperation(frame: Record<string, unknown>): string | null {
  if (frame.kind !== 'runtime.response') return null;
  const operation = frame.operation;
  if (!operation || typeof operation !== 'object' || !('name' in operation)) return null;
  return typeof operation.name === 'string' ? operation.name : null;
}

/** Deterministic execution Adapter for public-seam Runtime lifecycle tests. */
export class FakeGenericCliExecutionAdapter implements GenericCliExecutionAdapter {
  private readonly executions = new Map<string, FakeGenericCliExecution>();
  private readonly executionsByAttempt = new Map<string, FakeGenericCliExecution>();
  private readonly startCounts = new Map<string, number>();
  private readonly stopCounts = new Map<string, number>();
  private readonly starts = new Map<string, DeferredSignal>();
  private readonly stops = new Map<string, DeferredSignal>();
  private recoveryResources: readonly ExecutionResourceObservation[] | null = null;
  private readonly recoveryObservations = new Map<string, number>();

  constructor(
    private readonly options: {
      readonly autoExitOnStop?: boolean;
      readonly beforeStart?: Promise<void> | ((request: GenericCliStartRequest) => Promise<void> | undefined);
      readonly startError?: (request: GenericCliStartRequest) => Error | undefined;
      readonly stopError?: Error;
      readonly stopReturnsBeforeExit?: boolean;
      readonly claudeCapabilities?: { readonly resume: boolean; readonly fork: boolean };
      readonly providerObservation?: (request: GenericCliStartRequest) => unknown;
    } = {},
    private readonly provider: 'shell' | 'claude' = 'shell',
  ) {}

  async capabilities(_task: TaskView): Promise<{ readonly resume: boolean; readonly fork: boolean }> {
    return this.provider === 'claude'
      ? this.options.claudeCapabilities ?? { resume: true, fork: true }
      : { resume: false, fork: false };
  }

  async observe(binding: PrivateExecutionBinding): Promise<'live' | 'lost' | 'unknown'> {
    const execution = this.executions.get(binding.task.id);
    if (!execution || execution.context.id !== binding.context.id) return 'unknown';
    return execution.isRunning() ? 'live' : 'lost';
  }

  async observeRecovery(binding: PrivateRecoveryBinding): Promise<ExecutionRecoveryObservation> {
    this.recoveryObservations.set(
      binding.task.id,
      this.recoveryObservationCount(binding.task.id) + 1,
    );
    if (this.recoveryResources) return { resources: this.recoveryResources };
    const execution = this.executions.get(binding.task.id);
    return recoveryObservation(
      binding,
      binding.context && execution?.context.id === binding.context.id ? execution : null,
    );
  }

  setRecoveryResources(resources: readonly ExecutionResourceObservation[]): void {
    this.recoveryResources = resources;
  }

  recoveryObservationCount(taskId: string): number {
    return this.recoveryObservations.get(taskId) ?? 0;
  }

  async launch(plan: ExecutionLaunchPlan): Promise<GenericCliExecution> {
    const request = executionStartRequest(plan);
    if (request.task.provider !== this.provider) throw new Error(`unexpected ${request.task.provider} provider`);
    if (plan.kind === 'native-resume') {
      const source = this.executions.get(request.task.id);
      if (source && !source.isRunning()) source.dispose();
    }
    this.requests.push(request);
    this.startCounts.set(request.task.id, this.startCount(request.task.id) + 1);
    this.signalFor(this.starts, request.task.id).resolve();
    const beforeStart = this.options.beforeStart;
    await (typeof beforeStart === 'function' ? beforeStart(request) : beforeStart);
    const startError = this.options.startError?.(request);
    if (startError) throw startError;
    const execution = new FakeGenericCliExecution(
      request,
      this.options.autoExitOnStop ?? true,
      () => {
        this.stopCounts.set(request.task.id, this.stopCount(request.task.id) + 1);
        this.signalFor(this.stops, request.task.id).resolve();
      },
      this.options.claudeCapabilities ?? { resume: true, fork: true },
      this.options.stopError,
      this.options.stopReturnsBeforeExit ?? false,
      this.options.providerObservation,
    );
    this.executions.set(request.task.id, execution);
    this.executionsByAttempt.set(request.attempt.id, execution);
    return execution;
  }

  waitForStart(taskId: string): Promise<void> {
    return this.signalFor(this.starts, taskId).promise;
  }

  startCount(taskId: string): number {
    return this.startCounts.get(taskId) ?? 0;
  }

  stopCount(taskId: string): number {
    return this.stopCounts.get(taskId) ?? 0;
  }

  waitForStop(taskId: string): Promise<void> {
    return this.signalFor(this.stops, taskId).promise;
  }

  emit(taskId: string, data: string): void {
    this.executionFor(taskId).emit(data);
  }

  exit(taskId: string, exitCode = 0): void {
    this.executionFor(taskId).exit(exitCode);
  }

  exitAttempt(attemptId: string, exitCode = 0): void {
    const execution = this.executionsByAttempt.get(attemptId);
    if (!execution) throw new Error(`No fake execution for ${attemptId}`);
    execution.exit(exitCode);
  }

  lose(taskId: string): void {
    this.executionFor(taskId).lose();
  }

  forget(taskId: string): void {
    this.executions.delete(taskId);
  }

  startsFor(taskId: string): readonly GenericCliStartRequest[] {
    return this.requests.filter((request) => request.task.id === taskId);
  }

  hasRunning(taskId: string): boolean {
    return this.executions.get(taskId)?.isRunning() ?? false;
  }

  isDisposed(attemptId: string): boolean {
    return this.executionsByAttempt.get(attemptId)?.isDisposed() ?? true;
  }

  private readonly requests: GenericCliStartRequest[] = [];

  private executionFor(taskId: string): FakeGenericCliExecution {
    const execution = this.executions.get(taskId);
    if (!execution) throw new Error(`No fake execution for ${taskId}`);
    return execution;
  }

  private signalFor(signals: Map<string, DeferredSignal>, taskId: string): DeferredSignal {
    const existing = signals.get(taskId);
    if (existing) return existing;
    const signal = new DeferredSignal();
    signals.set(taskId, signal);
    return signal;
  }
}

/** Dedicated Claude adapter fake for authenticated lifecycle tests. */
export class FakeClaudeCodeExecutionAdapter extends FakeGenericCliExecutionAdapter {
  constructor(options: ConstructorParameters<typeof FakeGenericCliExecutionAdapter>[0] = {}) {
    super(options, 'claude');
  }
}

class DeferredSignal {
  private resolvePromise: () => void = () => undefined;
  readonly promise = new Promise<void>((resolve) => {
    this.resolvePromise = resolve;
  });

  resolve(): void {
    this.resolvePromise();
  }
}

class FakeGenericCliExecution implements GenericCliExecution {
  readonly context: GenericCliExecution['context'];
  readonly providerSession: GenericCliExecution['providerSession'];
  readonly providerObservation: unknown | null;
  private active = false;
  private exitActive = false;
  private exitDelivered = false;
  private exitCode: number | null = null;
  private stopRequested = false;
  private lost = false;
  private disposed = false;
  private resolveExit: () => void = () => undefined;
  private readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    private readonly request: GenericCliStartRequest,
    private readonly autoExitOnStop: boolean,
    private readonly onStop: () => void,
    private readonly claudeCapabilities: { readonly resume: boolean; readonly fork: boolean },
    private readonly stopError: Error | undefined,
    private readonly stopReturnsBeforeExit: boolean,
    private readonly observationFactory: ((request: GenericCliStartRequest) => unknown) | undefined,
  ) {
    this.context = {
      id: request.identities.contextId,
      worktreeId: request.identities.worktreeId,
      branchName: request.instruction.kind === 'new'
        ? `hariari/task-${request.task.id}/run-${request.run.number}/attempt-${request.attempt.number}`
        : request.instruction.context.branchName,
      baseCommit: 'fake-base-commit',
      processId: request.identities.processId,
      ptyId: request.identities.ptyId,
    };
    this.providerSession = request.task.provider === 'claude'
      ? { nativeSessionId: nativeSessionId(request), capabilities: this.claudeCapabilities }
      : null;
    this.providerObservation = request.task.provider === 'claude'
      ? this.requestObservation()
      : null;
  }

  private requestObservation(): unknown {
    if (this.observationFactory) return this.observationFactory(this.request);
    return this.request.task.provider === 'claude'
      ? { provider: 'claude', kind: 'provider-session-observed', sessionState: 'active',
          nativeSessionId: nativeSessionId(this.request), capabilities: this.claudeCapabilities }
      : null;
  }

  isRunning(): boolean {
    return !this.lost && this.exitCode === null;
  }

  lose(): void {
    this.lost = true;
  }

  activateOutput(): void {
    this.active = true;
    this.exitActive = true;
    this.deliverExit();
  }

  activateExit(): void {
    this.exitActive = true;
    this.deliverExit();
  }

  async stop(): Promise<void> {
    if (!this.stopRequested && this.exitCode === null) {
      this.stopRequested = true;
      this.onStop();
      if (this.stopError) throw this.stopError;
      if (this.stopReturnsBeforeExit) {
        this.lost = true;
        return;
      }
      if (this.autoExitOnStop) queueMicrotask(() => this.exit(143));
    }
    await this.exited;
  }

  dispose(): void {
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  emit(data: string): void {
    if (!this.active) throw new Error('Fake output was activated too early');
    this.request.onOutput(data);
  }

  exit(exitCode: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = exitCode;
    this.resolveExit();
    this.deliverExit();
  }

  private deliverExit(): void {
    if (this.exitCode !== null && this.exitActive && !this.exitDelivered) {
      this.exitDelivered = true;
      this.request.onExit(this.exitCode);
    }
  }
}

function nativeSessionId(request: GenericCliStartRequest): string {
  if (request.instruction.kind === 'new') return request.instruction.nativeSessionId ?? `claude-${request.attempt.id}`;
  if (request.instruction.kind === 'resume-claude') return request.instruction.nativeSessionId;
  return `claude-${request.attempt.id}`;
}

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
  readonly executions = new Map<string, TaskExecutionView>();
  readonly executionKeys = new Map<string, { readonly taskId: string; readonly view: TaskExecutionView }>();
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

  async startTask(request: StartTaskRequest): Promise<TaskExecutionView> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    const task = [...this.environment.tasks.values()].find((candidate) => candidate.id === request.taskId);
    if (!task) throw new RuntimePortError('not-found', false);
    const existing = this.environment.executionKeys.get(request.idempotencyKey);
    if (existing) {
      if (existing.taskId === request.taskId) return existing.view;
      throw new RuntimePortError('idempotency-conflict', false);
    }
    const view: TaskExecutionView = {
      task: { ...task, executionState: 'running' },
      run: { id: 'run-1', number: 1 },
      attempt: { id: 'attempt-1', number: 1, state: 'running' },
      attempts: [{ id: 'attempt-1', number: 1, state: 'running' }],
      context: {
        id: 'context-1',
        worktreeId: 'worktree-1',
        branchName: 'hariari/task-1/run-1/attempt-1',
        baseCommit: 'base-1',
      },
      executionContexts: [{
        id: 'context-1', worktreeId: 'worktree-1',
        branchName: 'hariari/task-1/run-1/attempt-1', baseCommit: 'base-1',
      }],
      providerSessions: [],
    };
    this.environment.executions.set(task.id, view);
    this.environment.executionKeys.set(request.idempotencyKey, { taskId: task.id, view });
    return view;
  }

  async resumeProviderSession(_request: ProviderSessionActionRequest): Promise<TaskExecutionView> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async forkProviderSession(_request: ProviderSessionActionRequest): Promise<TaskExecutionView> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async reconcileTask(): Promise<never> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async recoverTask(): Promise<never> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async cancelTask(_request: CancelTaskRequest): Promise<TaskExecutionView> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async getTaskExecution(taskId: string): Promise<TaskExecutionView> {
    if (this.disconnected) throw new RuntimePortError('transport-lost');
    const execution = this.environment.executions.get(taskId);
    if (!execution) throw new RuntimePortError('not-found', false);
    return execution;
  }

  async getTaskTimeline(): Promise<never> {
    throw new RuntimePortError('unsupported-operation', false);
  }

  async subscribeTaskOutput(
    _taskId: string,
    _listener: (event: TaskOutputEvent) => void,
  ): Promise<() => void> {
    throw new RuntimePortError('unsupported-operation', false);
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

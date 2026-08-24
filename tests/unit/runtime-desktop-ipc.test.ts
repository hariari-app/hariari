import { describe, expect, it, vi } from 'vitest';
import type {
  CancelTaskRequest,
  CreateTaskRequest,
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
  StartTaskRequest,
  TaskExecutionView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import { IPC_CHANNELS } from '../../src/shared/constants';
import { registerRuntimeIpc } from '../../src/main/ipc/runtime-ipc';

describe('Desktop Runtime IPC', registerRuntimeIpcTests);

function registerRuntimeIpcTests(): void {
  registerInitialStatusTest();
  registerStatusPublicationTest();
  registerStatusReplayTest();
  registerRegistrationLifecycleTests();
  registerTaskAuthorityTests();
  registerTaskExecutionAuthorityTest();
}

function registerTaskAuthorityTests(): void {
  registerTaskAuthorityProjectionTest();
  registerTaskIdempotencyValidationTest();
  registerTaskLifecycleValidationTest();
}

function registerTaskAuthorityProjectionTest(): void {
  it('exposes only create and list Task authority and sanitizes returned views', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    runtime.tasks = [
      {
        id: 'task-private-id',
        objective: 'Ship durable tasks',
        project: 'Hariari',
        repository: 'hariari-app/hariari',
        baseRef: 'main',
        provider: 'codex',
        createdAt: '2026-08-21T10:00:00.000Z',
        storagePath: '/private/tasks/events.log',
      } as unknown as TaskView,
    ];
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());

    await expect(ipc.invoke(IPC_CHANNELS.TASKS_LIST)).resolves.toEqual([
      {
        id: 'task-private-id',
        objective: 'Ship durable tasks',
        project: 'Hariari',
        repository: 'hariari-app/hariari',
        baseRef: 'main',
        provider: 'codex',
        createdAt: '2026-08-21T10:00:00.000Z',
      },
    ]);
    await expect(
      ipc.invoke(IPC_CHANNELS.TASKS_CREATE, {
        objective: 'New task',
        project: 'Hariari',
        repository: 'hariari-app/hariari',
        baseRef: 'main',
        provider: 'codex',
        idempotencyKey: 'create-task-one',
      }),
    ).resolves.toMatchObject({ objective: 'New task' });
    expect(ipc.channels()).toEqual(taskChannels());
    registration.dispose();
  });
}

function registerTaskExecutionAuthorityTest(): void {
  it('exposes only sanitized Runtime Task lifecycle methods without process control authority', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    runtime.execution = privateExecution();
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());
    const request = { taskId: 'task-private-id', idempotencyKey: 'execution-key' };

    const started = await ipc.invoke(IPC_CHANNELS.TASKS_START, request);
    expect(started).toEqual(publicExecution());
    await expect(ipc.invoke(IPC_CHANNELS.TASKS_CANCEL, request)).resolves.toEqual(
      publicExecution(),
    );
    await expect(ipc.invoke(IPC_CHANNELS.TASKS_EXECUTION, 'task-private-id')).resolves.toEqual(
      publicExecution(),
    );
    expect(runtime.startRequests).toEqual([request]);
    expect(runtime.cancelRequests).toEqual([request]);
    expect(started).not.toHaveProperty('task.storagePath');
    expect(started).not.toHaveProperty('run.privateToken');
    expect(started).not.toHaveProperty('attempt.privatePid');
    expect(started).not.toHaveProperty('context.command');
    expect(started).not.toHaveProperty('context.environment');
    expect(started).not.toHaveProperty('providerSession.nativeSessionId');
    expect(started).not.toHaveProperty('providerSession.token');
    expect(started).not.toHaveProperty('providerSession.cleanup');
    expect(ipc.channels()).toEqual(taskChannels());
    registration.dispose();
  });
}

function registerTaskIdempotencyValidationTest(): void {
  it('rejects an overlong Task idempotency key before calling Runtime', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());

    await expect(
      ipc.invoke(IPC_CHANNELS.TASKS_CREATE, {
        objective: 'New task',
        project: 'Hariari',
        repository: 'hariari-app/hariari',
        baseRef: 'main',
        provider: 'codex',
        idempotencyKey: 'x'.repeat(129),
      }),
    ).rejects.toThrow('Runtime protocol frame is invalid');
    expect(runtime.tasks).toEqual([]);
    registration.dispose();
  });
}

function registerTaskLifecycleValidationTest(): void {
  it('rejects malformed lifecycle requests before they reach Runtime', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());

    await expect(
      ipc.invoke(IPC_CHANNELS.TASKS_START, { taskId: '', idempotencyKey: 'start-key' }),
    ).rejects.toThrow('Runtime protocol frame is invalid');
    await expect(ipc.invoke(IPC_CHANNELS.TASKS_EXECUTION, 'x'.repeat(129))).rejects.toThrow(
      'Runtime protocol frame is invalid',
    );
    expect(runtime.startRequests).toEqual([]);
    registration.dispose();
  });
}

function registerInitialStatusTest(): void {
  it('returns the initial sanitized Runtime status through the public get-status handler', async () => {
    const runtime = new FakeRuntime({
      state: 'connected',
      health: {
        status: 'ready',
        instanceId: 'runtime-private-instance',
        runtimeVersion: '0.6.8',
        buildId: 'private-build-id',
        protocolVersion: 2,
        startedAt: '2026-08-20T10:00:00.000Z',
        checkedAt: '2026-08-20T10:00:01.000Z',
        endpoint: '/private/runtime.sock',
        token: 'private-token',
      },
    } as RuntimeConnectionState);
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());

    await expect(ipc.invoke(IPC_CHANNELS.RUNTIME_GET_STATUS)).resolves.toEqual({
      state: 'connected',
      runtimeVersion: '0.6.8',
      protocolVersion: 2,
    });
    expect(JSON.stringify(await ipc.invoke(IPC_CHANNELS.RUNTIME_GET_STATUS))).not.toContain(
      'private',
    );

    registration.dispose();
  });
}

function registerStatusPublicationTest(): void {
  it('pushes sanitized status changes to the live window publisher', () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const ipc = new FakeIpcRegistry();
    const publishStatus = vi.fn();
    const registration = registerRuntimeIpc(runtime, ipc, publishStatus);

    runtime.publish({
      state: 'incompatible',
      desktopRange: { min: 1, max: 2 },
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: '1.4.0',
      buildId: '/private/runtime/build',
      endpoint: '/private/runtime.sock',
    } as RuntimeConnectionState);

    expect(publishStatus).toHaveBeenCalledWith({
      state: 'incompatible',
      desktopRange: { min: 1, max: 2 },
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: '1.4.0',
    });
    expect(JSON.stringify(publishStatus.mock.calls)).not.toContain('/private');
    registration.dispose();
  });
}

function registerStatusReplayTest(): void {
  it('replays the latest status to a recreated window without reconnecting Runtime', () => {
    const runtime = new FakeRuntime({
      state: 'connected',
      health: {
        status: 'ready',
        instanceId: 'runtime-id',
        runtimeVersion: '0.6.8',
        buildId: 'build-id',
        protocolVersion: 2,
        startedAt: '2026-08-20T10:00:00.000Z',
        checkedAt: '2026-08-20T10:00:01.000Z',
      },
    });
    const publishStatus = vi.fn();
    const registration = registerRuntimeIpc(runtime, new FakeIpcRegistry(), publishStatus);
    publishStatus.mockClear();

    registration.publishLatest();

    expect(publishStatus).toHaveBeenCalledWith({
      state: 'connected',
      runtimeVersion: '0.6.8',
      protocolVersion: 2,
    });
    expect(runtime.connectCalls).toBe(0);
    registration.dispose();
  });
}

function registerRegistrationLifecycleTests(): void {
  it('cleans up subscriptions and handlers and makes disposal idempotent', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const ipc = new FakeIpcRegistry();
    const registration = registerRuntimeIpc(runtime, ipc, vi.fn());

    registration.dispose();
    registration.dispose();

    expect(runtime.unsubscribeCalls).toBe(1);
    await expect(ipc.invoke(IPC_CHANNELS.RUNTIME_GET_STATUS)).rejects.toThrow('missing handler');
  });

  it('replaces duplicate registration without leaking listeners or adding privileged handlers', () => {
    const first = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const second = new FakeRuntime({
      state: 'unavailable',
      reason: 'not-connected',
      retryable: true,
    });
    const ipc = new FakeIpcRegistry();
    const firstRegistration = registerRuntimeIpc(first, ipc, vi.fn());
    const secondRegistration = registerRuntimeIpc(second, ipc, vi.fn());

    expect(first.unsubscribeCalls).toBe(1);
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(1);
    expect(ipc.channels()).toEqual(taskChannels());
    expect(first.connectCalls).toBe(0);
    expect(second.connectCalls).toBe(0);
    expect(
      ipc.channels().some((channel) => /shutdown|process|token|endpoint|path/.test(channel)),
    ).toBe(false);

    firstRegistration.dispose();
    secondRegistration.dispose();
  });
}

class FakeIpcRegistry {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler({}, ...args);
  }

  channels(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

class FakeRuntime implements RuntimeInterface {
  private readonly listeners = new Set<(state: RuntimeConnectionState) => void>();
  connectCalls = 0;
  unsubscribeCalls = 0;
  connectResult: RuntimeConnectionState;
  tasks: TaskView[] = [];
  execution: TaskExecutionView = privateExecution();
  startRequests: StartTaskRequest[] = [];
  cancelRequests: CancelTaskRequest[] = [];

  constructor(private state: RuntimeConnectionState) {
    this.connectResult = state;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async connectOrStart(): Promise<RuntimeConnectionState> {
    this.connectCalls += 1;
    this.state = this.connectResult;
    return this.connectResult;
  }

  async queryHealth(): Promise<RuntimeConnectionState> {
    return this.state;
  }

  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      if (this.listeners.delete(listener)) this.unsubscribeCalls += 1;
    };
  }

  publish(state: RuntimeConnectionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  async disconnect(): Promise<void> {}

  async shutdown(_request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
    return { state: 'not-running' };
  }

  async createTask(request: CreateTaskRequest): Promise<TaskView> {
    const task: TaskView = {
      id: `task-${this.tasks.length + 1}`,
      objective: request.objective,
      project: request.project,
      repository: request.repository,
      baseRef: request.baseRef,
      provider: request.provider,
      createdAt: '2026-08-21T10:00:00.000Z',
    };
    this.tasks.push(task);
    return task;
  }

  async listTasks(): Promise<readonly TaskView[]> {
    return this.tasks;
  }

  async startTask(request: StartTaskRequest): Promise<TaskExecutionView> {
    this.startRequests.push(request);
    return this.execution;
  }

  async resumeProviderSession(): Promise<TaskExecutionView> {
    throw new Error('not exposed through Desktop IPC');
  }

  async forkProviderSession(): Promise<TaskExecutionView> {
    throw new Error('not exposed through Desktop IPC');
  }

  async reconcileTask(): Promise<never> {
    throw new Error('not exposed through Desktop IPC');
  }

  async recoverTask(): Promise<never> {
    throw new Error('not exposed through Desktop IPC');
  }

  async cancelTask(request: CancelTaskRequest): Promise<TaskExecutionView> {
    this.cancelRequests.push(request);
    return this.execution;
  }

  async getTaskExecution(): Promise<TaskExecutionView> {
    return this.execution;
  }

  async subscribeTaskOutput(): Promise<never> {
    throw new Error('not used by desktop IPC tests');
  }
}

function taskChannels(): string[] {
  return [
    IPC_CHANNELS.RUNTIME_GET_STATUS,
    IPC_CHANNELS.TASKS_CREATE,
    IPC_CHANNELS.TASKS_LIST,
    IPC_CHANNELS.TASKS_START,
    IPC_CHANNELS.TASKS_CANCEL,
    IPC_CHANNELS.TASKS_EXECUTION,
  ].sort();
}

function privateExecution(): TaskExecutionView {
  return {
    task: {
      id: 'task-private-id',
      objective: 'Run one Task.',
      project: 'Hariari',
      repository: 'hariari-app/hariari',
      baseRef: 'main',
      provider: 'claude',
      createdAt: '2026-08-21T10:00:00.000Z',
      executionState: 'running',
      storagePath: '/private/tasks/events.log',
    } as TaskExecutionView['task'],
    run: { id: 'run-1', number: 1, privateToken: 'secret' } as TaskExecutionView['run'],
    attempt: {
      id: 'attempt-1',
      number: 1,
      state: 'running',
      privatePid: 42,
    } as TaskExecutionView['attempt'],
    attempts: [{ id: 'attempt-1', number: 1, state: 'running', privatePid: 42 } as NonNullable<TaskExecutionView['attempt']>],
    context: {
      id: 'context-1',
      worktreeId: 'worktree-1',
      branchName: 'hariari/task-1',
      baseCommit: 'base-1',
      processId: 'process-1',
      ptyId: 'pty-1',
      command: 'private command',
      environment: 'private env',
    } as TaskExecutionView['context'],
    executionContexts: [{
      id: 'context-1', worktreeId: 'worktree-1', branchName: 'hariari/task-1',
      baseCommit: 'base-1', processId: 'process-1', ptyId: 'pty-1',
      command: 'private command', environment: 'private env',
    } as NonNullable<TaskExecutionView['context']>],
    providerSession: privateProviderSession(),
    providerSessions: [privateProviderSession()],
  };
}

function publicExecution(): TaskExecutionView {
  return {
    task: {
      id: 'task-private-id',
      objective: 'Run one Task.',
      project: 'Hariari',
      repository: 'hariari-app/hariari',
      baseRef: 'main',
      provider: 'claude',
      createdAt: '2026-08-21T10:00:00.000Z',
      executionState: 'running',
    },
    run: { id: 'run-1', number: 1 },
    attempt: { id: 'attempt-1', number: 1, state: 'running' },
    attempts: [{ id: 'attempt-1', number: 1, state: 'running' }],
    context: {
      id: 'context-1',
      worktreeId: 'worktree-1',
      branchName: 'hariari/task-1',
      baseCommit: 'base-1',
    },
    executionContexts: [{
      id: 'context-1', worktreeId: 'worktree-1', branchName: 'hariari/task-1',
      baseCommit: 'base-1',
    }],
    providerSession: publicProviderSession(),
    providerSessions: [publicProviderSession()],
  };
}

function privateProviderSession(): NonNullable<TaskExecutionView['providerSession']> {
  return {
    id: 'provider-session-1', provider: 'claude', attemptId: 'attempt-1',
    executionContextId: 'context-1', capabilities: { resume: true, fork: true },
    parentId: null, lineage: 'new', nativeSessionId: 'private-native-id',
    token: 'private-token', cleanup: () => undefined,
  } as NonNullable<TaskExecutionView['providerSession']>;
}

function publicProviderSession(): NonNullable<TaskExecutionView['providerSession']> {
  return {
    id: 'provider-session-1', provider: 'claude', attemptId: 'attempt-1',
    executionContextId: 'context-1', capabilities: { resume: true, fork: true },
    parentId: null, lineage: 'new',
  };
}

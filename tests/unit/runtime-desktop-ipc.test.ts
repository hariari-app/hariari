import { describe, expect, it, vi } from 'vitest';
import type {
  CreateTaskRequest,
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
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
}

function registerTaskAuthorityTests(): void {
  registerTaskAuthorityProjectionTest();
  registerTaskIdempotencyValidationTest();
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
    expect(ipc.channels()).toEqual(
      [IPC_CHANNELS.RUNTIME_GET_STATUS, IPC_CHANNELS.TASKS_CREATE, IPC_CHANNELS.TASKS_LIST].sort(),
    );
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
    expect(ipc.channels()).toEqual(
      [IPC_CHANNELS.RUNTIME_GET_STATUS, IPC_CHANNELS.TASKS_CREATE, IPC_CHANNELS.TASKS_LIST].sort(),
    );
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
}

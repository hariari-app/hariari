import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../src/shared/runtime/runtime-interface';
import { IPC_CHANNELS } from '../../src/shared/constants';
import { registerRuntimeIpc } from '../../src/main/ipc/runtime-ipc';

describe('Desktop Runtime IPC', () => {
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

  it('retries through RuntimeInterface and publishes the result', async () => {
    const runtime = new FakeRuntime({
      state: 'unavailable',
      reason: 'connection-failed',
      retryable: true,
    });
    runtime.connectResult = {
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
    };
    const ipc = new FakeIpcRegistry();
    const publishStatus = vi.fn();
    const registration = registerRuntimeIpc(runtime, ipc, publishStatus);

    await expect(ipc.invoke(IPC_CHANNELS.RUNTIME_RETRY)).resolves.toEqual({
      state: 'connected',
      runtimeVersion: '0.6.8',
      protocolVersion: 2,
    });
    expect(runtime.connectCalls).toBe(1);
    expect(publishStatus).toHaveBeenCalledWith({
      state: 'connected',
      runtimeVersion: '0.6.8',
      protocolVersion: 2,
    });
    registration.dispose();
  });

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
    const registration = registerRuntimeIpc(
      runtime,
      new FakeIpcRegistry(),
      publishStatus,
    );
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
    await expect(ipc.invoke(IPC_CHANNELS.RUNTIME_GET_STATUS)).rejects.toThrow(
      'missing handler',
    );
    await expect(ipc.invoke(IPC_CHANNELS.RUNTIME_RETRY)).rejects.toThrow('missing handler');
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
    expect(ipc.channels()).toEqual([
      IPC_CHANNELS.RUNTIME_GET_STATUS,
      IPC_CHANNELS.RUNTIME_RETRY,
    ]);
    expect(ipc.channels().some((channel) => /shutdown|process|token|endpoint|path/.test(channel)))
      .toBe(false);

    firstRegistration.dispose();
    secondRegistration.dispose();
  });
});

class FakeIpcRegistry {
  private readonly handlers = new Map<string, () => unknown>();

  handle(channel: string, handler: () => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(channel: string): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return handler();
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
}

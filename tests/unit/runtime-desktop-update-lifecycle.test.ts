import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../src/shared/runtime/runtime-interface';
import { startDesktopRuntimeLifecycle } from '../../src/main/runtime/runtime-desktop-lifecycle';

vi.mock('../../src/main/runtime/desktop-runtime', () => ({
  createDesktopRuntimeInterface: vi.fn(),
}));
vi.mock('../../src/main/runtime/runtime-package-smoke', () => ({
  RUNTIME_PACKAGE_SMOKE_OK: 'runtime-package-smoke:ok',
  verifyRuntimePackageSmoke: vi.fn(),
}));

describe('Desktop Runtime update lifecycle', () => {
  registersShutdownFenceTest();
  registersUnconfirmedShutdownTest();
  registersOrdinaryDisposalTest();
});

function registersShutdownFenceTest(): void {
  it('uses connected Runtime health as the shutdown fence and awaits endpoint release', async () => {
    const stopped = deferred<RuntimeShutdownResult>();
    const runtime = createRuntime(stopped.promise);
    const lifecycle = startDesktopRuntimeLifecycle({
      runtime,
      ipc: new FakeIpcRegistry(),
      publishStatus: vi.fn(),
    });

    let preparationSettled = false;
    const preparation = lifecycle.prepareForDesktopUpdate().then(() => {
      preparationSettled = true;
    });
    await vi.waitFor(() => expect(runtime.shutdown).toHaveBeenCalledOnce());

    const request = runtime.shutdown.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      expectedInstanceId: 'runtime-instance-19',
      reason: 'desktop-update',
    });
    expect(request?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(preparationSettled).toBe(false);

    stopped.resolve({ state: 'stopped', instanceId: 'runtime-instance-19' });
    await preparation;
    expect(preparationSettled).toBe(true);
    lifecycle.dispose();
  });
}

function registersUnconfirmedShutdownTest(): void {
  it('rejects an unconfirmed shutdown and restores the Runtime connection for retry', async () => {
    const runtime = createRuntime(
      Promise.resolve({ state: 'unavailable', reason: 'stale-instance', retryable: false }),
    );
    const lifecycle = startDesktopRuntimeLifecycle({
      runtime,
      ipc: new FakeIpcRegistry(),
      publishStatus: vi.fn(),
    });

    await expect(lifecycle.prepareForDesktopUpdate()).rejects.toThrow(
      'Runtime shutdown was not confirmed',
    );

    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(runtime.connectOrStart).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
  });
}

function registersOrdinaryDisposalTest(): void {
  it('disconnects without shutting down Runtime during ordinary disposal', () => {
    const runtime = createRuntime(
      Promise.resolve({ state: 'stopped', instanceId: 'runtime-instance-19' }),
    );
    const lifecycle = startDesktopRuntimeLifecycle({
      runtime,
      ipc: new FakeIpcRegistry(),
      publishStatus: vi.fn(),
    });

    lifecycle.dispose();

    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });
}

function createRuntime(shutdownResult: Promise<RuntimeShutdownResult>): RuntimeFake {
  const state: RuntimeConnectionState = {
    state: 'connected',
    health: {
      status: 'ready',
      instanceId: 'runtime-instance-19',
      runtimeVersion: '0.6.8',
      buildId: 'build-19',
      protocolVersion: 1,
      startedAt: '2026-08-20T10:00:00.000Z',
      checkedAt: '2026-08-20T10:00:01.000Z',
    },
  };
  return {
    connectOrStart: vi.fn(async () => state),
    queryHealth: vi.fn(async () => state),
    subscribeStatus: vi.fn((listener) => {
      listener(state);
      return vi.fn();
    }),
    disconnect: vi.fn(async () => undefined),
    shutdown: vi.fn((_request: RuntimeShutdownRequest) => shutdownResult),
    createTask: vi.fn(),
    listTasks: vi.fn(),
    startTask: vi.fn(),
    resumeClaudeSession: vi.fn(),
    forkClaudeSession: vi.fn(),
    cancelTask: vi.fn(),
    getTaskExecution: vi.fn(),
    subscribeTaskOutput: vi.fn(),
  };
}

type RuntimeFake = RuntimeInterface & {
  connectOrStart: ReturnType<typeof vi.fn<RuntimeInterface['connectOrStart']>>;
  queryHealth: ReturnType<typeof vi.fn<RuntimeInterface['queryHealth']>>;
  disconnect: ReturnType<typeof vi.fn<RuntimeInterface['disconnect']>>;
  shutdown: ReturnType<typeof vi.fn<RuntimeInterface['shutdown']>>;
  createTask: ReturnType<typeof vi.fn<RuntimeInterface['createTask']>>;
  listTasks: ReturnType<typeof vi.fn<RuntimeInterface['listTasks']>>;
  startTask: ReturnType<typeof vi.fn<RuntimeInterface['startTask']>>;
  resumeClaudeSession: ReturnType<typeof vi.fn<RuntimeInterface['resumeClaudeSession']>>;
  forkClaudeSession: ReturnType<typeof vi.fn<RuntimeInterface['forkClaudeSession']>>;
  cancelTask: ReturnType<typeof vi.fn<RuntimeInterface['cancelTask']>>;
  getTaskExecution: ReturnType<typeof vi.fn<RuntimeInterface['getTaskExecution']>>;
  subscribeTaskOutput: ReturnType<typeof vi.fn<RuntimeInterface['subscribeTaskOutput']>>;
};

class FakeIpcRegistry {
  private readonly handlers = new Map<string, () => unknown>();

  handle(channel: string, handler: () => unknown): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

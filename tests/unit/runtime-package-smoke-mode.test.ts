import { describe, expect, it, vi } from 'vitest';
import type {
  CreateTaskRequest,
  RuntimeConnectionState,
  RuntimeInterface,
  RuntimeShutdownRequest,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import { verifyRuntimePackageSmoke } from '../../src/main/runtime/runtime-package-smoke';

describe('packaged Desktop Runtime smoke mode', () => {
  it('connects through the Runtime Interface and shuts down the started process', async () => {
    const runtime = new SmokeRuntime(connectedState());

    await expect(verifyRuntimePackageSmoke(runtime)).resolves.toEqual(connectedState());
    expect(runtime.shutdown).toHaveBeenCalledWith({
      idempotencyKey: 'package-smoke-runtime-1',
      expectedInstanceId: 'runtime-1',
      reason: 'test',
    });
    expect(runtime.disconnect).toHaveBeenCalledOnce();
  });

  it('fails unavailable packages and still disconnects the Desktop client', async () => {
    const runtime = new SmokeRuntime({
      state: 'unavailable',
      reason: 'artifact-unavailable',
      retryable: false,
    });

    await expect(verifyRuntimePackageSmoke(runtime)).rejects.toThrow(
      'Packaged Desktop could not connect to Runtime: unavailable',
    );
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(runtime.disconnect).toHaveBeenCalledOnce();
  });
});

class SmokeRuntime implements RuntimeInterface {
  readonly disconnect = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async (request: RuntimeShutdownRequest) => ({
    state: 'stopped' as const,
    instanceId: request.expectedInstanceId,
  }));

  constructor(private readonly state: RuntimeConnectionState) {}

  async connectOrStart(): Promise<RuntimeConnectionState> {
    return this.state;
  }

  async queryHealth(): Promise<RuntimeConnectionState> {
    return this.state;
  }

  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void {
    listener(this.state);
    return () => undefined;
  }

  async createTask(_request: CreateTaskRequest): Promise<TaskView> {
    throw new Error('not used by package smoke');
  }

  async listTasks(): Promise<readonly TaskView[]> {
    return [];
  }

  async startTask(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async resumeProviderSession(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async forkProviderSession(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async reconcileTask(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async recoverTask(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async cancelTask(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async getTaskExecution(): Promise<never> {
    throw new Error('not used by package smoke');
  }

  async subscribeTaskOutput(): Promise<never> {
    throw new Error('not used by package smoke');
  }
}

function connectedState(): RuntimeConnectionState {
  return {
    state: 'connected',
    health: {
      status: 'ready',
      instanceId: 'runtime-1',
      runtimeVersion: '0.6.8',
      buildId: 'build-19',
      protocolVersion: 1,
      startedAt: '2026-08-20T10:00:00.000Z',
      checkedAt: '2026-08-20T10:00:01.000Z',
    },
  };
}

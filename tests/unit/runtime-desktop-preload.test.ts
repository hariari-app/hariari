import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/constants';
import type { RuntimeRendererStatus } from '../../src/shared/ipc-types';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

describe('Desktop Runtime preload API', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('APP_VERSION', '0.6.8');
  });

  it('exposes status reads plus only create/list Task authority', async () => {
    await import('../../src/preload/index');
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as {
      runtime: {
        getStatus(): Promise<unknown>;
        onStatus(callback: (status: RuntimeRendererStatus) => void): () => void;
      };
      tasks: {
        create(request: unknown): Promise<unknown>;
        list(): Promise<unknown>;
      };
    };

    expect(Object.keys(api.runtime).sort()).toEqual(['getStatus', 'onStatus']);
    await api.runtime.getStatus();
    expect(electron.invoke).toHaveBeenCalledOnce();
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.RUNTIME_GET_STATUS);

    const callback = vi.fn();
    const unsubscribe = api.runtime.onStatus(callback);
    const handler = electron.on.mock.calls[0]?.[1] as (
      event: unknown,
      status: RuntimeRendererStatus,
    ) => void;
    const status: RuntimeRendererStatus = {
      state: 'unavailable',
      reason: 'connection-failed',
      retryable: true,
    };
    handler({}, status);
    expect(callback).toHaveBeenCalledWith(status);

    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.RUNTIME_STATUS, handler);
    expect(JSON.stringify(api.runtime)).not.toMatch(/shutdown|process|token|endpoint|path/);

    await api.tasks.create({ objective: 'Create task' });
    await api.tasks.list();
    expect(Object.keys(api.tasks).sort()).toEqual(['create', 'list']);
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_CREATE, {
      objective: 'Create task',
    });
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_LIST);
    expect(JSON.stringify(api.tasks)).not.toMatch(/rebuild|storage|path|runtime/);
  });
});

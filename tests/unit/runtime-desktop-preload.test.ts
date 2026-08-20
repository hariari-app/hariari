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

  it('exposes exactly getStatus, retry, and a removable status listener', async () => {
    await import('../../src/preload/index');
    const api = electron.exposeInMainWorld.mock.calls[0]?.[1] as {
      runtime: {
        getStatus(): Promise<unknown>;
        retry(): Promise<unknown>;
        onStatus(callback: (status: RuntimeRendererStatus) => void): () => void;
      };
    };

    expect(Object.keys(api.runtime).sort()).toEqual(['getStatus', 'onStatus', 'retry']);
    await api.runtime.getStatus();
    await api.runtime.retry();
    expect(electron.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.RUNTIME_GET_STATUS);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.RUNTIME_RETRY);

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
    expect(electron.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.RUNTIME_STATUS,
      handler,
    );
    expect(JSON.stringify(api.runtime)).not.toMatch(/shutdown|process|token|endpoint|path/);
  });
});

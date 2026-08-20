import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/constants';
import { AutoUpdateManager, type AutoUpdaterPort } from '../../src/main/updater/auto-updater';

type IpcHandler = () => unknown;
type UpdaterListener = (value: { version: string }) => void;

const electron = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const listeners = new Map<string, UpdaterListener[]>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: UpdaterListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    }),
    removeAllListeners: vi.fn(() => listeners.clear()),
  };
  return {
    handlers,
    listeners,
    updater,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  };
});

vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: electron.ipcMain }));

describe('Desktop update Runtime shutdown', () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('awaits Runtime preparation before installing and rejects a concurrent trigger', async () => {
    const preparation = deferred<void>();
    const prepareForInstall = vi.fn(() => preparation.promise);
    const manager = new AutoUpdateManager(
      prepareForInstall,
      electron.updater as unknown as AutoUpdaterPort,
    );
    emitUpdateDownloaded();

    const install = invokeInstall();
    await vi.waitFor(() => expect(prepareForInstall).toHaveBeenCalledOnce());
    expect(electron.updater.quitAndInstall).not.toHaveBeenCalled();
    await expect(invokeInstall()).resolves.toEqual({
      ok: false,
      error: 'Install already triggered',
    });

    preparation.resolve();
    await expect(install).resolves.toEqual({ ok: true });
    expect(electron.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    manager.dispose();
  });

  it('keeps the update retryable without installing when Runtime preparation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const manager = createManager(() =>
      Promise.reject(new Error('private endpoint /tmp/runtime.sock token=secret')),
    );
    emitUpdateDownloaded();

    const result = await invokeInstall();

    expect(result).toEqual({
      ok: false,
      error: 'Unable to prepare update installation — try again',
    });
    expect(JSON.stringify(result)).not.toMatch(/endpoint|sock|token|secret/);
    expect(electron.updater.quitAndInstall).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('allows installation to be retried after Runtime preparation recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prepareForInstall = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('shutdown failed'))
      .mockResolvedValueOnce(undefined);
    const manager = createManager(prepareForInstall);
    emitUpdateDownloaded();

    await expect(invokeInstall()).resolves.toMatchObject({ ok: false });
    await expect(invokeInstall()).resolves.toEqual({ ok: true });

    expect(prepareForInstall).toHaveBeenCalledTimes(2);
    expect(electron.updater.quitAndInstall).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not install a downloaded update during an ordinary app quit', () => {
    const manager = createManager(() => Promise.resolve());
    emitUpdateDownloaded();

    expect(electron.updater.autoInstallOnAppQuit).toBe(false);
    manager.dispose();
  });
});

function createManager(prepareForInstall: () => Promise<void>): AutoUpdateManager {
  return new AutoUpdateManager(prepareForInstall, electron.updater as unknown as AutoUpdaterPort);
}

function emitUpdateDownloaded(): void {
  for (const listener of electron.listeners.get('update-downloaded') ?? []) {
    listener({ version: '0.6.9' });
  }
}

async function invokeInstall(): Promise<unknown> {
  const handler = electron.handlers.get(IPC_CHANNELS.UPDATE_INSTALL);
  if (!handler) throw new Error('Update install handler was not registered');
  return handler();
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

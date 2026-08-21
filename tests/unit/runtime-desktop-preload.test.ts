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

describe('Desktop Runtime preload API', registerPreloadTests);

function registerPreloadTests(): void {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('APP_VERSION', '0.6.8');
  });
  registerPreloadAuthorityTest();
}

function registerPreloadAuthorityTest(): void {
  it('exposes status reads plus only narrow Task lifecycle authority', async () => {
    const api = await exposedApi();
    await assertRuntimeAuthority(api);
    await assertTaskAuthority(api);
  });
}

interface ExposedApi {
  readonly runtime: {
    getStatus(): Promise<unknown>;
    onStatus(callback: (status: RuntimeRendererStatus) => void): () => void;
  };
  readonly tasks: {
    create(request: unknown): Promise<unknown>;
    list(): Promise<unknown>;
    start(request: unknown): Promise<unknown>;
    cancel(request: unknown): Promise<unknown>;
    execution(taskId: string): Promise<unknown>;
  };
}

async function exposedApi(): Promise<ExposedApi> {
  await import('../../src/preload/index');
  return electron.exposeInMainWorld.mock.calls[0]?.[1] as ExposedApi;
}

async function assertRuntimeAuthority(api: ExposedApi): Promise<void> {
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
}

async function assertTaskAuthority(api: ExposedApi): Promise<void> {
  await api.tasks.create({ objective: 'Create task' });
  await api.tasks.list();
  await api.tasks.start({ taskId: 'task-1', idempotencyKey: 'start-one' });
  await api.tasks.cancel({ taskId: 'task-1', idempotencyKey: 'cancel-one' });
  await api.tasks.execution('task-1');
  expect(Object.keys(api.tasks).sort()).toEqual(['cancel', 'create', 'execution', 'list', 'start']);
  expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_CREATE, {
    objective: 'Create task',
  });
  expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_LIST);
  expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_START, {
    taskId: 'task-1',
    idempotencyKey: 'start-one',
  });
  expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_CANCEL, {
    taskId: 'task-1',
    idempotencyKey: 'cancel-one',
  });
  expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TASKS_EXECUTION, 'task-1');
  expect(JSON.stringify(api.tasks)).not.toMatch(
    /rebuild|storage|path|runtime|shutdown|process|pty|command|env|cleanup/,
  );
}

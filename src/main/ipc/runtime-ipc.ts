import { IPC_CHANNELS } from '../../shared/constants';
import type { RuntimeRendererStatus } from '../../shared/ipc-types';
import type {
  RuntimeConnectionState,
  RuntimeInterface,
  TaskView,
} from '../../shared/runtime/runtime-interface';
import { parseTaskRequest } from '../../runtime/protocol-validation';

export interface RuntimeIpcRegistry {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface RuntimeIpcRegistration {
  publishLatest(): void;
  dispose(): void;
}

const activeRegistrations = new WeakMap<RuntimeIpcRegistry, RuntimeIpcRegistration>();

export function registerRuntimeIpc(
  runtime: RuntimeInterface,
  ipc: RuntimeIpcRegistry,
  publishStatus: (status: RuntimeRendererStatus) => void,
): RuntimeIpcRegistration {
  activeRegistrations.get(ipc)?.dispose();

  let disposed = false;
  let latest: RuntimeRendererStatus = {
    state: 'unavailable',
    reason: 'not-connected',
    retryable: true,
  };

  const acceptStatus = (state: RuntimeConnectionState, publish: boolean): RuntimeRendererStatus => {
    const status = sanitizeRuntimeStatus(state);
    const changed = JSON.stringify(status) !== JSON.stringify(latest);
    latest = status;
    if (!disposed && publish && changed) publishStatus(status);
    return status;
  };

  const unsubscribe = runtime.subscribeStatus((state) => acceptStatus(state, true));

  ipc.removeHandler(IPC_CHANNELS.RUNTIME_GET_STATUS);
  ipc.handle(IPC_CHANNELS.RUNTIME_GET_STATUS, () => latest);
  ipc.removeHandler(IPC_CHANNELS.TASKS_CREATE);
  ipc.handle(IPC_CHANNELS.TASKS_CREATE, async (_event, raw) =>
    sanitizeTask(await runtime.createTask(parseTaskRequest(raw))),
  );
  ipc.removeHandler(IPC_CHANNELS.TASKS_LIST);
  ipc.handle(IPC_CHANNELS.TASKS_LIST, async () => (await runtime.listTasks()).map(sanitizeTask));

  const registration: RuntimeIpcRegistration = {
    publishLatest: () => {
      if (!disposed) publishStatus(latest);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      ipc.removeHandler(IPC_CHANNELS.RUNTIME_GET_STATUS);
      ipc.removeHandler(IPC_CHANNELS.TASKS_CREATE);
      ipc.removeHandler(IPC_CHANNELS.TASKS_LIST);
      if (activeRegistrations.get(ipc) === registration) {
        activeRegistrations.delete(ipc);
      }
    },
  };

  activeRegistrations.set(ipc, registration);
  return registration;
}

function sanitizeTask(task: TaskView): TaskView {
  return {
    id: task.id,
    objective: task.objective,
    project: task.project,
    repository: task.repository,
    baseRef: task.baseRef,
    provider: task.provider,
    createdAt: task.createdAt,
  };
}

function sanitizeRuntimeStatus(state: RuntimeConnectionState): RuntimeRendererStatus {
  switch (state.state) {
    case 'connected':
      return {
        state: 'connected',
        runtimeVersion: state.health.runtimeVersion,
        protocolVersion: state.health.protocolVersion,
      };
    case 'unavailable':
      return {
        state: 'unavailable',
        reason: state.reason,
        retryable: state.retryable,
      };
    case 'incompatible':
      return {
        state: 'incompatible',
        desktopRange: { min: state.desktopRange.min, max: state.desktopRange.max },
        runtimeRange: { min: state.runtimeRange.min, max: state.runtimeRange.max },
        runtimeVersion: state.runtimeVersion,
      };
  }
}

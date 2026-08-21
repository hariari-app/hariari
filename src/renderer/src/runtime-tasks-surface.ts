import { mountRuntimeHealth, type RuntimeHealthApi } from './runtime-health';
import { mountTasksView, type TasksApi } from './tasks-view';

interface RuntimeTasksApi {
  readonly runtime: RuntimeHealthApi;
  readonly tasks: TasksApi;
}

/** Mounts the Runtime status and Task controls, keeping entrypoint wiring disposable. */
export function mountRuntimeTasksSurface(
  runtimeHealthHost: HTMLElement,
  sidebar: HTMLElement,
  api: RuntimeTasksApi,
): () => void {
  const disposeRuntimeHealth = mountRuntimeHealth(runtimeHealthHost, api.runtime);
  const tasksHost = document.createElement('div');
  tasksHost.className = 'tasks-view-host';
  sidebar.querySelector('.sidebar-expanded-content')?.appendChild(tasksHost);
  const disposeTasksView = mountTasksView(tasksHost, api.tasks);
  return () => {
    disposeRuntimeHealth();
    disposeTasksView();
  };
}

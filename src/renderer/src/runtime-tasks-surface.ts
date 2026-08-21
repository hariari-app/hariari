import { mountRuntimeHealth, type RuntimeHealthApi } from './runtime-health';
import { mountTasksView, type TasksApi } from './tasks-view';

/** Mounts the Runtime status and Task controls, keeping entrypoint wiring disposable. */
export function mountRuntimeTasksSurface(
  runtimeHealthHost: HTMLElement,
  sidebar: HTMLElement,
  runtime: RuntimeHealthApi,
  tasks: TasksApi,
): () => void {
  const disposeRuntimeHealth = mountRuntimeHealth(runtimeHealthHost, runtime);
  const tasksHost = document.createElement('div');
  tasksHost.className = 'tasks-view-host';
  sidebar.querySelector('.sidebar-expanded-content')?.appendChild(tasksHost);
  const disposeTasksView = mountTasksView(tasksHost, tasks);
  return () => {
    disposeRuntimeHealth();
    disposeTasksView();
  };
}

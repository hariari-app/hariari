import {
  TASK_PROVIDERS,
  type CancelTaskRequest,
  type CreateTaskRequest,
  type StartTaskRequest,
  type TaskExecutionView,
  type TaskView,
} from '../../shared/runtime/runtime-interface';
import { TaskExecutionPoller, taskExecutionModel } from './task-execution-model';
import './styles/tasks-view.css';

export interface TasksApi {
  create(request: CreateTaskRequest): Promise<TaskView>;
  list(): Promise<readonly TaskView[]>;
  start(request: StartTaskRequest): Promise<TaskExecutionView>;
  cancel(request: CancelTaskRequest): Promise<TaskExecutionView>;
  execution(taskId: string): Promise<TaskExecutionView>;
}

interface TaskElements {
  readonly root: HTMLElement;
  readonly list: HTMLUListElement;
  readonly form: HTMLFormElement;
  readonly fields: {
    readonly objective: HTMLInputElement;
    readonly project: HTMLInputElement;
    readonly repository: HTMLInputElement;
    readonly baseRef: HTMLInputElement;
  };
  readonly provider: HTMLSelectElement;
  readonly submit: HTMLButtonElement;
  readonly message: HTMLElement;
}

/** A thin renderer: Runtime remains the sole source of Task state. */
export function mountTasksView(container: HTMLElement, tasks: TasksApi): () => void {
  const view = createTaskElements();
  container.appendChild(view.root);
  let disposed = false;
  let latest: readonly TaskExecutionView[] = [];
  const refresh = async (): Promise<void> => {
    try {
      const views = await loadTaskExecutions(tasks);
      if (disposed) return;
      latest = views;
      renderTasks(view.list, views, tasks, refresh, view.message);
      poller.update(views);
    } catch {
      if (!disposed) view.message.textContent = 'Task execution could not be updated.';
      poller.update(latest);
    }
  };
  const poller = new TaskExecutionPoller(refresh);
  void refresh();
  view.form.addEventListener('submit', (event) => submitTask(event, view, tasks, refresh));
  return () => {
    disposed = true;
    poller.dispose();
    view.root.remove();
  };
}

function createTaskElements(): TaskElements {
  const root = document.createElement('section');
  root.className = 'tasks-view';
  root.setAttribute('aria-label', 'Tasks');
  const title = document.createElement('h2');
  title.textContent = 'Tasks';
  const list = document.createElement('ul');
  list.className = 'tasks-list';
  const form = document.createElement('form');
  form.className = 'tasks-form';
  const fields = {
    objective: field('Objective', 'objective'),
    project: field('Project', 'project'),
    repository: field('Repository', 'repository'),
    baseRef: field('Base ref', 'baseRef'),
  };
  const provider = createProvider();
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Create Task';
  const message = document.createElement('p');
  message.className = 'tasks-message';
  message.setAttribute('role', 'status');
  form.append(...Object.values(fields), provider, submit, message);
  root.append(title, list, form);
  return { root, list, form, fields, provider, submit, message };
}

function createProvider(): HTMLSelectElement {
  const provider = document.createElement('select');
  provider.name = 'provider';
  provider.setAttribute('aria-label', 'Provider');
  for (const value of TASK_PROVIDERS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === 'codex') option.selected = true;
    provider.appendChild(option);
  }
  return provider;
}

async function loadTaskExecutions(tasks: TasksApi): Promise<readonly TaskExecutionView[]> {
  const taskViews = await tasks.list();
  return Promise.all(taskViews.map((task) => tasks.execution(task.id)));
}

function submitTask(
  event: SubmitEvent,
  view: TaskElements,
  tasks: TasksApi,
  refresh: () => Promise<void>,
): void {
  event.preventDefault();
  view.submit.disabled = true;
  view.message.textContent = '';
  void tasks
    .create(taskRequest(view))
    .then(async () => {
      view.form.reset();
      view.provider.value = 'codex';
      await refresh();
    })
    .catch(() => {
      view.message.textContent = 'Task could not be created.';
    })
    .finally(() => {
      view.submit.disabled = false;
    });
}

function taskRequest(view: TaskElements): CreateTaskRequest {
  return {
    objective: view.fields.objective.value,
    project: view.fields.project.value,
    repository: view.fields.repository.value,
    baseRef: view.fields.baseRef.value,
    provider: view.provider.value as CreateTaskRequest['provider'],
    idempotencyKey: crypto.randomUUID(),
  };
}

function renderTasks(
  list: HTMLUListElement,
  views: readonly TaskExecutionView[],
  tasks: TasksApi,
  refresh: () => Promise<void>,
  message: HTMLElement,
): void {
  list.replaceChildren(
    ...views.map((execution) => taskElement(execution, tasks, refresh, message)),
  );
}

function field(labelText: string, name: string): HTMLInputElement {
  const input = document.createElement('input');
  input.name = name;
  input.placeholder = labelText;
  input.required = true;
  input.maxLength = 512;
  input.setAttribute('aria-label', labelText);
  return input;
}

function taskElement(
  execution: TaskExecutionView,
  tasks: TasksApi,
  refresh: () => Promise<void>,
  message: HTMLElement,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'tasks-item';
  const task = execution.task;
  const model = taskExecutionModel(execution);
  const details = document.createElement('span');
  details.textContent = `${task.objective} · ${task.provider} · ${task.project} · ${model.summary}`;
  item.appendChild(details);
  if (model.action) item.appendChild(taskAction(model.action, task.id, tasks, refresh, message));
  return item;
}

function taskAction(
  action: Exclude<ReturnType<typeof taskExecutionModel>['action'], null>,
  taskId: string,
  tasks: TasksApi,
  refresh: () => Promise<void>,
  message: HTMLElement,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tasks-action';
  button.textContent = action === 'start' ? 'Start' : 'Cancel';
  button.addEventListener('click', () => {
    button.disabled = true;
    message.textContent = '';
    const request = { taskId, idempotencyKey: crypto.randomUUID() };
    const operation = action === 'start' ? tasks.start(request) : tasks.cancel(request);
    void operation.then(refresh).catch(() => {
      message.textContent = 'Task execution could not be updated.';
    });
  });
  return button;
}

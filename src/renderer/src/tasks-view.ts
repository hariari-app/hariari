import {
  TASK_PROVIDERS,
  type CreateTaskRequest,
  type TaskView,
} from '../../shared/runtime/runtime-interface';
import './styles/tasks-view.css';

export interface TasksApi {
  create(request: CreateTaskRequest): Promise<TaskView>;
  list(): Promise<readonly TaskView[]>;
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
  loadTasks(view.list, view.message, tasks);
  view.form.addEventListener('submit', (event) => submitTask(event, view, tasks));
  return () => view.root.remove();
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

function loadTasks(list: HTMLUListElement, message: HTMLElement, tasks: TasksApi): void {
  void tasks
    .list()
    .then((views) => renderTasks(list, views))
    .catch(() => {
      message.textContent = 'Tasks are unavailable.';
    });
}

function submitTask(event: SubmitEvent, view: TaskElements, tasks: TasksApi): void {
  event.preventDefault();
  view.submit.disabled = true;
  view.message.textContent = '';
  void tasks
    .create(taskRequest(view))
    .then(async () => {
      view.form.reset();
      view.provider.value = 'codex';
      renderTasks(view.list, await tasks.list());
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

function renderTasks(list: HTMLUListElement, views: readonly TaskView[]): void {
  list.replaceChildren(...views.map((task) => taskElement(task)));
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

function taskElement(task: TaskView): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'tasks-item';
  item.textContent = `${task.objective} · ${task.provider} · ${task.project}`;
  return item;
}

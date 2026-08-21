import {
  TASK_PROVIDERS,
  type CreateTaskRequest,
  type TaskView,
} from '../../shared/runtime/runtime-interface';

export interface TasksApi {
  create(request: CreateTaskRequest): Promise<TaskView>;
  list(): Promise<readonly TaskView[]>;
}

/** A thin renderer: Runtime remains the sole source of Task state. */
export function mountTasksView(container: HTMLElement, tasks: TasksApi): () => void {
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
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Create Task';
  const message = document.createElement('p');
  message.className = 'tasks-message';
  message.setAttribute('role', 'status');
  form.append(...Object.values(fields), provider, submit, message);
  root.append(title, list, form);
  container.appendChild(root);

  const render = (views: readonly TaskView[]): void => {
    list.replaceChildren(...views.map((task) => taskElement(task)));
  };
  void tasks
    .list()
    .then(render)
    .catch(() => {
      message.textContent = 'Tasks are unavailable.';
    });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const request: CreateTaskRequest = {
      objective: fields.objective.value,
      project: fields.project.value,
      repository: fields.repository.value,
      baseRef: fields.baseRef.value,
      provider: provider.value as CreateTaskRequest['provider'],
      idempotencyKey: crypto.randomUUID(),
    };
    submit.disabled = true;
    message.textContent = '';
    void tasks
      .create(request)
      .then(async () => {
        form.reset();
        provider.value = 'codex';
        render(await tasks.list());
      })
      .catch(() => {
        message.textContent = 'Task could not be created.';
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  return () => root.remove();
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountTasksView, type TasksApi } from '../../src/renderer/src/tasks-view';
import type {
  TaskExecutionState,
  TaskExecutionView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';

describe('Runtime Tasks renderer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refreshes durable failed state after a rejected start and keeps the error sanitized', async () => {
    const documentRef = new FakeDocument();
    vi.stubGlobal('document', documentRef);
    const container = documentRef.createElement('div');
    const subject = createTasksSubject();
    const dispose = mountTasksView(container as unknown as HTMLElement, subject.tasks);

    await vi.waitFor(() =>
      expect(findByClass(container, 'tasks-action')?.textContent).toBe('Start'),
    );
    findByClass(container, 'tasks-action')?.click();
    await vi.waitFor(() => expect(taskDetails(container)).toContain('failed'));

    expect(findByClass(container, 'tasks-message')?.textContent).toBe(
      'Task execution could not be updated.',
    );
    expect(findByClass(container, 'tasks-action')).toBeNull();
    expect(subject.start).toHaveBeenCalledOnce();
    dispose();
    expect(container.children).toHaveLength(0);
  });
});

function createTasksSubject(): {
  readonly tasks: TasksApi;
  readonly start: ReturnType<typeof vi.fn<TasksApi['start']>>;
} {
  const task = taskView();
  let execution = executionView(task, 'ready');
  const start = vi.fn<TasksApi['start']>(async () => {
    execution = executionView(task, 'failed');
    throw new Error('sensitive adapter failure');
  });
  return {
    start,
    tasks: {
      create: vi.fn(),
      list: async () => [task],
      start,
      cancel: vi.fn(),
      execution: async () => execution,
    },
  };
}

function taskView(): TaskView {
  return {
    id: 'task-1',
    objective: 'Render authoritative failure.',
    project: 'Hariari',
    repository: 'hariari-app/hariari',
    baseRef: 'main',
    provider: 'shell',
    createdAt: '2026-08-21T10:00:00.000Z',
  };
}

function executionView(task: TaskView, state: TaskExecutionState): TaskExecutionView {
  return {
    task: { ...task, executionState: state },
    run: state === 'ready' ? null : { id: 'run-1', number: 1 },
    attempt: state === 'ready' ? null : { id: 'attempt-1', number: 1, state },
    context: null,
  };
}

type FakeListener = (event: { preventDefault(): void }) => void;

class FakeDocument {
  createElement(_tagName: string): FakeElement {
    return new FakeElement();
  }
}

class FakeElement {
  className = '';
  textContent = '';
  value = '';
  name = '';
  placeholder = '';
  type = '';
  disabled = false;
  required = false;
  selected = false;
  maxLength = 0;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, FakeListener[]>();
  private parent: FakeElement | null = null;

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.splice(0);
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get('click') ?? []) {
      listener({ preventDefault: () => undefined });
    }
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className === className) return root;
  for (const child of root.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

function taskDetails(container: FakeElement): string {
  return findByClass(container, 'tasks-item')?.children[0]?.textContent ?? '';
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountTasksView, type TasksApi } from '../../src/renderer/src/tasks-view';
import type {
  TaskExecutionState,
  TaskExecutionView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';

describe('Runtime Tasks renderer', registerTasksViewTests);

function registerTasksViewTests(): void {
  afterEach(() => vi.unstubAllGlobals());
  registerRejectedStartTest();
  registerAmbiguousLifecycleTests();
  registerDisposalTest();
}

function registerRejectedStartTest(): void {
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
}

function registerAmbiguousLifecycleTests(): void {
  it.each([
    { operation: 'start' as const, staleLabel: 'Start', authoritativeLabel: 'Cancel' },
    { operation: 'cancel' as const, staleLabel: 'Cancel', authoritativeLabel: null },
  ])(
    'keeps an ambiguous $operation control disabled until an authoritative retry rerenders it',
    async (testCase) => {
      const documentRef = new FakeDocument();
      const timers = new FakeTimers();
      vi.stubGlobal('document', documentRef);
      vi.stubGlobal('setTimeout', timers.setTimeout);
      vi.stubGlobal('clearTimeout', timers.clearTimeout);
      const container = documentRef.createElement('div');
      const subject = createAmbiguousTasksSubject(testCase.operation);
      const dispose = mountTasksView(container as unknown as HTMLElement, subject.tasks);
      await nextTurn();
      const staleAction = findByClass(container, 'tasks-action');

      staleAction?.click();
      await nextTurn();

      expect(staleAction?.textContent).toBe(testCase.staleLabel);
      expect(staleAction?.disabled).toBe(true);
      expect(timers.delays()).toEqual([500]);
      timers.fireNext();
      await nextTurn();
      const authoritativeAction = findByClass(container, 'tasks-action');
      if (testCase.authoritativeLabel) {
        expect(authoritativeAction).toMatchObject({
          textContent: testCase.authoritativeLabel,
          disabled: false,
        });
      } else {
        expect(authoritativeAction).toBeNull();
        expect(taskDetails(container)).toContain('cancelled');
      }
      dispose();
    },
  );
}

function registerDisposalTest(): void {
  it('cancels a pending authoritative lifecycle refresh when disposed', async () => {
    const documentRef = new FakeDocument();
    const timers = new FakeTimers();
    vi.stubGlobal('document', documentRef);
    vi.stubGlobal('setTimeout', timers.setTimeout);
    vi.stubGlobal('clearTimeout', timers.clearTimeout);
    const container = documentRef.createElement('div');
    const subject = createAmbiguousTasksSubject('start');
    const dispose = mountTasksView(container as unknown as HTMLElement, subject.tasks);
    await nextTurn();

    findByClass(container, 'tasks-action')?.click();
    await nextTurn();
    expect(timers.size).toBe(1);
    dispose();

    expect(timers.size).toBe(0);
    expect(container.children).toHaveLength(0);
  });
}

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

function createAmbiguousTasksSubject(operation: 'start' | 'cancel'): { readonly tasks: TasksApi } {
  const task = taskView();
  let execution = executionView(task, operation === 'start' ? 'ready' : 'running');
  let executionReads = 0;
  const rejectAfter = (state: TaskExecutionState) => async (): Promise<never> => {
    execution = executionView(task, state);
    throw new Error(`ambiguous ${operation} result`);
  };
  return {
    tasks: {
      create: vi.fn(),
      list: async () => [task],
      start: vi.fn(operation === 'start' ? rejectAfter('running') : async () => execution),
      cancel: vi.fn(operation === 'cancel' ? rejectAfter('cancelled') : async () => execution),
      execution: async () => {
        executionReads += 1;
        if (executionReads === 2) throw new Error('first authoritative refresh failed');
        return execution;
      },
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
    attempts: state === 'ready' ? [] : [{ id: 'attempt-1', number: 1, state }],
    context: null,
    executionContexts: [],
    providerSessions: [],
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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeTimers {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { readonly task: () => void; readonly delay: number }
  >();

  readonly setTimeout = vi.fn((task: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.pending.set(id, { task, delay });
    return id;
  });

  readonly clearTimeout = vi.fn((timer: number): void => {
    this.pending.delete(timer);
  });

  get size(): number {
    return this.pending.size;
  }

  delays(): number[] {
    return [...this.pending.values()].map(({ delay }) => delay);
  }

  fireNext(): void {
    const next = this.pending.entries().next().value as
      | [number, { readonly task: () => void }]
      | undefined;
    if (!next) throw new Error('expected a scheduled refresh');
    this.pending.delete(next[0]);
    next[1].task();
  }
}

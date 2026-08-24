import type { TaskExecutionState, TaskExecutionView } from '../../shared/runtime/runtime-interface';

export type TaskExecutionAction = 'start' | 'cancel' | null;

export interface TaskExecutionModel {
  readonly state: TaskExecutionState;
  readonly action: TaskExecutionAction;
  readonly summary: string;
}

type Schedule = (task: () => void, delayMs: number) => unknown;
type CancelSchedule = (timer: unknown) => void;

/** Derives the renderer's visible state only from the Runtime-owned execution view. */
export function taskExecutionModel(view: TaskExecutionView): TaskExecutionModel {
  const context = view.context;
  return {
    state: view.task.executionState,
    action: executionAction(view.task.executionState),
    summary: [
      view.task.executionState,
      `run ${view.run?.id ?? 'none'}`,
      `attempt ${view.attempt?.id ?? 'none'}`,
      `context ${context?.id ?? 'none'}`,
      `worktree ${context?.worktreeId ?? 'none'}`,
      `branch ${context?.branchName ?? 'none'}`,
    ].join(' · '),
  };
}

/** Owns one bounded renderer refresh timer and never polls terminal Task states. */
export class TaskExecutionPoller {
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly schedule: Schedule = setTimeout,
    private readonly cancel: CancelSchedule = (timer) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
  ) {}

  update(views: readonly TaskExecutionView[]): void {
    this.clear();
    if (this.disposed || !views.some((view) => isNonterminal(view.task.executionState))) return;
    this.scheduleRefresh();
  }

  retry(): void {
    this.clear();
    if (this.disposed) return;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    this.timer = this.schedule(() => {
      this.timer = null;
      if (!this.disposed) void this.refresh();
    }, 500);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }
}

function executionAction(state: TaskExecutionState): TaskExecutionAction {
  if (state === 'ready') return 'start';
  if (state === 'starting' || state === 'running') return 'cancel';
  return null;
}

function isNonterminal(state: TaskExecutionState): boolean {
  return state === 'starting' || state === 'running' ||
    state === 'cancelling' || state === 'superseding';
}

import { describe, expect, it, vi } from 'vitest';
import {
  TaskExecutionPoller,
  taskExecutionModel,
} from '../../src/renderer/src/task-execution-model';
import type { TaskExecutionView } from '../../src/shared/runtime/runtime-interface';

describe('Task execution renderer model', () => {
  it('renders Runtime-owned joined identities and only offers lifecycle-appropriate controls', () => {
    const model = taskExecutionModel(executionView('running'));

    expect(model).toEqual({
      state: 'running',
      action: 'cancel',
      summary:
        'running · run run-1 · attempt attempt-1 · context context-1 · worktree worktree-1 · branch hariari/task-1',
    });
    expect(taskExecutionModel(executionView('ready')).action).toBe('start');
    expect(taskExecutionModel(executionView('cancelled')).action).toBeNull();
  });

  it('bounds polling to nonterminal Tasks and disposes its scheduled refresh', async () => {
    const scheduled = new Map<number, () => void>();
    const refresh = vi.fn(async () => undefined);
    const poller = new TaskExecutionPoller(refresh, (task) => {
      scheduled.set(1, task);
      return 1;
    }, (timer) => scheduled.delete(timer as number));

    poller.update([executionView('running')]);
    expect(scheduled.size).toBe(1);
    const scheduledRefresh = scheduled.get(1);
    scheduled.delete(1);
    scheduledRefresh?.();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    poller.update([executionView('completed')]);
    expect(scheduled.size).toBe(0);
    poller.update([executionView('cancelling')]);
    poller.dispose();
    expect(scheduled.size).toBe(0);
  });
});

function executionView(state: TaskExecutionView['task']['executionState']): TaskExecutionView {
  const running = state !== 'ready';
  return {
    task: {
      id: 'task-1',
      objective: 'Render Runtime state.',
      project: 'Hariari',
      repository: 'hariari-app/hariari',
      baseRef: 'main',
      provider: 'shell',
      createdAt: '2026-08-21T10:00:00.000Z',
      executionState: state,
    },
    run: running ? { id: 'run-1', number: 1 } : null,
    attempt: running ? { id: 'attempt-1', number: 1, state } : null,
    attempts: running ? [{ id: 'attempt-1', number: 1, state }] : [],
    context: running
      ? {
          id: 'context-1',
          worktreeId: 'worktree-1',
          branchName: 'hariari/task-1',
          baseCommit: 'base-1',
        }
      : null,
    executionContexts: [],
    providerSessions: [],
  };
}

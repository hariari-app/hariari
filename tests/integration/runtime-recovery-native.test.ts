import { describe, expect, it } from 'vitest';
import { LocalGenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';
import {
  createSubject,
  createTestRepository,
  registerRuntimeTaskTestCleanup,
  shellTask,
} from './runtime-task-test-harness';

describe('real local Runtime recovery tracer', () => {
  registerRuntimeTaskTestCleanup();

  it('observes the real process, PTY, worktree, and branch after a Runtime restart', async () => {
    const repository = createTestRepository();
    const subject = await createSubject((runtimeDirectory) =>
      new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    );
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('native-recovery-create', repository.path));
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-recovery-start' });
    await runtime.disconnect();
    await subject.restartWith(new LocalGenericCliExecutionAdapter({
      runtimeDirectory: subject.runtimeDirectory,
    }));
    const restarted = await subject.connect();

    const recovery = await restarted.reconcileTask({
      taskId: task.id,
      idempotencyKey: 'native-recovery-reconcile',
    });

    expect(recovery).toMatchObject({
      status: 'attention',
      decision: 'fail',
      resources: [
        { kind: 'provider-session', classification: 'healthy' },
        { kind: 'process', classification: 'unknown' },
        { kind: 'pty', classification: 'unknown' },
        { kind: 'worktree', classification: 'healthy' },
        { kind: 'branch', classification: 'healthy' },
      ],
      attention: { reason: 'ambiguous-recovery' },
    });
    await restarted.disconnect();
  });

  it('surfaces a real related branch created outside Runtime as orphaned', async () => {
    const repository = createTestRepository();
    const subject = await createSubject((runtimeDirectory) =>
      new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    );
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('native-orphan-create', repository.path));
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-orphan-start' });
    execFileSync('git', [
      'branch', `hariari/task-${task.id}/external-orphan`, repository.baseCommit,
    ], { cwd: repository.path });

    const recovery = await runtime.reconcileTask({
      taskId: task.id,
      idempotencyKey: 'native-orphan-reconcile',
    });

    expect(recovery.resources).toEqual(expect.arrayContaining([
      { kind: 'branch', classification: 'orphaned' },
    ]));
    expect(recovery).toMatchObject({
      status: 'attention', decision: 'fail',
      attention: { reason: 'ambiguous-recovery' },
    });
    await runtime.disconnect();
  });
});
import { execFileSync } from 'node:child_process';

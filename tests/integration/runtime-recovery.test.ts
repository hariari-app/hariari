import { describe, expect, it } from 'vitest';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createSubject,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

describe('authenticated Runtime recovery', () => {
  registerRuntimeTaskTestCleanup();

  it('classifies one stale observed process and chooses native resume', async () => {
    const adapter = new FakeClaudeCodeExecutionAdapter();
    const subject = await createSubject(() => adapter);
    const runtime = await subject.connect();
    const task = await runtime.createTask({
      objective: 'Recover a stale Runtime process.',
      project: 'Hariari',
      repository: 'fake-checkout',
      baseRef: 'main',
      provider: 'claude',
      idempotencyKey: 'recovery-create',
    });
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'recovery-start' });
    adapter.lose(task.id);

    const recovery = await runtime.reconcileTask({
      taskId: task.id,
      idempotencyKey: 'recovery-reconcile',
    });

    expect(recovery).toMatchObject({
      taskId: task.id,
      desiredState: 'running',
      status: 'ready',
      decision: 'resume',
      resources: [{ kind: 'process', classification: 'stale' }],
      attention: null,
    });
    expect(JSON.stringify(recovery)).not.toMatch(/processId|ptyId|nativeSessionId|repository|branchName/);
    await runtime.disconnect();
  });
});

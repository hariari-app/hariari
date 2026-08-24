import path from 'node:path';
import { expect, it } from 'vitest';
import type { ExecutionResourceObservation } from '../../src/runtime/generic-cli-execution-adapter';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  FAILED_APPEND_MODES,
  corruptExecutionAppend,
  createSubject,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

registerRuntimeTaskTestCleanup();

const PRIVATE_RECOVERY_FIELDS = /processId|ptyId|nativeSessionId|repository|branchName/;

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
    resources: [
      { kind: 'provider-session', classification: 'stale' },
      { kind: 'process', classification: 'stale' },
      { kind: 'pty', classification: 'stale' },
      { kind: 'worktree', classification: 'healthy' },
      { kind: 'branch', classification: 'healthy' },
    ],
    attention: null,
  });
  expect(JSON.stringify(recovery)).not.toMatch(PRIVATE_RECOVERY_FIELDS);
  await expect(
    runtime.recoverTask({
      taskId: task.id,
      recoveryId: recovery.id,
      idempotencyKey: 'recovery-decide',
    }),
  ).resolves.toMatchObject({
    taskId: task.id,
    recoveryId: recovery.id,
    status: 'decided',
    decision: 'resume',
    attention: null,
  });
  await runtime.disconnect();
});

it('classifies missing, duplicated, changed, and orphaned observations centrally', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Classify divergent Runtime resources.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: 'classification-create',
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'classification-start' });
  adapter.setRecoveryResources([
    observed('provider-session', 'active', { copies: 2 }),
    observed('process', 'absent'),
    observed('pty', 'inactive'),
    observed('worktree', 'active', { fingerprint: 'changed' }),
    observed('branch', 'active'),
    observed('branch', 'active', { expected: false, adoptable: false }),
  ]);

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'classification-reconcile',
  });

  expect(recovery.resources).toEqual([
    { kind: 'provider-session', classification: 'duplicated' },
    { kind: 'process', classification: 'missing' },
    { kind: 'pty', classification: 'stale' },
    { kind: 'worktree', classification: 'externally-modified' },
    { kind: 'branch', classification: 'healthy' },
    { kind: 'branch', classification: 'orphaned' },
  ]);
  expect(recovery).toMatchObject({ status: 'attention', decision: 'fail' });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await runtime.disconnect();
});

it('chooses fork or adoption only from the central resource decision table', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter({
    claudeCapabilities: { resume: false, fork: true },
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'decision');
  adapter.setRecoveryResources([observed('provider-session', 'absent'), ...healthyHostResources()]);
  await expect(
    runtime.reconcileTask({
      taskId: task.id,
      idempotencyKey: 'decision-fork',
    }),
  ).resolves.toMatchObject({ status: 'ready', decision: 'fork', attention: null });

  adapter.setRecoveryResources([
    observed('provider-session', 'active'),
    ...healthyHostResources(),
    observed('worktree', 'active', { expected: false, adoptable: true }),
  ]);
  await expect(
    runtime.reconcileTask({
      taskId: task.id,
      idempotencyKey: 'decision-adopt',
    }),
  ).resolves.toMatchObject({ status: 'ready', decision: 'adopt', attention: null });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await runtime.disconnect();
});

it('fails closed when recovery would resume without its desired worktree', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'missing-worktree');
  adapter.setRecoveryResources([
    observed('provider-session', 'active'),
    observed('process', 'active'),
    observed('pty', 'active'),
    observed('worktree', 'absent'),
    observed('branch', 'active'),
  ]);

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'missing-worktree-reconcile',
  });

  expect(recovery).toMatchObject({
    status: 'attention',
    decision: 'fail',
    resources: expect.arrayContaining([{ kind: 'worktree', classification: 'missing' }]),
    attention: { reason: 'ambiguous-recovery' },
  });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await runtime.disconnect();
});

it('bounds excessive observed resources and fails into Attention', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'bounded-observations');
  adapter.setRecoveryResources(
    Array.from({ length: 25 }, () =>
      observed('worktree', 'active', { expected: false, adoptable: true }),
    ),
  );

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'bounded-observations-reconcile',
  });

  expect(recovery.resources).toHaveLength(20);
  expect(recovery).toMatchObject({
    status: 'attention',
    decision: 'fail',
    attention: { reason: 'ambiguous-recovery' },
  });
  await runtime.disconnect();
});

it('turns a fresh-adapter unknown into bounded Attention without lifecycle effects', async () => {
  const firstAdapter = new FakeClaudeCodeExecutionAdapter();
  const freshAdapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => firstAdapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'fresh-adapter');
  const before = await runtime.getTaskExecution(task.id);
  await runtime.disconnect();
  await subject.restartWith(freshAdapter);
  const restarted = await subject.connect();

  const recovery = await restarted.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'fresh-adapter-reconcile',
  });

  expect(recovery).toMatchObject({
    status: 'attention',
    decision: 'fail',
    resources: [
      { kind: 'provider-session', classification: 'unknown' },
      { kind: 'process', classification: 'unknown' },
      { kind: 'pty', classification: 'unknown' },
      { kind: 'worktree', classification: 'unknown' },
      { kind: 'branch', classification: 'unknown' },
    ],
    attention: { reason: 'ambiguous-recovery' },
  });
  expect(JSON.stringify(recovery).length).toBeLessThan(1_024);
  await expect(
    restarted.recoverTask({
      taskId: task.id,
      recoveryId: recovery.id,
      idempotencyKey: 'fresh-adapter-recover',
    }),
  ).resolves.toMatchObject({ status: 'attention', decision: 'fail' });
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(before);
  expect(freshAdapter.startCount(task.id)).toBe(0);
  expect(freshAdapter.stopCount(task.id)).toBe(0);
  await restarted.disconnect();
});

it('replays the same reconciliation key without observing or creating Attention twice', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'replay');
  adapter.forget(task.id);
  const request = { taskId: task.id, idempotencyKey: 'replay-reconcile' };
  const first = await runtime.reconcileTask(request);
  await expect(runtime.reconcileTask(request)).resolves.toEqual(first);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();

  await expect(restarted.reconcileTask(request)).resolves.toEqual(first);
  expect(adapter.recoveryObservationCount(task.id)).toBe(1);
  await restarted.disconnect();
});

it.each(FAILED_APPEND_MODES)(
  'repairs a %s TaskReconciled append before same-key retry and restart',
  async (mode) => {
    const adapter = new FakeClaudeCodeExecutionAdapter();
    const subject = await createSubject(() => adapter);
    const runtime = await subject.connect();
    const task = await createStartedClaudeTask(runtime, `append-${mode}`);
    adapter.forget(task.id);
    corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), 1, mode);
    const request = { taskId: task.id, idempotencyKey: `append-${mode}-reconcile` };

    await expect(runtime.reconcileTask(request)).rejects.toMatchObject({ code: 'internal' });
    const repaired = await runtime.reconcileTask(request);
    await runtime.disconnect();
    await subject.restart();
    const restarted = await subject.connect();
    await expect(restarted.reconcileTask(request)).resolves.toEqual(repaired);
    expect(adapter.recoveryObservationCount(task.id)).toBe(2);
    await restarted.disconnect();
  },
);

it('replays a reconciliation committed before its acknowledgement connection was lost', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'lost-ack');
  adapter.forget(task.id);
  subject.transport.dropNextResponse('task.reconcile');
  const request = { taskId: task.id, idempotencyKey: 'lost-ack-reconcile' };

  await expect(runtime.reconcileTask(request)).rejects.toMatchObject({ code: 'transport-lost' });
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  const replayed = await restarted.reconcileTask(request);

  expect(replayed).toMatchObject({ decision: 'fail', status: 'attention' });
  expect(adapter.recoveryObservationCount(task.id)).toBe(1);
  await restarted.disconnect();
});

it('durably commits the central recovery decision without implicit ambiguous effects', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'recover-command');
  adapter.forget(task.id);
  const reconciliation = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'recover-command-reconcile',
  });
  const request = {
    taskId: task.id,
    recoveryId: reconciliation.id,
    idempotencyKey: 'recover-command-decide',
  };

  const decided = await runtime.recoverTask(request);

  expect(decided).toMatchObject({
    taskId: task.id,
    recoveryId: reconciliation.id,
    decision: 'fail',
    status: 'attention',
    attention: reconciliation.attention,
  });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await expect(runtime.recoverTask(request)).resolves.toEqual(decided);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.recoverTask(request)).resolves.toEqual(decided);
  await restarted.disconnect();
});

it.each(FAILED_APPEND_MODES)(
  'repairs a %s TaskRecoveryDecided append before same-key retry and restart',
  async (mode) => {
    const adapter = new FakeClaudeCodeExecutionAdapter();
    const subject = await createSubject(() => adapter);
    const runtime = await subject.connect();
    const task = await createStartedClaudeTask(runtime, `decision-append-${mode}`);
    adapter.forget(task.id);
    const recovery = await runtime.reconcileTask({
      taskId: task.id,
      idempotencyKey: `decision-append-${mode}-reconcile`,
    });
    corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), 1, mode);
    const request = {
      taskId: task.id,
      recoveryId: recovery.id,
      idempotencyKey: `decision-append-${mode}-recover`,
    };

    await expect(runtime.recoverTask(request)).rejects.toMatchObject({ code: 'internal' });
    const repaired = await runtime.recoverTask(request);
    await runtime.disconnect();
    await subject.restart();
    const restarted = await subject.connect();
    await expect(restarted.recoverTask(request)).resolves.toEqual(repaired);
    expect(adapter.startCount(task.id)).toBe(1);
    expect(adapter.stopCount(task.id)).toBe(0);
    await restarted.disconnect();
  },
);

it('replays a recovery decision committed before its acknowledgement connection was lost', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createStartedClaudeTask(runtime, 'decision-lost-ack');
  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'decision-lost-ack-reconcile',
  });
  subject.transport.dropNextResponse('task.recover');
  const request = {
    taskId: task.id,
    recoveryId: recovery.id,
    idempotencyKey: 'decision-lost-ack-recover',
  };

  await expect(runtime.recoverTask(request)).rejects.toMatchObject({ code: 'transport-lost' });
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.recoverTask(request)).resolves.toMatchObject({
    recoveryId: recovery.id,
    decision: 'resume',
    status: 'decided',
  });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await restarted.disconnect();
});

it('archives terminal desired state without treating inactive resources as resumable', async () => {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Archive completed Runtime resources.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: 'archive-create',
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'archive-start' });
  await runtime.cancelTask({ taskId: task.id, idempotencyKey: 'archive-cancel' });

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'archive-reconcile',
  });

  expect(recovery).toMatchObject({
    desiredState: 'cancelled',
    status: 'ready',
    decision: 'archive',
    attention: null,
  });
  await runtime.disconnect();
});
async function createStartedClaudeTask(
  runtime: Awaited<ReturnType<Awaited<ReturnType<typeof createSubject>>['connect']>>,
  key: string,
): Promise<{ readonly id: string }> {
  const task = await runtime.createTask({
    objective: 'Choose one deterministic recovery action.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: `${key}-create`,
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` });
  return task;
}

function healthyHostResources(): readonly ExecutionResourceObservation[] {
  return [
    observed('process', 'active'),
    observed('pty', 'active'),
    observed('worktree', 'active'),
    observed('branch', 'active'),
  ];
}

function observed(
  kind: 'provider-session' | 'process' | 'pty' | 'worktree' | 'branch',
  state: 'active' | 'inactive' | 'absent' | 'unknown',
  overrides: Partial<ExecutionResourceObservation> = {},
): ExecutionResourceObservation {
  return {
    kind,
    expected: true,
    state,
    identity: 'matching',
    fingerprint: 'matching',
    copies: state === 'absent' ? 0 : 1,
    adoptable: false,
    ...overrides,
  };
}

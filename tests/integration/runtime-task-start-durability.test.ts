import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import {
  LocalGenericCliExecutionAdapter,
} from '../../src/runtime/generic-cli-execution-adapter';
import type { TaskExecutionView } from '../../src/shared/runtime/runtime-interface';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';
import {
  FAILED_APPEND_MODES,
  corruptExecutionAppend,
  createSubject,
  createTestRepository,
  deferred,
  nextRuntimeTurn,
  registerRuntimeTaskTestCleanup,
  shellTask,
} from './runtime-task-test-harness';

const FAILED_ALLOCATION_APPEND_CASES = ['ContextAllocated', 'AttemptFailed'].flatMap(
  (name, index) => FAILED_APPEND_MODES.map((mode) => ({ name, mode, writeCall: index + 3 })),
);
const NATIVE_RESUME_APPEND_CASES = [
  'ProviderSessionActionDecided', 'AttemptSupersessionRequested',
  'AttemptSuperseded', 'AttemptResumed', 'ContextAllocated', 'AttemptStarted',
].flatMap((name, index) =>
  FAILED_APPEND_MODES.map((mode) => ({ name, mode, writeCall: index + 1 })));

describe('authenticated Runtime Task start durability', registerTaskStartDurabilityTests);

function registerTaskStartDurabilityTests(): void {
  registerRuntimeTaskTestCleanup();
  it('coalesces concurrent same-key starts from independent sessions', coalescesConcurrentStarts);
  it.each(FAILED_ALLOCATION_APPEND_CASES)(
    'preserves an allocated Git context across $name $mode append repair',
    async ({ writeCall, mode }) => preservesFailedContext(writeCall, mode),
  );
  it.each(NATIVE_RESUME_APPEND_CASES)(
    'repairs native resume $name $mode append failure across retry and restart',
    repairsNativeResumeAppend,
  );
}

async function repairsNativeResumeAppend(
  fault: (typeof NATIVE_RESUME_APPEND_CASES)[number],
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Repair native resume append.',
    project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude',
    idempotencyKey: `resume-${fault.name}-${fault.mode}-create` });
  const parent = await runtime.startTask({ taskId: task.id,
    idempotencyKey: `resume-${fault.name}-${fault.mode}-start` });
  adapter.lose(task.id);
  const request = { taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: `resume-${fault.name}-${fault.mode}` };
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'),
    fault.writeCall, fault.mode);
  let resumed: TaskExecutionView;
  if (fault.name === 'ContextAllocated') resumed = await runtime.resumeProviderSession(request);
  else {
    await expect(runtime.resumeProviderSession(request))
      .rejects.toEqual(new RuntimePortError('internal', true));
    resumed = await runtime.resumeProviderSession(request);
  }
  const state = fault.name === 'AttemptStarted' ? 'failed' : 'running';
  expect(resumed).toMatchObject({ attempt: { number: 2, state },
    providerSession: { parentId: parent.providerSession!.id, lineage: 'native-resume' } });
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.resumeProviderSession(request)).resolves.toEqual(resumed);
  await restarted.disconnect();
}

async function coalescesConcurrentStarts(): Promise<void> {
  const gate = deferred();
  const adapter = new FakeGenericCliExecutionAdapter({ beforeStart: gate.promise });
  const subject = await createSubject(() => adapter);
  const first = await subject.connect();
  const second = await subject.connect();
  const task = await first.createTask(shellTask('concurrent-start-create', 'fake-checkout'));
  const request = { taskId: task.id, idempotencyKey: 'concurrent-start' };
  const starts = [first.startTask(request), second.startTask(request)] as const;

  try {
    await adapter.waitForStart(task.id);
    await subject.transport.waitForRequests('task.start', 2);
    await nextRuntimeTurn();
    expect(adapter.startCount(task.id)).toBe(1);
    gate.resolve();
    const [firstResult, secondResult] = await Promise.all(starts);
    expect(secondResult).toEqual(firstResult);
    assertSingleExecution(firstResult);
    await assertStartConflicts(first, second, request);
  } finally {
    gate.resolve();
    await Promise.allSettled(starts);
    await Promise.all([first.disconnect(), second.disconnect()]);
  }
}

async function assertStartConflicts(
  first: RuntimeClientSession,
  second: RuntimeClientSession,
  request: { readonly taskId: string; readonly idempotencyKey: string },
): Promise<void> {
  await expect(
    second.startTask({ ...request, idempotencyKey: 'different-concurrent-start' }),
  ).rejects.toEqual(new RuntimePortError('task-not-ready', false));
  const other = await first.createTask(shellTask('concurrent-other-create', 'fake-checkout'));
  await expect(second.startTask({ ...request, taskId: other.id })).rejects.toEqual(
    new RuntimePortError('idempotency-conflict', false),
  );
}

function assertSingleExecution(execution: TaskExecutionView): void {
  expect(execution).toMatchObject({
    run: { number: 1 },
    attempt: { number: 1, state: 'running' },
    context: { branchName: expect.stringMatching(/^hariari\/task-/) },
  });
}

async function preservesFailedContext(
  failedWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
): Promise<void> {
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({
      runtimeDirectory,
      pty: { spawn: failedPtySpawn },
    }),
  );
  const repository = createTestRepository();
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('failed-allocation-create', repository.path));
  corruptExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'),
    failedWrite,
    mode,
  );

  await expect(
    runtime.startTask({ taskId: task.id, idempotencyKey: 'failed-allocation-start' }),
  ).rejects.toEqual(new RuntimePortError('process-start-failed', true));
  const failed = await runtime.getTaskExecution(task.id);
  assertFailedView(failed, task.id, repository.baseCommit, subject.runtimeDirectory);
  assertGitResources(subject.runtimeDirectory, failed);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(failed);
  await restarted.disconnect();
}

function failedPtySpawn(): never {
  throw new Error('injected PTY spawn failure');
}

function assertFailedView(
  failed: TaskExecutionView,
  taskId: string,
  baseCommit: string,
  runtimeDirectory: string,
): void {
  expect(failed).toMatchObject({
    task: { id: taskId, executionState: 'failed' },
    run: { id: expect.stringMatching(/^start-remediation-/), number: 1 },
    attempt: { id: expect.stringMatching(/^start-remediation-/), number: 1, state: 'failed' },
    context: {
      id: expect.stringMatching(/^start-remediation-/),
      worktreeId: expect.stringMatching(/^start-remediation-/),
      branchName: expect.stringMatching(/^hariari\/task-/),
      baseCommit,
    },
  });
  expect(JSON.stringify(failed.context)).not.toContain(runtimeDirectory);
  expect(Object.keys(failed.context ?? {}).sort()).toEqual([
    'baseCommit',
    'branchName',
    'id',
    'worktreeId',
  ]);
}

function assertGitResources(runtimeDirectory: string, failed: TaskExecutionView): void {
  if (!failed.context) throw new Error('expected failed allocation context');
  const worktreePath = path.join(runtimeDirectory, 'task-worktrees', failed.context.worktreeId);
  expect(fs.existsSync(worktreePath)).toBe(true);
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
  expect(branch).toBe(failed.context.branchName);
}

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionView } from '../../src/shared/runtime/runtime-interface';
import {
  FakeClaudeCodeExecutionAdapter,
} from './runtime-test-fakes';
import {
  FAILED_APPEND_MODES,
  corruptExpectedExecutionAppend,
  createSubject,
  deferred,
  nextRuntimeTurn,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';
const PROVIDER_LIFECYCLE_APPEND_CASES = [
  { name: 'ProviderSessionActionDecided', writeCall: 1 },
  { name: 'AttemptSupersessionRequested', writeCall: 2 },
  { name: 'AttemptSuperseded', writeCall: 3 },
  { name: 'AttemptForked', writeCall: 4 },
  { name: 'ContextAllocated', writeCall: 5 },
].flatMap((transition) => FAILED_APPEND_MODES.map((mode) => ({
  ...transition,
  operation: transition.name === 'ProviderSessionActionDecided'
    ? 'provider.resume rejection'
    : 'provider.fork',
  eventType: transition.name,
  mode,
})));
describe('authenticated Runtime Task start remediation', registerTaskStartTests);
function registerTaskStartTests(): void {
  registerRuntimeTaskTestCleanup();
  it('forks a Claude session through the authenticated Runtime seam', forksClaudeSession);
  it('durably aborts fork when parent stop fails and remains live', abortsLiveParentFork);
  it('continues fork when parent stop fails after positive loss observation', continuesLostParentFork);
  it('rejects an unknown parent fork without a lifecycle transition', rejectsUnknownParentFork);
  it('settles a late parent exit by attempt identity without disturbing the fork child', settlesLateParentExit);
  it('reattaches the same live provider session after a Desktop-only reconnect', resumesMatchingClaudeSession);
  it('keeps a fresh Runtime adapter outside durable provider-session ownership', rejectsFreshAdapterResume);
  it('restarts one native Claude process when the owned process is lost', resumesLostClaudeProcess);
  it('replays an unattached durable native resume with its planned identities', replaysUnattachedNativeResume);
  it('durably rejects an unknown provider-session observation without launching', rejectsUnknownResumeObservation);
  it('records an unsupported Claude resume rejection across restart', rejectsUnsupportedClaudeResume);
  it('rejects terminal and noncurrent Claude resumes through public codes', rejectsNoncurrentClaudeResumes);
  it(
    'replays an unattached durable Claude fork as a starting child without inventing a native identity',
    replaysUnattachedClaudeFork,
  );
  it.each(PROVIDER_LIFECYCLE_APPEND_CASES)(
    'repairs $name $mode append failure for same-key provider lifecycle retry and replay',
    verifiesProviderLifecycleAppendRecovery,
  );
}
function createClaudeTask(runtime: RuntimeClientSession, repository: string, key: string) {
  return runtime.createTask({
    objective: 'Implement the bounded provider task.', project: 'Hariari', repository,
    baseRef: 'HEAD', provider: 'claude', idempotencyKey: `${key}-create`,
  });
}


async function replaysUnattachedClaudeFork(): Promise<void> {
  const childGate = deferred();
  let stalledChild = false;
  const adapter = new FakeClaudeCodeExecutionAdapter({
    beforeStart: (request) => request.attempt.number === 2 && !stalledChild
      ? (stalledChild = true, childGate.promise)
      : undefined,
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Recover a durable Claude fork.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'unattached-fork-create' });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'unattached-fork-start' });
  const fork = runtime.forkProviderSession({ taskId: task.id,
    providerSessionId: parent.providerSession!.id, idempotencyKey: 'unattached-fork' });
  try {
    await waitForAdapterStarts(adapter, task.id, 2);
    await runtime.disconnect();
    await subject.restart();
    const restarted = await subject.connect();
    await expect(restarted.getTaskExecution(task.id)).resolves.toMatchObject({
      task: { executionState: 'starting' },
      attempt: { number: 2, state: 'starting' },
      context: null,
      providerSession: null,
      attempts: [{ number: 1 }, { number: 2, state: 'starting' }],
      providerSessions: [parent.providerSession],
    });
    await expect(restarted.startTask({ taskId: task.id, idempotencyKey: 'unattached-fork-start' })).resolves.toMatchObject({
      attempt: { number: 2, state: 'running' },
      providerSession: { parentId: parent.providerSession!.id },
    });
    expect(adapter.startsFor(task.id)[2]?.instruction).toMatchObject({
      kind: 'fork-claude',
      parentNativeSessionId: initialNativeSessionId(adapter, task.id),
      context: { worktreeId: parent.context?.worktreeId, branchName: parent.context?.branchName },
    });
    await restarted.disconnect();
  } finally {
    childGate.resolve();
    await Promise.allSettled([fork]);
  }
}

async function waitForAdapterStarts(adapter: FakeClaudeCodeExecutionAdapter, taskId: string, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (adapter.startCount(taskId) < count) {
    if (Date.now() >= deadline) throw new Error(`expected ${count} adapter starts`);
    await nextRuntimeTurn();
  }
}

async function verifiesProviderLifecycleAppendRecovery(
  transition: (typeof PROVIDER_LIFECYCLE_APPEND_CASES)[number],
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Repair a Claude lifecycle append.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: `claude-${transition.name}-${transition.mode}-create` });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: `claude-${transition.name}-${transition.mode}-start` });
  const resume = { taskId: task.id, providerSessionId: 'unknown-session',
    idempotencyKey: `claude-${transition.name}-${transition.mode}` };
  const fork = { taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: resume.idempotencyKey };
  const appendFault = corruptExpectedExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'), transition, transition.mode,
  );
  if (transition.name === 'ProviderSessionActionDecided') {
    await expect(runtime.resumeProviderSession(resume)).rejects.toEqual(new RuntimePortError('internal', true));
    await expect(runtime.resumeProviderSession(resume)).rejects.toEqual(new RuntimePortError('not-found', false));
  } else if (transition.name === 'AttemptSuperseded' ||
    transition.name === 'ContextAllocated') {
    await expect(runtime.forkProviderSession(fork)).resolves.toMatchObject({
      attempt: { number: 2, state: 'running' }, providerSession: { parentId: parent.providerSession!.id },
    });
  } else {
    await expect(runtime.forkProviderSession(fork)).rejects.toEqual(new RuntimePortError('internal', true));
    await expect(runtime.forkProviderSession(fork)).resolves.toMatchObject({ attempt: { number: 2, state: 'running' } });
  }
  appendFault.assertObserved();
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  if (transition.name === 'ProviderSessionActionDecided') {
    await expect(restarted.resumeProviderSession(resume)).rejects.toEqual(new RuntimePortError('not-found', false));
  } else {
    await expect(restarted.forkProviderSession(fork)).resolves.toMatchObject({ attempt: { number: 2, state: 'running' } });
  }
  await restarted.disconnect();
}

async function rejectsUnsupportedClaudeResume(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter({ claudeCapabilities: { resume: false, fork: true } }));
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-unsupported-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-unsupported-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id, repository: task.repository, worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-unsupported' };
  await expect(runtime.resumeProviderSession(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.resumeProviderSession(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await expect(restarted.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await restarted.disconnect();
}

async function rejectsNoncurrentClaudeResumes(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Reject stale Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'noncurrent-create' });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'noncurrent-start' });
  await runtime.forkProviderSession({ taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'noncurrent-fork' });
  const noncurrent = providerRequest(task, parent, 'noncurrent-resume');
  await expect(runtime.resumeProviderSession(noncurrent))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  const terminal = await runtime.cancelTask({ taskId: task.id, idempotencyKey: 'terminal-cancel' });
  const terminalRequest = providerRequest(task, terminal, 'terminal-resume');
  await expect(runtime.resumeProviderSession(terminalRequest))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.resumeProviderSession(noncurrent))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await expect(restarted.resumeProviderSession(terminalRequest))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await restarted.disconnect();
}

function providerRequest(
  task: { readonly id: string; readonly repository: string },
  execution: TaskExecutionView,
  idempotencyKey: string,
) {
  return { taskId: task.id, providerSessionId: execution.providerSession!.id, idempotencyKey };
}

async function resumesMatchingClaudeSession(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const clientA = await subject.connect();
  const task = await clientA.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-create' });
  const started = await clientA.startTask({ taskId: task.id, idempotencyKey: 'resume-start' });
  await clientA.disconnect();
  const clientB = await subject.connect();
  const resumed = await clientB.resumeProviderSession({
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    idempotencyKey: 'resume-match',
  });
  expect(resumed).toEqual(started);
  expect(adapter.startCount(task.id)).toBe(1);
  expect(JSON.stringify(resumed)).not.toMatch(/nativeSessionId|processId|ptyId/);
  await clientB.disconnect();
}

async function rejectsFreshAdapterResume(): Promise<void> {
  const adapterA = new FakeClaudeCodeExecutionAdapter();
  const adapterB = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapterA);
  const clientA = await subject.connect();
  const task = await createClaudeTask(clientA, 'fake-checkout', 'fresh-adapter');
  const started = await clientA.startTask({ taskId: task.id, idempotencyKey: 'fresh-adapter-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: 'fresh-adapter-resume' };
  await clientA.disconnect();
  await subject.restartWith(adapterB);
  const clientB = await subject.connect();

  await expect(clientB.getTaskExecution(task.id)).resolves.toEqual(started);
  await expect(clientB.resumeProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await expect(clientB.getTaskExecution(task.id)).resolves.toEqual(started);
  expect(adapterB.startCount(task.id)).toBe(0);
  await clientB.disconnect();
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.resumeProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await expect(replay.getTaskExecution(task.id)).resolves.toEqual(started);
  expect(adapterB.startCount(task.id)).toBe(0);
  await replay.disconnect();
}

async function resumesLostClaudeProcess(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume lost Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-lost-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-lost-start' });
  adapter.lose(task.id);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  const resumed = await restarted.resumeProviderSession({
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    idempotencyKey: 'resume-lost',
  });

  assertLostResume(started, resumed, adapter, task.id);
  await restarted.disconnect();
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.resumeProviderSession({
    taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: 'resume-lost',
  })).resolves.toEqual(resumed);
  expect(adapter.startCount(task.id)).toBe(2);
  await replay.disconnect();
}

function assertLostResume(
  started: TaskExecutionView,
  resumed: TaskExecutionView,
  adapter: FakeClaudeCodeExecutionAdapter,
  taskId: string,
): void {
  expect(resumed.attempt).toMatchObject({ number: 2, state: 'running' });
  expect(resumed.attempt?.id).not.toBe(started.attempt?.id);
  expect(resumed.attempts).toMatchObject([
    { id: started.attempt?.id, state: 'superseded' },
    { id: resumed.attempt?.id, state: 'running' },
  ]);
  expect(resumed.context?.id).not.toBe(started.context?.id);
  expect(resumed.executionContexts).toHaveLength(2);
  expect(resumed.providerSession).toMatchObject({
    parentId: started.providerSession?.id, lineage: 'native-resume',
  });
  expect(resumed.providerSession?.id).not.toBe(started.providerSession?.id);
  expect(adapter.isDisposed(started.attempt!.id)).toBe(true);
  expect(adapter.startCount(taskId)).toBe(2);
  expect(adapter.startsFor(taskId)[1]?.instruction).toMatchObject({
    kind: 'resume-claude', nativeSessionId: initialNativeSessionId(adapter, taskId),
    context: { worktreeId: started.context?.worktreeId,
      branchName: started.context?.branchName },
  });
  const [parentLaunch, resumedLaunch] = adapter.startsFor(taskId);
  expect(resumedLaunch?.identities.contextId).not.toBe(parentLaunch?.identities.contextId);
  expect(resumedLaunch?.identities.processId).not.toBe(parentLaunch?.identities.processId);
  expect(resumedLaunch?.identities.ptyId).not.toBe(parentLaunch?.identities.ptyId);
}

async function rejectsUnknownResumeObservation(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'unknown-resume');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'unknown-resume-start' });
  adapter.forget(task.id);
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: 'unknown-resume-action' };
  await expect(runtime.resumeProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.resumeProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  const missing = { taskId: 'missing-task', providerSessionId: 'missing-session',
    idempotencyKey: 'missing-resume-action' };
  await expect(restarted.resumeProviderSession(missing))
    .rejects.toEqual(new RuntimePortError('not-found', false));
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.resumeProviderSession(missing))
    .rejects.toEqual(new RuntimePortError('not-found', false));
  expect(adapter.startCount(task.id)).toBe(1);
  await Promise.all([restarted.disconnect(), replay.disconnect()]);
}

async function replaysUnattachedNativeResume(): Promise<void> {
  const launchGate = deferred();
  let stalled = false;
  const adapter = new FakeClaudeCodeExecutionAdapter({
    beforeStart: (request) => request.attempt.number === 2 && !stalled
      ? (stalled = true, launchGate.promise) : undefined,
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'unattached-resume');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-plan-start' });
  adapter.lose(task.id);
  const request = { taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'resume-plan-action' };
  const pending = runtime.resumeProviderSession(request);
  try {
    await waitForAdapterStarts(adapter, task.id, 2);
    await runtime.disconnect();
    await subject.restart();
    const restarted = await subject.connect();
    await expect(restarted.getTaskExecution(task.id)).resolves.toMatchObject({
      attempt: { number: 2, state: 'starting' }, context: null, providerSession: null,
    });
    const recovered = await restarted.resumeProviderSession(request);
    expect(recovered).toMatchObject({ attempt: { number: 2, state: 'running' },
      providerSession: { parentId: parent.providerSession!.id, lineage: 'native-resume' } });
    expect(adapter.startsFor(task.id)[2]?.identities)
      .toEqual(adapter.startsFor(task.id)[1]?.identities);
    await restarted.disconnect();
  } finally {
    launchGate.resolve();
    await Promise.allSettled([pending]);
  }
}

async function forksClaudeSession(): Promise<void> {
  const childGate = deferred();
  const adapter = new FakeClaudeCodeExecutionAdapter({
    beforeStart: (request) => request.attempt.number === 2 ? childGate.promise : undefined,
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const concurrentRuntime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Fork this Claude task.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: 'fork-create',
  });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'fork-start' });
  const forkRequest = {
    taskId: task.id,
    providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'fork-child',
  };
  const childPromise = runtime.forkProviderSession(forkRequest);
  await adapter.waitForStop(task.id);
  const replayPromise = concurrentRuntime.forkProviderSession(forkRequest);
  await subject.transport.waitForRequests('provider-session.fork', 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(adapter.startCount(task.id)).toBe(2);
  childGate.resolve();
  const [child, concurrentReplay] = await Promise.all([childPromise, replayPromise]);
  expect(concurrentReplay).toEqual(child);
  expectForkedClaude(parent, child, adapter, task.id);
  await concurrentRuntime.disconnect();
  await expect(runtime.forkProviderSession({ taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'fork-child' })).resolves.toEqual(child);
  await expect(runtime.forkProviderSession({ ...forkRequest, providerSessionId: child.providerSession!.id })).rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(child);
  await restarted.disconnect();
}

async function abortsLiveParentFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopError: new Error('stop failed') });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'live-stop-failure');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'live-stop-start' });
  const request = { taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'live-stop-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('internal', true));
  await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(parent);
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('internal', true));
  expect(adapter.startCount(task.id)).toBe(1);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('internal', true));
  await restarted.disconnect();
}

async function continuesLostParentFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopError: new Error('stop failed') });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'lost-stop-failure');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'lost-stop-start' });
  adapter.lose(task.id);
  const child = await runtime.forkProviderSession({
    taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'lost-stop-fork',
  });
  expectForkedClaude(parent, child, adapter, task.id);
  expect(adapter.isDisposed(parent.attempt!.id)).toBe(true);
  await runtime.disconnect();
}

async function rejectsUnknownParentFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'unknown-stop-failure');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'unknown-stop-start' });
  adapter.forget(task.id);
  await expect(runtime.forkProviderSession({ taskId: task.id,
    providerSessionId: parent.providerSession!.id, idempotencyKey: 'unknown-stop-fork' }))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(parent);
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(0);
  await runtime.disconnect();
}

async function settlesLateParentExit(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopReturnsBeforeExit: true });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'late-parent-exit');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'late-parent-start' });
  const child = await runtime.forkProviderSession({
    taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'late-parent-fork',
  });
  expect(adapter.isDisposed(parent.attempt!.id)).toBe(false);
  adapter.exitAttempt(parent.attempt!.id, 143);
  await nextRuntimeTurn();
  expect(adapter.isDisposed(parent.attempt!.id)).toBe(true);
  await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(child);
  expect(adapter.hasRunning(task.id)).toBe(true);
  await runtime.disconnect();
}

function expectForkedClaude(parent: TaskExecutionView, child: TaskExecutionView, adapter: FakeClaudeCodeExecutionAdapter, taskId: string): void {
  expect(child.attempt).toMatchObject({ number: 2, state: 'running' });
  expect(child.attempt?.id).not.toBe(parent.attempt?.id);
  expect(child.providerSession).toMatchObject({ parentId: parent.providerSession!.id });
  expect(child.providerSession?.id).not.toBe(parent.providerSession?.id);
  expect(adapter.startsFor(taskId)[1]?.instruction).toMatchObject({
    kind: 'fork-claude', parentNativeSessionId: initialNativeSessionId(adapter, taskId),
    context: { worktreeId: parent.context?.worktreeId, branchName: parent.context?.branchName },
  });
  expect(child.context).toMatchObject({
    worktreeId: parent.context!.worktreeId,
    branchName: parent.context!.branchName,
  });
  expect(child.attempts).toEqual([{ ...parent.attempt, state: 'superseded' }, child.attempt]);
  expect(child.providerSessions).toEqual([parent.providerSession, child.providerSession]);
  expect(adapter.startCount(taskId)).toBe(2);
}

function initialNativeSessionId(adapter: FakeClaudeCodeExecutionAdapter, taskId: string): string {
  const instruction = adapter.startsFor(taskId)[0]?.instruction;
  if (instruction?.kind !== 'new' || !instruction.nativeSessionId) {
    throw new Error('expected initial native provider session');
  }
  return instruction.nativeSessionId;
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionView } from '../../src/shared/runtime/runtime-interface';
import {
  LocalGenericCliExecutionAdapter,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  ClaudeCodeExecutionAdapter,
  type ClaudeExecutablePort,
} from '../../src/runtime/claude-code-execution-adapter';
import { ProviderExecutionAdapterRouter } from '../../src/runtime/provider-execution-adapter-router';
import {
  FakeClaudeCodeExecutionAdapter,
} from './runtime-test-fakes';
import {
  FAILED_APPEND_MODES,
  type RuntimeSubject, appendLegacyTaskEvent,
  corruptExecutionAppend,
  createSubject,
  createTestRepository,
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
].flatMap((transition) => FAILED_APPEND_MODES.map((mode) => ({ ...transition, mode })));
describe('authenticated Runtime Task start remediation', registerTaskStartTests);
function registerTaskStartTests(): void {
  registerRuntimeTaskTestCleanup();
  it('records adapter-discovered Claude provider-session identity through the authenticated Runtime seam', recordsClaudeProviderSession);
  it('starts Claude through the production provider adapter', startsProductionClaudeProvider);
  it('reattaches live and passes fork argv through the production Claude adapter', invokesProductionClaudeLifecycle);
  it('persists false Claude capabilities discovered by the production adapter', discoversFalseClaudeCapabilities);
  it('projects immutable Claude attempt and provider-session histories through Runtime restart', projectsClaudeExecutionHistories);
  it('forks a Claude session through the authenticated Runtime seam', forksClaudeSession);
  it('durably aborts fork when parent stop fails and remains live', abortsLiveParentFork);
  it('continues fork when parent stop fails after positive loss observation', continuesLostParentFork);
  it('retains superseding state when parent stop and observation are ambiguous', retainsAmbiguousParentFork);
  it('settles a late parent exit by attempt identity without disturbing the fork child', settlesLateParentExit);
  it('reattaches an exact live provider session without launching or leaking private binding data', resumesMatchingClaudeSession);
  it('restarts one native Claude process when the owned process is lost', resumesLostClaudeProcess);
  it('replays an unattached durable native resume with its planned identities', replaysUnattachedNativeResume);
  it('durably rejects an unknown provider-session observation without launching', rejectsUnknownResumeObservation);
  it('keeps the legacy Claude resume operation as a sanitized server-side alias', verifiesLegacyClaudeResumeAlias);
  it('records an unsupported Claude resume rejection across restart', rejectsUnsupportedClaudeResume);
  it('rejects terminal and noncurrent Claude resumes through public codes', rejectsNoncurrentClaudeResumes);
  it(
    'replays an unattached durable Claude fork as a starting child without inventing a native identity',
    replaysUnattachedClaudeFork,
  );
  it('replays pre-provider-neutral Claude fork events through the compatibility codec', replaysLegacyClaudeForkEvents);
  it.each(PROVIDER_LIFECYCLE_APPEND_CASES)(
    'repairs $name $mode append failure for same-key provider lifecycle retry and replay',
    verifiesProviderLifecycleAppendRecovery,
  );
}
async function startsProductionClaudeProvider(): Promise<void> {
  const repository = createTestRepository();
  const executable = new RecordingClaudeExecutable();
  const pty = new RecordingClaudePty();
  const subject = await createSubject((runtimeDirectory) => new ProviderExecutionAdapterRouter({
    shell: new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    claude: new ClaudeCodeExecutionAdapter({ runtimeDirectory, executable, pty }),
  }));
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Implement the bounded provider task.',
    project: 'Hariari',
    repository: repository.path,
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: 'production-claude-create',
  });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'production-claude-start' });

  expect(started.providerSession).toMatchObject({
    capabilities: { resume: true, fork: true },
    lineage: 'new',
  });
  expect(JSON.stringify(started)).not.toMatch(/nativeSessionId|processId|ptyId/);
  expect(executable.calls).toEqual([['--version'], ['--help']]);
  expect(pty.starts).toEqual([{
    file: 'claude',
    args: [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--session-id',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      task.objective,
    ],
  }]);
  await runtime.disconnect();
}
async function invokesProductionClaudeLifecycle(): Promise<void> {
  const repository = createTestRepository();
  const executable = new RecordingClaudeExecutable();
  const pty = new RecordingClaudePty();
  const subject = await createProductionClaudeSubject(executable, pty);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, repository.path, 'production-lifecycle');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'production-lifecycle-start' });
  const resumed = await runtime.resumeProviderSession({
    taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'production-lifecycle-resume',
  });
  const child = await runtime.forkProviderSession({
    taskId: task.id, providerSessionId: resumed.providerSession!.id,
    idempotencyKey: 'production-lifecycle-fork',
  });
  const nativeSessionId = pty.starts[0]?.args[5];
  expect(pty.starts.map((start) => start.args)).toEqual([
    [...STRUCTURED_CLAUDE_ARGS, '--session-id', nativeSessionId, task.objective],
    [...STRUCTURED_CLAUDE_ARGS, '--resume', nativeSessionId, '--fork-session', task.objective],
  ]);
  expect(child.providerSession?.id).not.toBe(parent.providerSession?.id);
  expect(executable.calls).toEqual([['--version'], ['--help']]);
  await runtime.disconnect();
}
async function discoversFalseClaudeCapabilities(): Promise<void> {
  const repository = createTestRepository();
  const executable = new RecordingClaudeExecutable('  --session-id <uuid>\n');
  const pty = new RecordingClaudePty();
  const subject = await createProductionClaudeSubject(executable, pty);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, repository.path, 'false-capabilities');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'false-capabilities-start' });
  expect(started.providerSession?.capabilities).toEqual({ resume: false, fork: false });
  const request = {
    taskId: task.id, providerSessionId: started.providerSession!.id, idempotencyKey: 'false-capabilities-fork',
  };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  expect(pty.starts).toHaveLength(1);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await expect(restarted.forkProviderSession({ ...request, providerSessionId: 'different-session' }))
    .rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await restarted.disconnect();
}

const STRUCTURED_CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'] as const;

async function createProductionClaudeSubject(
  executable: RecordingClaudeExecutable,
  pty: RecordingClaudePty,
): Promise<RuntimeSubject> {
  return createSubject((runtimeDirectory) => new ProviderExecutionAdapterRouter({
    shell: new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    claude: new ClaudeCodeExecutionAdapter({ runtimeDirectory, executable, pty }),
  }));
}

function createClaudeTask(runtime: RuntimeClientSession, repository: string, key: string) {
  return runtime.createTask({
    objective: 'Implement the bounded provider task.', project: 'Hariari', repository,
    baseRef: 'HEAD', provider: 'claude', idempotencyKey: `${key}-create`,
  });
}

class RecordingClaudeExecutable implements ClaudeExecutablePort {
  readonly calls: string[][] = [];

  constructor(private readonly help = '  --session-id <uuid>\n  -r, --resume [value]\n  --fork-session\n') {}

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return args[0] === '--version'
      ? '2.1.241 (Claude Code)'
      : this.help;
  }
}

class RecordingClaudePty {
  readonly starts: Array<{ readonly file: string; readonly args: readonly string[] }> = [];

  spawn(file: string, args: readonly string[]): RecordingClaudeProcess {
    this.starts.push({ file, args: [...args] });
    const sessionIndex = args.indexOf('--session-id');
    const resumeIndex = args.indexOf('--resume');
    const sessionId = args.includes('--fork-session')
      ? randomUUID()
      : sessionIndex >= 0 ? args[sessionIndex + 1] : args[resumeIndex + 1];
    if (!sessionId) throw new Error('expected Runtime-owned native session identity');
    return new RecordingClaudeProcess(sessionId);
  }
}

class RecordingClaudeProcess {
  readonly pid = 4242;
  private exitListener: ((event: { readonly exitCode: number }) => void) | null = null;

  constructor(private readonly sessionId: string) {}

  onData(listener: (data: string) => void): { dispose(): void } {
    queueMicrotask(() => listener(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: this.sessionId })}\n`));
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { readonly exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => undefined };
  }

  kill(): void {
    queueMicrotask(() => this.exitListener?.({ exitCode: 143 }));
  }
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

async function replaysLegacyClaudeForkEvents(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'legacy-fork-events');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'legacy-start' });
  await runtime.disconnect();
  const forkKey = 'legacy-fork-key';
  await appendLegacyTaskEvent(subject.runtimeDirectory, {
    type: 'ClaudeForkRequested', version: 1, taskId: task.id,
    providerSessionId: parent.providerSession!.id, idempotencyKey: forkKey,
    fingerprint: JSON.stringify([task.id, parent.providerSession!.id]),
  });
  await appendLegacyTaskEvent(subject.runtimeDirectory, {
    type: 'AttemptForked', version: 1, taskId: task.id,
    attempt: { id: 'legacy-child-attempt', number: 2, state: 'starting' },
    parentAttemptId: parent.attempt!.id, parentSessionId: parent.providerSession!.id,
    forkKey,
  });
  await subject.restart();
  const restarted = await subject.connect();
  const recovered = await restarted.startTask({ taskId: task.id, idempotencyKey: 'legacy-start' });
  expect(recovered).toMatchObject({ attempt: { id: 'legacy-child-attempt', state: 'running' },
    providerSession: { parentId: parent.providerSession!.id, lineage: 'fork' } });
  expect(recovered.attempts[0]).toMatchObject({
    id: parent.attempt!.id, state: 'superseded',
  });
  await restarted.disconnect();
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
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), transition.writeCall, transition.mode);
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

async function verifiesLegacyClaudeResumeAlias(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-mismatch-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-mismatch-start' });
  const scope = { repository: task.repository, worktreeId: started.context!.worktreeId,
    branchName: started.context!.branchName };
  const accepted = await subject.legacyClaudeResume({
    taskId: task.id, providerSessionId: started.providerSession!.id, ...scope,
  }, 'legacy-resume');
  expect(accepted).toMatchObject({ ok: true, result: {
    attempt: { id: started.attempt!.id }, providerSession: { id: started.providerSession!.id },
  } });
  expect(JSON.stringify(accepted)).not.toMatch(/nativeSessionId|processId|ptyId/);
  const mismatches = [
    { repository: 'other-checkout', worktreeId: started.context!.worktreeId, branchName: started.context!.branchName },
    { repository: task.repository, worktreeId: 'other-worktree', branchName: started.context!.branchName },
    { repository: task.repository, worktreeId: started.context!.worktreeId, branchName: 'other-branch' },
  ];
  for (const [index, mismatch] of mismatches.entries()) {
    const rejected = await subject.legacyClaudeResume({
      taskId: task.id, providerSessionId: started.providerSession!.id, ...mismatch,
    }, `resume-mismatch-${index}`);
    expect(rejected).toMatchObject({ ok: false, error: { code: 'not-found', retryable: false } });
  }
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  const persistedMismatch = await subject.legacyClaudeResume({
    taskId: task.id, providerSessionId: started.providerSession!.id, ...mismatches[0],
  }, 'resume-mismatch-0');
  expect(persistedMismatch).toMatchObject({ ok: false,
    error: { code: 'not-found', retryable: false } });
  const replayed = await subject.legacyClaudeResume({
    taskId: task.id, providerSessionId: started.providerSession!.id, ...scope,
  }, 'legacy-resume');
  expect(replayed).toMatchObject({ ok: true, result: { attempt: { id: started.attempt!.id } } });
  await verifiesLegacyClaudeForkAlias(
    subject, adapter, restarted, task.id, started.providerSession!.id,
  );
}
async function verifiesLegacyClaudeForkAlias(
  subject: RuntimeSubject,
  adapter: FakeClaudeCodeExecutionAdapter,
  runtime: RuntimeClientSession,
  taskId: string,
  providerSessionId: string,
): Promise<void> {
  adapter.lose(taskId);
  const forked = await subject.legacyClaudeFork({
    taskId, providerSessionId,
  }, 'legacy-fork');
  expect(forked).toMatchObject({ ok: true, result: {
    attempt: { number: 2, state: 'running' },
    providerSession: { parentId: providerSessionId, lineage: 'fork' },
  } });
  expect(JSON.stringify(forked)).not.toMatch(/nativeSessionId|processId|ptyId/);
  await runtime.disconnect();
  await subject.restart();
  const forkReplay = await subject.legacyClaudeFork({
    taskId, providerSessionId,
  }, 'legacy-fork');
  expect(forkReplay.ok && forkReplay.result).toEqual(forked.ok && forked.result);
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
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-start' });
  const resumed = await runtime.resumeProviderSession({
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    idempotencyKey: 'resume-match',
  });
  expect(resumed).toEqual(started);
  expect(adapter.startCount(task.id)).toBe(1);
  expect(JSON.stringify(resumed)).not.toMatch(/nativeSessionId|processId|ptyId/);
  await runtime.disconnect();
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

async function recordsClaudeProviderSession(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Resume this Claude task only in its allocated context.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: 'claude-provider-session-create',
  });

  const started = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: 'claude-provider-session-start',
  });

  expect(started.providerSession).toMatchObject({
    id: expect.stringMatching(/^start-remediation-/),
    provider: 'claude',
    attemptId: started.attempt?.id,
    executionContextId: started.context?.id,
    capabilities: { resume: true, fork: true },
    parentId: null,
    lineage: 'new',
  });
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(started);
  await restarted.disconnect();
}

async function projectsClaudeExecutionHistories(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Retain this Claude execution history.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'main',
    provider: 'claude',
    idempotencyKey: 'history-create',
  });

  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'history-start' });

  expect(started.attempts).toEqual([started.attempt]);
  expect(started.providerSessions).toEqual([started.providerSession]);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  const replayed = await restarted.getTaskExecution(task.id);
  expect(replayed).toEqual(started);
  expect(replayed.attempts).toEqual([replayed.attempt]);
  expect(replayed.providerSessions).toEqual([replayed.providerSession]);
  await restarted.disconnect();
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

async function retainsAmbiguousParentFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopError: new Error('stop failed') });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'unknown-stop-failure');
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'unknown-stop-start' });
  adapter.forget(task.id);
  await expect(runtime.forkProviderSession({
    taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'unknown-stop-fork',
  })).rejects.toEqual(new RuntimePortError('internal', true));
  await expect(runtime.getTaskExecution(task.id)).resolves.toMatchObject({
    attempt: { id: parent.attempt?.id, state: 'superseding' },
    attempts: [{ id: parent.attempt?.id, state: 'superseding' }],
  });
  expect(adapter.startCount(task.id)).toBe(1);
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

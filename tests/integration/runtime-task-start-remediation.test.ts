import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionView } from '../../src/shared/runtime/runtime-interface';
import {
  LocalGenericCliExecutionAdapter,
  type GenericCliExecutionAdapter,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  ClaudeCodeExecutionAdapter,
  type ClaudeExecutablePort,
} from '../../src/runtime/claude-code-execution-adapter';
import { ProviderExecutionAdapterRouter } from '../../src/runtime/provider-execution-adapter-router';
import type { RuntimeLocalEndpoint } from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { createDisposableGitRepository } from '../test-common/disposable-git-repository';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
  ObservedRuntimeTransport,
} from './runtime-test-fakes';
const roots: string[] = [];
const servers: RuntimeServer[] = [];
const FAILED_APPEND_MODES = ['zero-first', 'partial-then-zero', 'partial-then-error'] as const;
const FAILED_ALLOCATION_APPEND_CASES = ['ContextAllocated', 'AttemptFailed'].flatMap(
  (name, index) => FAILED_APPEND_MODES.map((mode) => ({ name, mode, writeCall: index + 3 })),
);
const CLAUDE_LIFECYCLE_APPEND_CASES = [
  { name: 'ClaudeResumeRejected', writeCall: 1 },
  { name: 'ClaudeForkRequested', writeCall: 1 },
  { name: 'AttemptForked', writeCall: 2 },
  { name: 'ContextAllocated', writeCall: 3 },
].flatMap((transition) => FAILED_APPEND_MODES.map((mode) => ({ ...transition, mode })));
describe('authenticated Runtime Task start remediation', registerTaskStartTests);
function registerTaskStartTests(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  it('coalesces concurrent same-key starts from independent sessions', coalescesConcurrentStarts);
  it('records adapter-discovered Claude provider-session identity through the authenticated Runtime seam', recordsClaudeProviderSession);
  it('starts Claude through the production provider adapter', startsProductionClaudeProvider);
  it('passes exact native resume and fork argv through the production Claude adapter', invokesProductionClaudeLifecycle);
  it('persists false Claude capabilities discovered by the production adapter', discoversFalseClaudeCapabilities);
  it('projects immutable Claude attempt and provider-session histories through Runtime restart', projectsClaudeExecutionHistories);
  it('forks a Claude session through the authenticated Runtime seam', forksClaudeSession);
  it('resumes a matching Claude session without allocating another execution', resumesMatchingClaudeSession);
  it('restarts one native Claude process when the owned process is lost', resumesLostClaudeProcess);
  it('records a scope-mismatched Claude resume rejection across restart', rejectsMismatchedClaudeResume);
  it('records an unsupported Claude resume rejection across restart', rejectsUnsupportedClaudeResume);
  it('rejects terminal and noncurrent Claude resumes through public codes', rejectsNoncurrentClaudeResumes);
  it(
    'replays an unattached durable Claude fork as a starting child without inventing a native identity',
    replaysUnattachedClaudeFork,
  );
  it.each(CLAUDE_LIFECYCLE_APPEND_CASES)(
    'repairs $name $mode append failure for same-key Claude lifecycle retry and replay',
    verifiesClaudeLifecycleAppendRecovery,
  );
  it.each(FAILED_ALLOCATION_APPEND_CASES)(
    'preserves an allocated Git context across $name $mode append repair',
    async ({ writeCall, mode }) => preservesFailedContext(writeCall, mode),
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
    nativeSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    capabilities: { resume: true, fork: true },
  });
  expect(started.providerSession?.nativeSessionId).not.toBe(started.attempt?.id);
  expect(executable.calls).toEqual([['--version'], ['--help']]);
  expect(pty.starts).toEqual([{
    file: 'claude',
    args: [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--session-id',
      started.providerSession?.nativeSessionId,
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
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  const resumed = await restarted.resumeClaudeSession!({
    taskId: task.id, providerSessionId: parent.providerSession!.id, repository: task.repository,
    worktreeId: parent.context!.worktreeId, branchName: parent.context!.branchName,
    idempotencyKey: 'production-lifecycle-resume',
  });
  const child = await restarted.forkClaudeSession!({
    taskId: task.id, providerSessionId: resumed.providerSession!.id,
    idempotencyKey: 'production-lifecycle-fork',
  });
  expect(pty.starts.map((start) => start.args)).toEqual([
    [...STRUCTURED_CLAUDE_ARGS, '--session-id', parent.providerSession!.nativeSessionId, task.objective],
    [...STRUCTURED_CLAUDE_ARGS, '--resume', parent.providerSession!.nativeSessionId, task.objective],
    [...STRUCTURED_CLAUDE_ARGS, '--resume', parent.providerSession!.nativeSessionId, '--fork-session', task.objective],
  ]);
  expect(child.providerSession?.nativeSessionId).not.toBe(parent.providerSession?.nativeSessionId);
  expect(executable.calls).toEqual([['--version'], ['--help']]);
  await restarted.disconnect();
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
  await expect(runtime.forkClaudeSession!({
    taskId: task.id, providerSessionId: started.providerSession!.id, idempotencyKey: 'false-capabilities-fork',
  })).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  expect(pty.starts).toHaveLength(1);
  await runtime.disconnect();
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
  const fork = runtime.forkClaudeSession!({ taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'unattached-fork' });
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
    expect(adapter.startsFor(task.id)[2]?.instruction).toEqual({
      kind: 'fork-claude', parentNativeSessionId: parent.providerSession?.nativeSessionId,
      context: parent.context,
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

async function verifiesClaudeLifecycleAppendRecovery(
  transition: (typeof CLAUDE_LIFECYCLE_APPEND_CASES)[number],
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Repair a Claude lifecycle append.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: `claude-${transition.name}-${transition.mode}-create` });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: `claude-${transition.name}-${transition.mode}-start` });
  const resume = { taskId: task.id, providerSessionId: parent.providerSession!.id, repository: 'other-checkout', worktreeId: parent.context!.worktreeId, branchName: parent.context!.branchName, idempotencyKey: `claude-${transition.name}-${transition.mode}` };
  const fork = { taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: resume.idempotencyKey };
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), transition.writeCall, transition.mode);
  if (transition.name === 'ClaudeResumeRejected') {
    await expect(runtime.resumeClaudeSession!(resume)).rejects.toEqual(new RuntimePortError('internal', true));
    await expect(runtime.resumeClaudeSession!(resume)).rejects.toEqual(new RuntimePortError('not-found', false));
  } else if (transition.name === 'ContextAllocated') {
    await expect(runtime.forkClaudeSession!(fork)).resolves.toMatchObject({
      attempt: { number: 2, state: 'running' }, providerSession: { parentId: parent.providerSession!.id },
    });
  } else {
    await expect(runtime.forkClaudeSession!(fork)).rejects.toEqual(new RuntimePortError('internal', true));
    await expect(runtime.forkClaudeSession!(fork)).resolves.toMatchObject({ attempt: { number: 2, state: 'running' } });
  }
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  if (transition.name === 'ClaudeResumeRejected') {
    await expect(restarted.resumeClaudeSession!(resume)).rejects.toEqual(new RuntimePortError('not-found', false));
  } else {
    await expect(restarted.forkClaudeSession!(fork)).resolves.toMatchObject({ attempt: { number: 2, state: 'running' } });
  }
  await restarted.disconnect();
}

async function rejectsMismatchedClaudeResume(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-mismatch-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-mismatch-start' });
  const requests = [
    { repository: 'other-checkout', worktreeId: started.context!.worktreeId, branchName: started.context!.branchName },
    { repository: task.repository, worktreeId: 'other-worktree', branchName: started.context!.branchName },
    { repository: task.repository, worktreeId: started.context!.worktreeId, branchName: 'other-branch' },
  ].map((scope, index) => ({ taskId: task.id, providerSessionId: started.providerSession!.id, ...scope, idempotencyKey: `resume-mismatch-${index}` }));
  for (const request of requests) {
    await expect(runtime.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('not-found', false));
  }
  await expect(runtime.resumeClaudeSession!({ ...requests[0], providerSessionId: '' })).rejects.toEqual(new RuntimePortError('invalid-request', false));
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  for (const request of requests) {
    await expect(restarted.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('not-found', false));
  }
  await restarted.disconnect();
}
async function rejectsUnsupportedClaudeResume(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter({ claudeCapabilities: { resume: false, fork: true } }));
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-unsupported-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-unsupported-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id, repository: task.repository, worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-unsupported' };
  await expect(runtime.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await restarted.disconnect();
}

async function rejectsNoncurrentClaudeResumes(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Reject stale Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'noncurrent-create' });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'noncurrent-start' });
  await runtime.forkClaudeSession!({ taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'noncurrent-fork' });
  await expect(runtime.resumeClaudeSession!(resumeRequest(task, parent, 'noncurrent-resume')))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  const terminal = await runtime.cancelTask({ taskId: task.id, idempotencyKey: 'terminal-cancel' });
  await expect(runtime.resumeClaudeSession!(resumeRequest(task, terminal, 'terminal-resume')))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
}

function resumeRequest(
  task: { readonly id: string; readonly repository: string },
  execution: TaskExecutionView,
  idempotencyKey: string,
) {
  return { taskId: task.id, providerSessionId: execution.providerSession!.id,
    repository: task.repository, worktreeId: execution.context!.worktreeId,
    branchName: execution.context!.branchName, idempotencyKey };
}

async function resumesMatchingClaudeSession(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-start' });
  const resumed = await runtime.resumeClaudeSession!({ taskId: task.id, providerSessionId: started.providerSession!.id, repository: task.repository, worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-match' });
  expect(resumed).toEqual(started);
  expect(adapter.startCount(task.id)).toBe(1);
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
  const resumed = await restarted.resumeClaudeSession!({
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    repository: task.repository,
    worktreeId: started.context!.worktreeId,
    branchName: started.context!.branchName,
    idempotencyKey: 'resume-lost',
  });

  expect(resumed).toEqual(started);
  expect(adapter.startCount(task.id)).toBe(2);
  expect(adapter.startsFor(task.id)[1]?.instruction).toEqual({
    kind: 'resume-claude',
    nativeSessionId: started.providerSession?.nativeSessionId,
    context: started.context,
  });
  await restarted.disconnect();
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
    nativeSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    taskId: task.id,
    attemptId: started.attempt?.id,
    executionContextId: started.context?.id,
    capabilities: { resume: true, fork: true },
    parentId: null,
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
  const childPromise = runtime.forkClaudeSession!(forkRequest);
  await waitForAdapterStarts(adapter, task.id, 2);
  const replayPromise = concurrentRuntime.forkClaudeSession!(forkRequest);
  await subject.transport.waitForRequests('claude.fork', 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(adapter.startCount(task.id)).toBe(2);
  childGate.resolve();
  const [child, concurrentReplay] = await Promise.all([childPromise, replayPromise]);
  expect(concurrentReplay).toEqual(child);
  expectForkedClaude(parent, child, adapter, task.id);
  await concurrentRuntime.disconnect();
  await expect(runtime.forkClaudeSession!({ taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'fork-child' })).resolves.toEqual(child);
  await expect(runtime.forkClaudeSession!({ ...forkRequest, providerSessionId: child.providerSession!.id })).rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(child);
  await restarted.disconnect();
}

function expectForkedClaude(parent: TaskExecutionView, child: TaskExecutionView, adapter: FakeClaudeCodeExecutionAdapter, taskId: string): void {
  expect(child.attempt).toMatchObject({ number: 2, state: 'running' });
  expect(child.attempt?.id).not.toBe(parent.attempt?.id);
  expect(child.providerSession).toMatchObject({ parentId: parent.providerSession!.id });
  expect(child.providerSession?.id).not.toBe(parent.providerSession?.id);
  expect(child.providerSession?.nativeSessionId).not.toBe(parent.providerSession?.nativeSessionId);
  expect(adapter.startsFor(taskId)[1]?.instruction).toEqual({
    kind: 'fork-claude', parentNativeSessionId: parent.providerSession?.nativeSessionId,
    context: parent.context,
  });
  expect(child.context).toMatchObject({
    worktreeId: parent.context!.worktreeId,
    branchName: parent.context!.branchName,
  });
  expect(child.attempts).toEqual([parent.attempt, child.attempt]);
  expect(child.providerSessions).toEqual([parent.providerSession, child.providerSession]);
  expect(adapter.startCount(taskId)).toBe(2);
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
    (runtimeDirectory) =>
      new LocalGenericCliExecutionAdapter({
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
      processId: expect.stringMatching(/^start-remediation-/),
      ptyId: expect.stringMatching(/^start-remediation-/),
    },
  });
  expect(JSON.stringify(failed.context)).not.toContain(runtimeDirectory);
  expect(Object.keys(failed.context ?? {}).sort()).toEqual([
    'baseCommit',
    'branchName',
    'id',
    'processId',
    'ptyId',
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

function createTestRepository(): { readonly path: string; readonly baseCommit: string } {
  const repository = createDisposableGitRepository({
    temporaryPrefix: 'hariari-failed-allocation-',
    readmeContents: '# Failed allocation\n',
    commitMessage: 'failed allocation fixture',
    authorName: 'Runtime Test',
    authorEmail: 'runtime@example.test',
  });
  roots.push(repository.root);
  return repository;
}

function shellTask(idempotencyKey: string, repository: string) {
  return {
    objective: 'Exercise Runtime-owned Task start.',
    project: 'Hariari',
    repository,
    baseRef: 'HEAD',
    provider: 'shell' as const,
    idempotencyKey,
  };
}

interface RuntimeSubject {
  readonly runtimeDirectory: string;
  readonly transport: ObservedRuntimeTransport;
  connect(): Promise<RuntimeClientSession>;
  restart(): Promise<void>;
}

async function createSubject(
  adapterFactory: (runtimeDirectory: string) => GenericCliExecutionAdapter,
): Promise<RuntimeSubject> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-start-remediation-'));
  roots.push(root);
  const runtimeDirectory = path.join(root, 'runtime');
  const endpoint = {
    kind: 'unix' as const,
    address: path.join(root, 'runtime.sock'),
    runtimeDirectory,
  };
  const token = new Uint8Array(32).fill(47);
  const transport = new ObservedRuntimeTransport();
  let id = 0;
  const randomId = (): string => `start-remediation-${++id}-${randomUUID()}`;
  const adapter = adapterFactory(runtimeDirectory);
  let server = serverFor(endpoint, token, transport, randomId, adapter);
  servers.push(server);
  await server.start();
  return {
    runtimeDirectory,
    transport,
    connect: () => connect(endpoint, token, transport, randomId),
    restart: async () => {
      await server.stop();
      server = serverFor(endpoint, token, transport, randomId, adapter);
      servers.push(server);
      await server.start();
    },
  };
}

function serverFor(
  endpoint: RuntimeLocalEndpoint,
  token: Uint8Array,
  transport: ObservedRuntimeTransport,
  randomId: () => string,
  executionAdapter: GenericCliExecutionAdapter,
): RuntimeServer {
  return new RuntimeServer({
    transport,
    endpoint,
    token,
    supportedProtocolRange: { min: 1, max: 1 },
    runtimeVersion: '0.6.8',
    buildId: 'start-remediation-build',
    now: () => Date.parse('2026-08-21T10:00:00.000Z'),
    randomId,
    randomNonce: randomId,
    handshakeDeadlineMs: 500,
    requestDeadlineMs: 500,
    executionAdapter,
  });
}

async function connect(
  endpoint: RuntimeLocalEndpoint,
  token: Uint8Array,
  transport: ObservedRuntimeTransport,
  randomId: () => string,
): Promise<RuntimeClientSession> {
  const result = await new NodeRuntimeClient({
    transport,
    randomId,
    randomNonce: randomId,
  }).connect(endpoint, token, {
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange: { min: 1, max: 1 },
    deadlineMs: 500,
  });
  if (result.kind !== 'connected') throw new Error('expected authenticated Runtime session');
  return result.session;
}

function corruptExecutionAppend(
  eventPath: string,
  failedWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
): void {
  const open = fs.promises.open.bind(fs.promises);
  let writes = 0;
  let partial = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, permissions) => {
    const handle = await open(file, flags, permissions);
    if (file !== eventPath || flags !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== 'write') return Reflect.get(target, property, receiver);
        return async (data: Buffer) => {
          writes += 1;
          if (writes === failedWrite && mode === 'zero-first') {
            return { bytesWritten: 0, buffer: data };
          }
          if (writes === failedWrite) {
            partial = true;
            return target.write(data.subarray(0, 1));
          }
          if (partial && writes === failedWrite + 1) {
            if (mode === 'partial-then-error') throw new Error('injected append error');
            return { bytesWritten: 0, buffer: data };
          }
          return target.write(data);
        };
      },
    });
  });
}

function nextRuntimeTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import {
  ClaudeCodeExecutionAdapter,
  type ClaudeExecutablePort,
} from '../../src/runtime/claude-code-execution-adapter';
import {
  LocalGenericCliExecutionAdapter,
} from '../../src/runtime/generic-cli-execution-adapter';
import { ProviderExecutionAdapterRouter } from '../../src/runtime/provider-execution-adapter-router';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import { createSubject, createTestRepository, type RuntimeSubject } from './runtime-task-test-harness';

describe('authenticated Runtime Claude provider-session contract', registerClaudeProviderSessionTests);

function registerClaudeProviderSessionTests(): void {
  it('records adapter-discovered Claude provider-session identity through the authenticated Runtime seam', recordsClaudeProviderSession);
  it('starts Claude through the production provider adapter', startsProductionClaudeProvider);
  it('reattaches live and passes fork argv through the production Claude adapter', invokesProductionClaudeLifecycle);
  it('chooses resume then fork from production recovery observations', choosesProductionRecovery);
  it('persists false Claude capabilities discovered by the production adapter', discoversFalseClaudeCapabilities);
  it('projects immutable Claude attempt and provider-session histories through Runtime restart', projectsClaudeExecutionHistories);
}

async function recordsClaudeProviderSession(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'provider-session');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'provider-session-start' });

  expect(started.providerSession).toMatchObject({
    id: expect.stringMatching(/^start-remediation-/), provider: 'claude',
    attemptId: started.attempt?.id, executionContextId: started.context?.id,
    capabilities: { resume: true, fork: true }, parentId: null, lineage: 'new',
  });
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(started);
  await restarted.disconnect();
}

async function startsProductionClaudeProvider(): Promise<void> {
  const repository = createTestRepository();
  const executable = new RecordingClaudeExecutable();
  const pty = new RecordingClaudePty();
  const subject = await createProductionClaudeSubject(executable, pty);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, repository.path, 'production-claude');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'production-claude-start' });

  expect(started.providerSession).toMatchObject({ capabilities: { resume: true, fork: true }, lineage: 'new' });
  expect(JSON.stringify(started)).not.toMatch(/nativeSessionId|processId|ptyId/);
  expect(executable.calls).toEqual([['--version'], ['--help']]);
  expect(pty.starts).toEqual([{
    file: 'claude',
    args: [...STRUCTURED_CLAUDE_ARGS, '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/), task.objective],
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
    taskId: task.id, providerSessionId: parent.providerSession!.id, idempotencyKey: 'production-lifecycle-resume',
  });
  const child = await runtime.forkProviderSession({
    taskId: task.id, providerSessionId: resumed.providerSession!.id, idempotencyKey: 'production-lifecycle-fork',
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

async function choosesProductionRecovery(): Promise<void> {
  const repository = createTestRepository();
  const firstPty = new RecordingClaudePty();
  const subject = await createProductionClaudeSubject(new RecordingClaudeExecutable(), firstPty);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, repository.path, 'production-recovery');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'production-recovery-start' });
  await runtime.disconnect();
  const secondPty = new RecordingClaudePty();
  await subject.restartWith(productionClaudeAdapter(
    subject.runtimeDirectory, new RecordingClaudeExecutable(), secondPty,
  ));
  const restarted = await subject.connect();

  await expectCommittedRecovery(restarted, task.id, 'production-recovery-resume-choice', 'resume');
  const resumed = await restarted.resumeProviderSession({
    taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: 'production-recovery-resume',
  });
  expect(resumed.providerSession).toMatchObject({ lineage: 'native-resume' });
  await restarted.disconnect();
  const thirdPty = new RecordingClaudePty();
  await subject.restartWith(productionClaudeAdapter(
    subject.runtimeDirectory, new RecordingClaudeExecutable(), thirdPty,
  ));
  const recovered = await subject.connect();
  await expectCommittedRecovery(recovered, task.id, 'production-recovery-fork-choice', 'fork');
  expect(thirdPty.starts).toEqual([]);
  await recovered.disconnect();
}

async function expectCommittedRecovery(
  runtime: RuntimeClientSession,
  taskId: string,
  key: string,
  decision: 'resume' | 'fork',
): Promise<void> {
  const recovery = await runtime.reconcileTask({ taskId, idempotencyKey: key });
  expect(recovery).toMatchObject({ status: 'ready', decision, attention: null });
  await expect(runtime.recoverTask({
    taskId, recoveryId: recovery.id, idempotencyKey: `${key}-commit`,
  })).resolves.toMatchObject({ status: 'decided', decision, attention: null });
}

async function discoversFalseClaudeCapabilities(): Promise<void> {
  const executable = new RecordingClaudeExecutable('  --session-id <uuid>\n');
  const pty = new RecordingClaudePty();
  const subject = await createProductionClaudeSubject(executable, pty);
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, createTestRepository().path, 'false-capabilities');
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'false-capabilities-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id, idempotencyKey: 'false-capabilities-fork' };

  expect(started.providerSession?.capabilities).toEqual({ resume: false, fork: false });
  await expect(runtime.forkProviderSession(request)).rejects.toMatchObject({ code: 'unsupported-operation' });
  expect(pty.starts).toHaveLength(1);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.forkProviderSession(request)).rejects.toMatchObject({ code: 'unsupported-operation' });
  await expect(restarted.forkProviderSession({ ...request, providerSessionId: 'different-session' })).rejects.toMatchObject({ code: 'idempotency-conflict' });
  await restarted.disconnect();
}

async function projectsClaudeExecutionHistories(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await createClaudeTask(runtime, 'fake-checkout', 'history');
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

const STRUCTURED_CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'] as const;

async function createProductionClaudeSubject(executable: RecordingClaudeExecutable, pty: RecordingClaudePty): Promise<RuntimeSubject> {
  return createSubject((runtimeDirectory) => productionClaudeAdapter(runtimeDirectory, executable, pty));
}

function productionClaudeAdapter(
  runtimeDirectory: string,
  executable: RecordingClaudeExecutable,
  pty: RecordingClaudePty,
): ProviderExecutionAdapterRouter {
  return new ProviderExecutionAdapterRouter({
    shell: new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    claude: new ClaudeCodeExecutionAdapter({ runtimeDirectory, executable, pty }),
  });
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
    return args[0] === '--version' ? '2.1.241 (Claude Code)' : this.help;
  }
}

class RecordingClaudePty {
  readonly starts: Array<{ readonly file: string; readonly args: readonly string[] }> = [];

  spawn(file: string, args: readonly string[]): RecordingClaudeProcess {
    this.starts.push({ file, args: [...args] });
    const sessionIndex = args.indexOf('--session-id');
    const resumeIndex = args.indexOf('--resume');
    const sessionId = args.includes('--fork-session') ? randomUUID() : args[sessionIndex >= 0 ? sessionIndex + 1 : resumeIndex + 1];
    if (!sessionId) throw new Error('expected Runtime-owned native session identity');
    return new RecordingClaudeProcess(sessionId);
  }
}

class RecordingClaudeProcess {
  readonly pid = 2_147_483_647;
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

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
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { createDisposableGitRepository } from '../test-common/disposable-git-repository';
import { FakeGenericCliExecutionAdapter } from './runtime-test-fakes';

const roots: string[] = [];
const servers: RuntimeServer[] = [];
const FAILED_APPEND_MODES = ['zero-first', 'partial-then-zero', 'partial-then-error'] as const;
const FAILED_ALLOCATION_APPEND_CASES = ['ContextAllocated', 'AttemptFailed'].flatMap(
  (name, index) => FAILED_APPEND_MODES.map((mode) => ({ name, mode, writeCall: index + 3 })),
);

describe('authenticated Runtime Task start remediation', registerTaskStartTests);

function registerTaskStartTests(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  it('coalesces concurrent same-key starts from independent sessions', coalescesConcurrentStarts);
  it(
    'records adapter-discovered Claude provider-session identity through the authenticated Runtime seam',
    recordsClaudeProviderSession,
  );
  it('resumes a matching Claude session without allocating another execution', resumesMatchingClaudeSession);
  it('records a scope-mismatched Claude resume rejection across restart', rejectsMismatchedClaudeResume);
  it('records an unsupported Claude resume rejection across restart', rejectsUnsupportedClaudeResume);
  it.each(FAILED_ALLOCATION_APPEND_CASES)(
    'preserves an allocated Git context across $name $mode append repair',
    async ({ writeCall, mode }) => preservesFailedContext(writeCall, mode),
  );
}

async function rejectsMismatchedClaudeResume(): Promise<void> {
  const subject = await createSubject(() => new FakeGenericCliExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-mismatch-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-mismatch-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id, repository: 'other-checkout', worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-mismatch' };
  await expect(runtime.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('not-found', false));
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('not-found', false));
  await restarted.disconnect();
}

async function rejectsUnsupportedClaudeResume(): Promise<void> {
  const subject = await createSubject(() => new FakeGenericCliExecutionAdapter({ claudeCapabilities: { resume: false, fork: true } }));
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-unsupported-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-unsupported-start' });
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id, repository: task.repository, worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-unsupported' };
  await expect(runtime.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.resumeClaudeSession!(request)).rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await restarted.disconnect();
}

async function resumesMatchingClaudeSession(): Promise<void> {
  const adapter = new FakeGenericCliExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Resume Claude.', project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude', idempotencyKey: 'resume-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: 'resume-start' });
  const resumed = await runtime.resumeClaudeSession!({ taskId: task.id, providerSessionId: started.providerSession!.id, repository: task.repository, worktreeId: started.context!.worktreeId, branchName: started.context!.branchName, idempotencyKey: 'resume-match' });
  expect(resumed).toEqual(started);
  expect(adapter.startCount(task.id)).toBe(1);
  await runtime.disconnect();
}

async function recordsClaudeProviderSession(): Promise<void> {
  const subject = await createSubject(() => new FakeGenericCliExecutionAdapter());
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
    nativeSessionId: expect.stringMatching(/^claude-/),
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

class ObservedRuntimeTransport extends NodeLocalRuntimeTransport {
  private readonly requestCounts = new Map<string, number>();
  private readonly requestWaiters = new Map<string, Set<() => void>>();

  override listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    return super.listen(endpoint, (connection) => onConnection(this.observe(connection)));
  }

  waitForRequests(operation: string, count: number): Promise<void> {
    if ((this.requestCounts.get(operation) ?? 0) >= count) return Promise.resolve();
    return new Promise((resolve) => {
      const key = `${operation}:${count}`;
      const waiters = this.requestWaiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.requestWaiters.set(key, waiters);
    });
  }

  private observe(connection: RuntimeFrameConnection): RuntimeFrameConnection {
    return {
      readFrame: async (deadlineMs) => {
        const frame = await connection.readFrame(deadlineMs);
        this.record(frame);
        return frame;
      },
      writeFrame: (frame, deadlineMs) => connection.writeFrame(frame, deadlineMs),
      onClose: (listener) => connection.onClose(listener),
      close: () => connection.close(),
    };
  }

  private record(frame: Record<string, unknown>): void {
    const operation = frame.operation;
    if (!operation || typeof operation !== 'object' || !('name' in operation)) return;
    const name = operation.name;
    if (typeof name !== 'string') return;
    const count = (this.requestCounts.get(name) ?? 0) + 1;
    this.requestCounts.set(name, count);
    const key = `${name}:${count}`;
    for (const resolve of this.requestWaiters.get(key) ?? []) resolve();
    this.requestWaiters.delete(key);
  }
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

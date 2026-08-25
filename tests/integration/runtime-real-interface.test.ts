import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { LocalRuntimeEndpointPort } from '../../src/main/runtime/local-endpoint-port';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import type {
  RuntimeArtifactPort,
  RuntimeEndpoint,
  RuntimeProcessPort,
} from '../../src/main/runtime/runtime-ports';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import type { RuntimeInterface } from '../../src/shared/runtime/runtime-interface';
import {
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';
import type { GenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';
import { FakeGenericCliExecutionAdapter } from './runtime-test-fakes';
import { corruptExpectedExecutionAppend } from './runtime-task-test-harness';
import { createDisposableGitRepository } from '../test-common/disposable-git-repository';

const directories: string[] = [];
const servers: RuntimeServer[] = [];
const EXECUTION_APPEND_BOUNDARIES = [
  startBoundary('RunCreated', 1, 'RunCreated', 'completed', true, 0),
  startBoundary('AttemptCreated', 2, 'AttemptCreated', 'completed', true, 0),
  startBoundary('ContextAllocated', 3, 'ContextAllocated', 'failed', true),
  startBoundary('AttemptStarted', 4, 'AttemptStarted', 'failed', true),
  startBoundary(
    'NormalizedAttemptStarted', 5, 'NormalizedRuntimeEventRecorded', 'completed', false, 0,
    'attempt-started',
  ),
  startBoundary('AttemptCompleted', 6, 'AttemptCompleted', 'completed', false, 0),
  startBoundary(
    'NormalizedAttemptCompleted', 7, 'NormalizedRuntimeEventRecorded', 'completed', false, 0,
    'attempt-completed',
  ),
  startBoundary('AttemptFailed', 6, 'AttemptFailed', 'failed', false, 1),
  startBoundary(
    'NormalizedAttemptFailed', 7, 'NormalizedRuntimeEventRecorded', 'failed', false, 1,
    'attempt-failed',
  ),
] as const;
const EXECUTION_APPEND_FAILURE_MODES = ['zero-first', 'partial-then-zero', 'partial-then-error'] as const;

type ExecutionAppendTransition = (typeof EXECUTION_APPEND_BOUNDARIES)[number];
type ExecutionAppendFailureMode = (typeof EXECUTION_APPEND_FAILURE_MODES)[number];

describe('real local Runtime Interface vertical', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanRuntimeFixtures();
  });
  it(
    'starts, reconnects, queries health, disconnects, and shuts down through the public seam',
    verifiesRealRuntimeLifecycle,
  );
  it('waits for endpoint termination before public shutdown reports stopped', verifiesShutdown);
  it(
    'keeps a healthy idle session connected across multiple server request deadlines',
    verifiesIdleHealthSupervision,
  );
  it(
    'creates, lists, idempotently replays, and rebuilds durable Tasks through RuntimeInterface',
    verifiesDurableTasks,
  );
  it('replays a Task after a forced short event write', replaysTaskAfterShortWrite);
  it(
    'repairs a partial event write before an idempotent retry survives restart',
    repairsPartialEventWriteBeforeRetry,
  );
  it('reports malformed Task creates as non-retryable invalid requests', rejectsMalformedTasks);
  it('rejects an overlong Task idempotency key without losing transport', rejectsOverlongTaskKey);
  it(
    'runs one shell Task in a task-owned Git worktree and streams its live terminal output',
    runsShellTaskTracer,
  );
  it(
    'repairs a partial execution transition before the same start key retries and replays',
    repairsPartialExecutionTransition,
  );
  registerExecutionAppendFailureTests();
  it('keeps logical provider slugs creatable and fails their first start safely', failsLogicalProviderStart);
});

function registerExecutionAppendFailureTests(): void {
  for (const mode of EXECUTION_APPEND_FAILURE_MODES) {
    it.each(EXECUTION_APPEND_BOUNDARIES)(
      `repairs $name ${mode} append failure through the public execution seam`,
      async (transition) => verifiesExecutionAppendRecovery(transition, mode),
    );
  }
}

async function verifiesExecutionAppendRecovery(
  transition: ExecutionAppendTransition,
  mode: ExecutionAppendFailureMode,
): Promise<void> {
  const subject = await createFaultedExecutionSubject(transition, mode);
  const request = { taskId: subject.task.id, idempotencyKey: 'faulted-execution-start' };
  if (transition.startRejects) {
    await expect(subject.runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    const retried = await subject.runtime.startTask(request);
    if (transition.exitCode !== null) subject.adapter.exit(subject.task.id, transition.exitCode);
    else expect(retried).toMatchObject({ task: { executionState: 'failed' } });
  } else {
    await expect(subject.runtime.startTask(request)).resolves.toMatchObject({
      task: { executionState: 'running' },
    });
    subject.adapter.exit(subject.task.id, transition.exitCode ?? 0);
  }
  await waitForTerminalExecution(subject.runtime, subject.task.id, transition.terminalState);
  await expect(subject.runtime.startTask(request)).resolves.toMatchObject({
    task: { executionState: transition.terminalState },
  });
  subject.fault.assertObserved();
  await assertExecutionReplay(subject.fixture, subject.runtime, subject.task.id, transition.terminalState);
}

async function createFaultedExecutionSubject(
  transition: ExecutionAppendTransition,
  mode: ExecutionAppendFailureMode,
): Promise<{
  readonly adapter: FakeGenericCliExecutionAdapter;
  readonly fault: ReturnType<typeof corruptExpectedExecutionAppend>;
  readonly fixture: RealRuntimeFixture;
  readonly runtime: RuntimeInterface;
  readonly task: { readonly id: string };
}> {
  const adapter = new FakeGenericCliExecutionAdapter();
  const fixture = await createRealRuntimeFixture({ executionAdapter: adapter });
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const task = await runtime.createTask({
    objective: 'Recover one deterministic execution append.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'shell',
    idempotencyKey: 'faulted-execution-create',
  });
  const fault = corruptExpectedExecutionAppend(
    path.join(fixture.runtimeDirectory, 'tasks', 'events.log'),
    {
      operation: 'task.start',
      writeCall: transition.writeCall,
      eventType: transition.eventType,
      normalizedKind: transition.normalizedKind,
    },
    mode,
  );
  return { adapter, fault, fixture, runtime, task };
}

async function waitForTerminalExecution(
  runtime: RuntimeInterface,
  taskId: string,
  state: 'completed' | 'failed',
): Promise<void> {
  await waitForCondition(async () => {
    const execution = await runtime.getTaskExecution(taskId);
    if (execution.attempt?.state !== state) {
      return null;
    }
    const timeline = await runtime.getTaskTimeline(taskId);
    return timeline.normalizedEvents.some((event) => event.kind === `attempt-${state}`)
      ? execution
      : null;
  });
}

async function assertExecutionReplay(
  fixture: RealRuntimeFixture,
  runtime: RuntimeInterface,
  taskId: string,
  state: 'completed' | 'failed',
): Promise<void> {
  const tasks = await runtime.listTasks();
  const execution = await runtime.getTaskExecution(taskId);
  const timeline = await runtime.getTaskTimeline(taskId);
  await runtime.disconnect();
  await servers[0]?.stop();
  fs.rmSync(path.join(fixture.runtimeDirectory, 'tasks', 'projection.json'));
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.listTasks()).resolves.toEqual(tasks);
  await expect(restarted.getTaskExecution(taskId)).resolves.toEqual(execution);
  await expect(restarted.getTaskTimeline(taskId)).resolves.toEqual(timeline);
  expect(timeline.normalizedEvents.filter((event) => event.kind === `attempt-${state}`))
    .toHaveLength(1);
  await restarted.disconnect();
}

function startBoundary(
  name: string,
  writeCall: number,
  eventType: string,
  terminalState: 'completed' | 'failed',
  startRejects: boolean,
  exitCode: number | null = null,
  normalizedKind?: string,
) {
  return {
    name, writeCall, eventType, terminalState, startRejects, exitCode, normalizedKind,
  } as const;
}

async function failsLogicalProviderStart(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const task = await runtime.createTask({
    objective: 'Do not launch an unallowlisted provider.',
    project: 'Hariari',
    repository: 'hariari-app/hariari',
    baseRef: 'main',
    provider: 'codex',
    idempotencyKey: 'logical-provider-create',
  });

  await expect(
    runtime.startTask({ taskId: task.id, idempotencyKey: 'logical-provider-start' }),
  ).rejects.toEqual(new RuntimePortError('process-start-failed', true));
  await expect(runtime.getTaskExecution(task.id)).resolves.toMatchObject({
    task: { id: task.id, executionState: 'failed' },
    run: { number: 1 },
    attempt: { number: 1, state: 'failed' },
    context: null,
  });
}

async function repairsPartialExecutionTransition(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const repository = createRuntimeGitRepository();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const task = await runtime.createTask({
    objective: 'Repair the execution append before starting.',
    project: 'Hariari',
    repository: repository.path,
    baseRef: 'HEAD',
    provider: 'shell',
    idempotencyKey: 'partial-execution-create',
  });
  const eventPath = path.join(fixture.runtimeDirectory, 'tasks', 'events.log');
  corruptSecondExecutionAppend(eventPath);
  const request = { taskId: task.id, idempotencyKey: 'partial-execution-start' };

  await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
  await expect(runtime.startTask(request)).resolves.toMatchObject({
    task: { executionState: 'running' },
    run: { number: 1 },
    attempt: { number: 1 },
  });
  await waitForCondition(async () => {
    const execution = await runtime.getTaskExecution(task.id);
    return execution.attempt?.state === 'completed' ? execution : null;
  });
  await runtime.disconnect();

  await servers[0]?.stop();
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.getTaskExecution(task.id)).resolves.toMatchObject({
    task: { executionState: 'completed' },
    attempt: { state: 'completed', exitCode: 0 },
    context: { baseCommit: repository.baseCommit },
  });
  await restarted.disconnect();
}

function corruptSecondExecutionAppend(eventPath: string): void {
  const open = fs.promises.open.bind(fs.promises);
  let writes = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (file !== eventPath || flags !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== 'write') return Reflect.get(target, property, receiver);
        return async (data: Buffer) => {
          writes += 1;
          if (writes === 2) return target.write(data.subarray(0, 1));
          if (writes === 3) return { bytesWritten: 0, buffer: data };
          return target.write(data);
        };
      },
    });
  });
}

async function runsShellTaskTracer(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const repository = createRuntimeGitRepository();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const task = await runtime.createTask({
    objective: 'Run the deterministic Generic CLI tracer.',
    project: 'Hariari',
    repository: repository.path,
    baseRef: 'HEAD',
    provider: 'shell',
    idempotencyKey: 'shell-tracer-create',
  });
  const output: string[] = [];
  const unsubscribe = await runtime.subscribeTaskOutput(task.id, (event) => {
    if (event.kind === 'data') output.push(event.data);
  });

  const started = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: 'shell-tracer-start',
  });
  await waitForCondition(async () => {
    const execution = await runtime.getTaskExecution(task.id);
    return execution.attempt?.state === 'completed' ? execution : null;
  });
  const completed = await runtime.getTaskExecution(task.id);
  unsubscribe();

  expect(started).toMatchObject({
    task: { id: task.id, executionState: 'running' },
    run: { number: 1 },
    attempt: { number: 1, state: 'running' },
    context: { branchName: expect.stringMatching(/^hariari\/task-/) },
  });
  expect(completed).toMatchObject({
    task: { id: task.id, executionState: 'completed' },
    attempt: { state: 'completed', exitCode: 0 },
    context: { baseCommit: repository.baseCommit },
  });
  expect(output.join('')).toContain('hariari-runtime-tracer');
  expect(JSON.stringify(completed.context)).not.toContain(repository.path);
}

function createRuntimeGitRepository(): { readonly path: string; readonly baseCommit: string } {
  const repository = createDisposableGitRepository({
    temporaryPrefix: 'hariari-runtime-task-repository-',
    readmeContents: '# Runtime tracer\n',
    commitMessage: 'initial runtime tracer fixture',
    authorName: 'Runtime Test',
    authorEmail: 'runtime@example.test',
  });
  directories.push(repository.root);
  return repository;
}

async function waitForCondition<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await waitFor(10);
  }
  throw new Error('condition was not met');
}

async function replaysTaskAfterShortWrite(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const eventPath = path.join(fixture.runtimeDirectory, 'tasks', 'events.log');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (file !== eventPath || flags !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== 'write') return Reflect.get(target, property, receiver);
        return async (data: Buffer) =>
          target.write(data.subarray(0, data.length === 1 ? 1 : data.length - 1));
      },
    });
  });
  const created = await runtime.createTask(taskRequest('short-write'));
  await runtime.disconnect();

  await servers[0]?.stop();
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.listTasks()).resolves.toEqual([created]);
  await restarted.disconnect();
}

async function repairsPartialEventWriteBeforeRetry(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const eventPath = path.join(fixture.runtimeDirectory, 'tasks', 'events.log');
  const open = fs.promises.open.bind(fs.promises);
  let writes = 0;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (file !== eventPath || flags !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== 'write') return Reflect.get(target, property, receiver);
        return async (data: Buffer) => {
          writes += 1;
          if (writes === 1) return target.write(data.subarray(0, 1));
          if (writes === 2) return { bytesWritten: 0, buffer: data };
          return target.write(data);
        };
      },
    });
  });
  const request = taskRequest('partial-zero-retry');

  await expect(runtime.createTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
  const created = await runtime.createTask(request);
  await runtime.disconnect();

  await servers[0]?.stop();
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.listTasks()).resolves.toEqual([created]);
  await restarted.disconnect();
}

async function rejectsMalformedTasks(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await runtime.disconnect();
  const client = new NodeRuntimeClient({
    transport: fixture.transport,
    randomId: () => crypto.randomUUID(),
    randomNonce: () => crypto.randomUUID(),
  });
  const connected = await client.connect(fixture.endpoint, new Uint8Array(32).fill(91), {
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange: { min: 1, max: 2 },
    deadlineMs: 500,
  });
  if (connected.kind !== 'connected') throw new Error('expected connected Runtime');

  await expect(
    connected.session.createTask({ ...taskRequest('missing-objective'), objective: ' ' }),
  ).rejects.toEqual(new RuntimePortError('invalid-request', false));
  await expect(
    connected.session.createTask({ ...taskRequest('bad-provider'), provider: 'invalid' } as never),
  ).rejects.toEqual(new RuntimePortError('invalid-request', false));
  await connected.session.disconnect();
}

async function rejectsOverlongTaskKey(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });

  await expect(runtime.createTask(taskRequest('x'.repeat(129)))).rejects.toEqual(
    new RuntimePortError('invalid-request', false),
  );
  await expect(runtime.createTask(taskRequest('x'.repeat(128)))).resolves.toMatchObject({
    objective: 'Make durable task creation observable.',
  });
  await runtime.disconnect();
}

function taskRequest(idempotencyKey: string) {
  return {
    objective: 'Make durable task creation observable.',
    project: 'Hariari',
    repository: 'hariari-app/hariari',
    baseRef: 'main',
    provider: 'codex' as const,
    idempotencyKey,
  };
}

async function verifiesDurableTasks(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const request = taskRequest('task-create-one');

  const created = await runtime.createTask(request);
  await expect(
    Promise.all([runtime.createTask(request), runtime.createTask(request)]),
  ).resolves.toEqual([created, created]);
  await expect(
    runtime.createTask({ ...request, objective: 'A different task with the same key' }),
  ).rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await expect(runtime.listTasks()).resolves.toEqual([created]);
  await runtime.disconnect();

  await servers[0]?.stop();
  fs.rmSync(path.join(fixture.runtimeDirectory, 'tasks', 'projection.json'));
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.listTasks()).resolves.toEqual([created]);
  await restarted.disconnect();
}

async function verifiesIdleHealthSupervision(): Promise<void> {
  const fixture = await createRealRuntimeFixture({
    requestDeadlineMs: 80,
    healthPollIntervalMs: 20,
  });
  const runtime = fixture.createInterface();
  const observed: Array<Awaited<ReturnType<RuntimeInterface['queryHealth']>>> = [];
  runtime.subscribeStatus((state) => observed.push(state));
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const connectedAt = observed.findIndex((state) => state.state === 'connected');

  await waitFor(260);

  expect(observed.slice(connectedAt)).toHaveLength(1);
  expect(observed.at(-1)?.state).toBe('connected');
  await runtime.disconnect();
}

async function verifiesShutdown(): Promise<void> {
  const fixture = await createRealRuntimeFixture({ gateShutdown: true });
  const runtime = fixture.createInterface();
  const connected = await runtime.connectOrStart();
  if (connected.state !== 'connected') throw new Error('expected connected Runtime');
  let settled = false;
  const shutdown = runtime
    .shutdown({
      idempotencyKey: 'termination-shutdown',
      expectedInstanceId: connected.health.instanceId,
      reason: 'test',
    })
    .then((result) => {
      settled = true;
      return result;
    });

  await fixture.transport.closeRequested;
  const settledBeforeEndpointRelease = settled;
  fixture.transport.releaseClose();
  expect(settledBeforeEndpointRelease).toBe(false);
  await expect(shutdown).resolves.toEqual({
    state: 'stopped',
    instanceId: connected.health.instanceId,
  });
  await expect(fixture.transport.connect(fixture.endpoint, 50)).rejects.toMatchObject({
    code: 'endpoint-unavailable',
  });
}

async function verifiesRealRuntimeLifecycle(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const first = fixture.createInterface();
  const connected = await first.connectOrStart();
  expect(connected).toMatchObject({
    state: 'connected',
    health: {
      instanceId: servers[0].identity.instanceId,
      buildId: 'build-19',
      startedAt: '2026-08-20T10:00:00.000Z',
      protocolVersion: 2,
    },
  });
  await first.disconnect();
  const second = fixture.createInterface();
  const reconnected = await second.connectOrStart();
  expect(reconnected).toMatchObject({
    state: 'connected',
    health: { instanceId: servers[0].identity.instanceId },
  });
  expect(fixture.launches.value).toBe(1);
  await shutdownConnectedRuntime(second, reconnected);
}

async function shutdownConnectedRuntime(
  runtime: RuntimeInterface,
  state: Awaited<ReturnType<RuntimeInterface['connectOrStart']>>,
): Promise<void> {
  if (state.state !== 'connected') throw new Error('expected connected Runtime');
  await expect(
    runtime.shutdown({
      idempotencyKey: 'vertical-shutdown',
      expectedInstanceId: state.health.instanceId,
      reason: 'test',
    }),
  ).resolves.toEqual({
    state: 'stopped',
    instanceId: state.health.instanceId,
  });
}

interface RealRuntimeFixture {
  readonly launches: { value: number };
  readonly createInterface: () => RuntimeInterface;
  readonly endpoint: RuntimeEndpoint;
  readonly runtimeDirectory: string;
  readonly transport: GatedCloseTransport;
}

interface RealRuntimeFixtureOptions {
  readonly executionAdapter?: GenericCliExecutionAdapter;
  readonly gateShutdown?: boolean;
  readonly requestDeadlineMs?: number;
  readonly healthPollIntervalMs?: number;
}

async function createRealRuntimeFixture(
  options: RealRuntimeFixtureOptions = {},
): Promise<RealRuntimeFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-vertical-'));
  directories.push(root);
  const runtimeDirectory = path.join(root, 'state');
  const tokens = new ProtectedRuntimeTokenStore(runtimeDirectory, () =>
    new Uint8Array(32).fill(91),
  );
  const endpoints = new LocalRuntimeEndpointPort(runtimeDirectory, {
    temporaryDirectory: root,
    userId: 'test-user',
  });
  const endpoint = await endpoints.resolve();
  const transport = new GatedCloseTransport(options.gateShutdown ?? false);
  let id = 0;
  const randomId = (): string => `vertical-${++id}`;
  const launches = { value: 0 };
  const processes = createProcessPort({
    tokens,
    endpoint,
    transport,
    randomId,
    launches,
    requestDeadlineMs: options.requestDeadlineMs,
    executionAdapter: options.executionAdapter,
  });
  const artifacts: RuntimeArtifactPort = {
    resolve: async () => ({
      executablePath: '/packaged/Hariari',
      runtimeVersion: '0.6.8',
      buildId: 'build-19',
    }),
  };
  const createInterface = createFixtureInterface({
    artifacts,
    endpoints,
    healthPollIntervalMs: options.healthPollIntervalMs ?? 100,
    processes,
    randomId,
    runtimeDirectory,
    tokens,
    transport,
  });
  return { launches, createInterface, endpoint, runtimeDirectory, transport };
}

interface FixtureInterfaceOptions {
  readonly artifacts: RuntimeArtifactPort;
  readonly endpoints: LocalRuntimeEndpointPort;
  readonly healthPollIntervalMs: number;
  readonly processes: RuntimeProcessPort;
  readonly randomId: () => string;
  readonly runtimeDirectory: string;
  readonly tokens: ProtectedRuntimeTokenStore;
  readonly transport: NodeLocalRuntimeTransport;
}

function createFixtureInterface(options: FixtureInterfaceOptions): () => RuntimeInterface {
  return () =>
    createRuntimeConnector({
      clients: new NodeRuntimeClient({
        transport: options.transport,
        randomId: options.randomId,
        randomNonce: options.randomId,
      }),
      endpoints: options.endpoints,
      tokens: options.tokens,
      processes: options.processes,
      leases: new FileRuntimeStartupLeasePort(options.runtimeDirectory),
      artifacts: options.artifacts,
      clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
      supportedProtocolRange: { min: 1, max: 2 },
      connectDeadlineMs: 500,
      startupDeadlineMs: 2_000,
      reconnectDelayMs: 25,
      healthPollIntervalMs: options.healthPollIntervalMs,
      schedule: scheduleTestTask,
      now: Date.now,
      delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
}

interface ProcessFixtureOptions {
  readonly executionAdapter?: GenericCliExecutionAdapter;
  readonly tokens: ProtectedRuntimeTokenStore;
  readonly endpoint: RuntimeEndpoint;
  readonly transport: NodeLocalRuntimeTransport;
  readonly randomId: () => string;
  readonly launches: { value: number };
  readonly requestDeadlineMs?: number;
}

function createProcessPort(options: ProcessFixtureOptions): RuntimeProcessPort {
  return {
    start: async (request) => {
      options.launches.value += 1;
      expect(JSON.stringify(request)).not.toContain(
        Buffer.from(new Uint8Array(32).fill(91)).toString('base64url'),
      );
      const token = await options.tokens.read();
      if (!token) throw new Error('test token missing');
      const server = new RuntimeServer({
        transport: options.transport,
        endpoint: options.endpoint,
        token,
        supportedProtocolRange: { min: 1, max: 2 },
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
        now: () => Date.parse('2026-08-20T10:00:00.000Z'),
        randomId: options.randomId,
        randomNonce: options.randomId,
        handshakeDeadlineMs: 500,
        requestDeadlineMs: options.requestDeadlineMs ?? 500,
        executionAdapter: options.executionAdapter,
      });
      servers.push(server);
      await server.start();
      return {
        terminate: () => server.stop(),
        settled: async () => undefined,
      };
    },
  };
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scheduleTestTask(milliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, milliseconds);
  return () => clearTimeout(timer);
}

async function cleanRuntimeFixtures(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

class GatedCloseTransport extends NodeLocalRuntimeTransport {
  readonly closeRequested: Promise<void>;
  private resolveCloseRequested: () => void = () => undefined;
  private allowClose: () => void = () => undefined;
  private readonly closeAllowed: Promise<void>;

  constructor(private readonly gated: boolean) {
    super();
    this.closeRequested = new Promise((resolve) => {
      this.resolveCloseRequested = resolve;
    });
    this.closeAllowed = new Promise((resolve) => {
      this.allowClose = resolve;
    });
  }

  override async listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    const listener = await super.listen(endpoint, onConnection);
    if (!this.gated) return listener;
    return {
      close: async () => {
        this.resolveCloseRequested();
        await this.closeAllowed;
        await listener.close();
      },
    };
  }

  releaseClose(): void {
    this.allowClose();
  }
}

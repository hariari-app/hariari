import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionState } from '../../src/shared/runtime/runtime-interface';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { FakeGenericCliExecutionAdapter } from './runtime-test-fakes';

const roots: string[] = [];
const subjects: CancellationSubject[] = [];
const FAILURE_MODES = ['zero-first', 'partial-then-zero', 'partial-then-error'] as const;
const CANCELLATION_TRANSITIONS = [
  { name: 'CancellationRequested', write: 1 },
  { name: 'AttemptCancelled', write: 2 },
] as const;

describe('Runtime Task cancellation', registerCancellationTests);

function registerCancellationTests(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(subjects.splice(0).map((subject) => subject.dispose()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  registerDurableCancellationTest();
  registerTaskNotReadyTest();
  registerExitRaceTest();
  registerInFlightAllocationTest();
  registerCancellationAppendRepairTests();
}

function registerDurableCancellationTest(): void {
  it('durably cancels a running Task before Runtime-owned exit and replays its terminal state', async () => {
    const subject = await createSubject(
      new FakeGenericCliExecutionAdapter({ autoExitOnStop: false }),
    );
    const task = await createShellTask(subject.control, 'cancel-running');
    await subject.control.startTask({ taskId: task.id, idempotencyKey: 'start-cancel-running' });
    const cancellation = subject.control.cancelTask({
      taskId: task.id,
      idempotencyKey: 'cancel-running',
    });

    await subject.adapter.waitForStop(task.id);
    await expectExecution(subject.query, task.id, 'cancelling');
    subject.adapter.exit(task.id, 23);
    await expect(cancellation).resolves.toMatchObject({ task: { executionState: 'cancelled' } });
    await expect(
      subject.query.cancelTask({ taskId: task.id, idempotencyKey: 'cancel-running' }),
    ).resolves.toMatchObject({ task: { executionState: 'cancelled' } });
    await expect(
      subject.query.cancelTask({ taskId: task.id, idempotencyKey: 'terminal-cancel' }),
    ).resolves.toMatchObject({ task: { executionState: 'cancelled' } });

    await subject.restart();
    await expect(subject.query.getTaskExecution(task.id)).resolves.toMatchObject({
      task: { executionState: 'cancelled' },
      attempt: { state: 'cancelled' },
    });
  });
}

function registerTaskNotReadyTest(): void {
  it('returns a bounded task-not-ready failure before an Attempt exists', async () => {
    const subject = await createSubject(new FakeGenericCliExecutionAdapter());
    const task = await createShellTask(subject.control, 'cancel-before-attempt');

    await expect(
      subject.control.cancelTask({ taskId: task.id, idempotencyKey: 'cancel-before-attempt' }),
    ).rejects.toEqual(new RuntimePortError('task-not-ready', false));
  });
}

function registerExitRaceTest(): void {
  it('returns the durable completed result when process exit wins the cancellation race', async () => {
    const subject = await createSubject(
      new FakeGenericCliExecutionAdapter({ autoExitOnStop: false }),
    );
    const task = await createShellTask(subject.control, 'exit-wins-cancel');
    await subject.control.startTask({ taskId: task.id, idempotencyKey: 'start-exit-wins-cancel' });
    subject.adapter.exit(task.id, 0);

    await expectExecution(subject.query, task.id, 'completed');
    await expect(
      subject.query.cancelTask({ taskId: task.id, idempotencyKey: 'cancel-after-completion' }),
    ).resolves.toMatchObject({
      task: { executionState: 'completed' },
      attempt: { state: 'completed', exitCode: 0 },
    });
  });
}

function registerInFlightAllocationTest(): void {
  it('cancels while Adapter allocation is in flight without turning the Attempt into failure', async () => {
    const gate = deferred();
    const adapter = new FakeGenericCliExecutionAdapter({ beforeStart: gate.promise });
    const subject = await createSubject(adapter);
    const task = await createShellTask(subject.control, 'cancel-allocation');
    const start = subject.control.startTask({
      taskId: task.id,
      idempotencyKey: 'start-cancel-allocation',
    });

    await adapter.waitForStart(task.id);
    await expectExecution(subject.query, task.id, 'starting');
    await expect(
      subject.query.cancelTask({ taskId: task.id, idempotencyKey: 'cancel-allocation' }),
    ).resolves.toMatchObject({ task: { executionState: 'cancelling' } });
    gate.resolve();
    await expect(start).resolves.toMatchObject({ task: { executionState: 'cancelling' } });
    await adapter.waitForStop(task.id);
    await expectExecution(subject.query, task.id, 'cancelled');
  });
}

function registerCancellationAppendRepairTests(): void {
  for (const mode of FAILURE_MODES) {
    for (const transition of CANCELLATION_TRANSITIONS) {
      it(`repairs ${transition.name} ${mode} append failure through cancellation retry and replay`, async () => {
        const subject = await createSubject(
          new FakeGenericCliExecutionAdapter({ autoExitOnStop: false }),
        );
        const task = await createShellTask(subject.control, `cancel-${transition.name}-${mode}`);
        await subject.control.startTask({
          taskId: task.id,
          idempotencyKey: `start-${transition.name}-${mode}`,
        });
        corruptCancellationAppend(subject.eventPath, transition.write, mode);
        const request = { taskId: task.id, idempotencyKey: `cancel-${transition.name}-${mode}` };

        if (transition.name === 'CancellationRequested') {
          await expect(subject.control.cancelTask(request)).rejects.toEqual(
            new RuntimePortError('internal', true),
          );
        }
        const cancellation = subject.control.cancelTask(request);
        await subject.adapter.waitForStop(task.id);
        await expectExecution(subject.query, task.id, 'cancelling');
        subject.adapter.exit(task.id, 1);
        await expect(cancellation).resolves.toMatchObject({
          task: { executionState: 'cancelled' },
        });
        await subject.restart();
        await expect(subject.query.getTaskExecution(task.id)).resolves.toMatchObject({
          task: { executionState: 'cancelled' },
          attempt: { state: 'cancelled' },
        });
      });
    }
  }
}

interface CancellationSubject {
  readonly adapter: FakeGenericCliExecutionAdapter;
  readonly control: RuntimeClientSession;
  readonly eventPath: string;
  readonly query: RuntimeClientSession;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

async function createSubject(
  adapter: FakeGenericCliExecutionAdapter,
): Promise<CancellationSubject> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-cancellation-'));
  roots.push(root);
  const runtimeDirectory = path.join(root, 'runtime');
  const endpoint = {
    kind: 'unix' as const,
    address: path.join(root, 'runtime.sock'),
    runtimeDirectory,
  };
  const token = new Uint8Array(32).fill(31);
  const transport = new NodeLocalRuntimeTransport();
  let id = 0;
  const randomId = (): string => `cancellation-${++id}-${randomUUID()}`;
  let server = serverFor(adapter, transport, endpoint, token, randomId);
  await server.start();
  let control = await connect(transport, endpoint, token, randomId);
  let query = await connect(transport, endpoint, token, randomId);
  const subject: CancellationSubject = {
    adapter,
    control,
    eventPath: path.join(runtimeDirectory, 'tasks', 'events.log'),
    query,
    restart: async () => {
      await control.disconnect();
      await query.disconnect();
      await server.stop();
      server = serverFor(adapter, transport, endpoint, token, randomId);
      await server.start();
      control = await connect(transport, endpoint, token, randomId);
      query = await connect(transport, endpoint, token, randomId);
      Object.assign(subject, { control, query });
    },
    dispose: async () => {
      await control.disconnect();
      await query.disconnect();
      await server.stop();
    },
  };
  subjects.push(subject);
  return subject;
}

function serverFor(
  adapter: FakeGenericCliExecutionAdapter,
  transport: NodeLocalRuntimeTransport,
  endpoint: { readonly kind: 'unix'; readonly address: string; readonly runtimeDirectory: string },
  token: Uint8Array,
  randomId: () => string,
): RuntimeServer {
  return new RuntimeServer({
    transport,
    endpoint,
    token,
    supportedProtocolRange: { min: 1, max: 1 },
    runtimeVersion: '0.6.8',
    buildId: 'cancellation-build',
    now: () => Date.parse('2026-08-21T10:00:00.000Z'),
    randomId,
    randomNonce: randomId,
    handshakeDeadlineMs: 500,
    requestDeadlineMs: 500,
    executionAdapter: adapter,
  });
}

async function connect(
  transport: NodeLocalRuntimeTransport,
  endpoint: { readonly kind: 'unix'; readonly address: string; readonly runtimeDirectory: string },
  token: Uint8Array,
  randomId: () => string,
): Promise<RuntimeClientSession> {
  const connection = await new NodeRuntimeClient({
    transport,
    randomId,
    randomNonce: randomId,
  }).connect(endpoint, token, {
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange: { min: 1, max: 1 },
    deadlineMs: 500,
  });
  if (connection.kind !== 'connected') throw new Error('expected authenticated Runtime session');
  return connection.session;
}

function createShellTask(session: RuntimeClientSession, idempotencyKey: string) {
  return session.createTask({
    objective: 'Exercise durable Runtime cancellation.',
    project: 'Hariari',
    repository: 'fake-checkout',
    baseRef: 'HEAD',
    provider: 'shell',
    idempotencyKey,
  });
}

async function expectExecution(
  session: RuntimeClientSession,
  taskId: string,
  state: TaskExecutionState,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  let observed = 'none';
  while (Date.now() < deadline) {
    const view = await session.getTaskExecution(taskId);
    observed = view.attempt?.state ?? 'none';
    if (view.attempt?.state === state) return;
    await waitForRuntimeUpdate();
  }
  throw new Error(`Task did not become ${state}; observed ${observed}`);
}

function waitForRuntimeUpdate(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function corruptCancellationAppend(
  eventPath: string,
  writeCall: number,
  mode: (typeof FAILURE_MODES)[number],
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
          if (writes === writeCall && mode === 'zero-first')
            return { bytesWritten: 0, buffer: data };
          if (writes === writeCall) {
            partial = true;
            return target.write(data.subarray(0, 1));
          }
          if (partial && writes === writeCall + 1) {
            if (mode === 'partial-then-error')
              throw new Error('injected cancellation append error');
            return { bytesWritten: 0, buffer: data };
          }
          return target.write(data);
        };
      },
    });
  });
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

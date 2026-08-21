import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionState, TaskOutputEvent } from '../../src/shared/runtime/runtime-interface';
import {
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeLocalTransport,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { GenericCliExecutionError } from '../../src/runtime/generic-cli-execution-adapter';
import { FakeGenericCliExecutionAdapter } from './runtime-test-fakes';

const roots: string[] = [];
const subjects: CancellationSubject[] = [];
const FAILURE_MODES = ['zero-first', 'partial-then-zero', 'partial-then-error'] as const;
const CANCELLATION_TRANSITIONS = [
  { name: 'CancellationRequested', write: 1 },
  { name: 'AttemptCancelled', write: 2 },
] as const;
const OUTPUT_APPEND_FAILURES = ['zero-write', 'partial-then-error'] as const;

describe('Runtime Task cancellation', registerCancellationTests);

function registerCancellationTests(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(subjects.splice(0).map((subject) => subject.dispose()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  registerDurableCancellationTest();
  registerDurablePtyReattachTest();
  registerOutputBackpressureTests();
  registerOutputAppendDurabilityTests();
  registerTaskNotReadyTest();
  registerExitRaceTest();
  registerInFlightAllocationTest();
  registerFailedAllocationCancellationTest();
  registerCancellationAppendRepairTests();
}

function registerOutputBackpressureTests(): void {
  it('replays more than one writer queue before later live output without gaps or duplicate reconnects', async () => {
    const transport = new GatedOutboundTransport();
    const subject = await createSubject(new FakeGenericCliExecutionAdapter(), transport);
    const task = await startShellTask(subject.control, 'replay-backpressure');
    emitOutputRange(subject.adapter, task.id, 1, 80);
    const secondDesktop = await reconnectDesktop(subject);
    const outputGate = transport.blockFirstOutput();
    const replayed: TaskOutputEvent[] = [];
    const unsubscribe = await secondDesktop.subscribeTaskOutput(task.id, (event) => replayed.push(event));
    await outputGate.started.promise;
    emitOutputRange(subject.adapter, task.id, 81, 10);
    outputGate.release();
    await waitForOutput(replayed, 90);
    expectOutputRange(replayed, task.id, task.attempt?.id, 90);
    unsubscribe();
    await secondDesktop.disconnect();

    const thirdDesktop = await subject.connectDesktop();
    const repeated: TaskOutputEvent[] = [];
    const unsubscribeThird = await thirdDesktop.subscribeTaskOutput(task.id, (event) => repeated.push(event));
    await waitForOutput(repeated, 90);
    expect(repeated).toEqual(replayed);
    expect(subject.adapter.startCount(task.id)).toBe(1);
    unsubscribeThird();
    await thirdDesktop.disconnect();
  });

  it('keeps live output arriving during a delayed acknowledgement in durable sequence order', async () => {
    const transport = new GatedOutboundTransport();
    const subject = await createSubject(new FakeGenericCliExecutionAdapter(), transport);
    const task = await startShellTask(subject.control, 'acknowledgement-backpressure');
    const acknowledgementGate = transport.blockNextResponse();
    const output: TaskOutputEvent[] = [];
    const subscription = subject.control.subscribeTaskOutput(task.id, (event) => output.push(event));
    await acknowledgementGate.started.promise;
    emitOutputRange(subject.adapter, task.id, 1, 80);
    acknowledgementGate.release();
    const unsubscribe = await subscription;
    emitOutputRange(subject.adapter, task.id, 81, 10);
    await waitForOutput(output, 90);
    expectOutputRange(output, task.id, task.attempt?.id, 90);
    unsubscribe();
  });
}

function registerOutputAppendDurabilityTests(): void {
  it.each(OUTPUT_APPEND_FAILURES)(
    'poisons output after a $ failure and replays only committed scrollback after restart',
    async (failure) => {
      const subject = await createSubject(new FakeGenericCliExecutionAdapter());
      const task = await createShellTask(subject.control, `output-${failure}-create`);
      const started = await subject.control.startTask({
        taskId: task.id,
        idempotencyKey: `output-${failure}-start`,
      });
      const output: TaskOutputEvent[] = [];
      const unsubscribe = await subject.control.subscribeTaskOutput(task.id, (event) => output.push(event));
      subject.adapter.emit(task.id, 'committed\n');
      await waitForOutput(output, 1);
      injectOutputWriteFailure(failure);

      expect(() => subject.adapter.emit(task.id, 'failed\n')).not.toThrow();
      expect(() => subject.adapter.emit(task.id, 'must-not-follow\n')).not.toThrow();
      await waitForRuntimeUpdate();
      expect(output).toEqual([
        { kind: 'data', taskId: task.id, attemptId: started.attempt?.id, sequence: 1, data: 'committed\n' },
      ]);
      unsubscribe();
      await subject.restart();

      const replayed: TaskOutputEvent[] = [];
      const unsubscribeReplay = await subject.control.subscribeTaskOutput(task.id, (event) => replayed.push(event));
      await waitForOutput(replayed, 1);
      expect(replayed).toEqual(output);
      unsubscribeReplay();
    },
  );
}

function registerDurablePtyReattachTest(): void {
  it('reconnects Desktop to one running PTY and replays persisted output before live output', async () => {
    const subject = await createSubject(new FakeGenericCliExecutionAdapter());
    const firstDesktop = subject.control;
    const task = await createShellTask(firstDesktop, 'durable-pty-create');
    const started = await firstDesktop.startTask({
      taskId: task.id,
      idempotencyKey: 'durable-pty-start',
    });
    const firstOutput: TaskOutputEvent[] = [];
    const unsubscribeFirst = await firstDesktop.subscribeTaskOutput(task.id, (event) => {
      firstOutput.push(event);
    });
    subject.adapter.emit(task.id, 'before-detach\n');
    await waitForOutput(firstOutput, 1);
    unsubscribeFirst();
    await firstDesktop.disconnect();

    const secondDesktop = await subject.connectDesktop();
    await expect(secondDesktop.getTaskExecution(task.id)).resolves.toEqual(started);
    const reattachedOutput: TaskOutputEvent[] = [];
    const unsubscribeSecond = await secondDesktop.subscribeTaskOutput(task.id, (event) => {
      reattachedOutput.push(event);
    });
    subject.adapter.emit(task.id, 'after-reattach\n');
    await waitForOutput(reattachedOutput, 2);

    expect(reattachedOutput).toEqual([
      { kind: 'data', taskId: task.id, attemptId: started.attempt?.id, sequence: 1, data: 'before-detach\n' },
      { kind: 'data', taskId: task.id, attemptId: started.attempt?.id, sequence: 2, data: 'after-reattach\n' },
    ]);
    unsubscribeSecond();
    await secondDesktop.disconnect();
    const thirdDesktop = await subject.connectDesktop();
    const repeatedOutput: TaskOutputEvent[] = [];
    const unsubscribeThird = await thirdDesktop.subscribeTaskOutput(task.id, (event) => {
      repeatedOutput.push(event);
    });
    await waitForOutput(repeatedOutput, 2);
    expect(repeatedOutput).toEqual(reattachedOutput);
    expect(subject.adapter.startCount(task.id)).toBe(1);
    unsubscribeThird();
    await expect(
      thirdDesktop.cancelTask({ taskId: task.id, idempotencyKey: 'durable-pty-cleanup' }),
    ).resolves.toMatchObject({ task: { executionState: 'cancelled' } });
    await thirdDesktop.disconnect();
  });
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

function registerFailedAllocationCancellationTest(): void {
  it('preserves cancellation when process start fails after context allocation', async () => {
    const gate = deferred();
    const adapter = new FakeGenericCliExecutionAdapter({
      beforeStart: gate.promise,
      startError: (request) =>
        new GenericCliExecutionError('process-start-failed', {
          id: request.identities.contextId,
          worktreeId: request.identities.worktreeId,
          branchName: `hariari/task-${request.task.id}/run-1/attempt-1`,
          baseCommit: 'fake-base-commit',
          processId: request.identities.processId,
          ptyId: request.identities.ptyId,
        }),
    });
    const subject = await createSubject(adapter);
    const task = await createShellTask(subject.control, 'cancel-failed-allocation');
    const start = subject.control.startTask({
      taskId: task.id,
      idempotencyKey: 'start-cancel-failed-allocation',
    });

    await adapter.waitForStart(task.id);
    await subject.query.cancelTask({ taskId: task.id, idempotencyKey: 'cancel-failed-allocation' });
    gate.resolve();
    await expect(start).rejects.toEqual(new RuntimePortError('process-start-failed', true));
    await expectExecution(subject.query, task.id, 'cancelled');
    await expect(subject.query.getTaskExecution(task.id)).resolves.toMatchObject({
      task: { executionState: 'cancelled' },
      attempt: { state: 'cancelled' },
      context: { baseCommit: 'fake-base-commit' },
    });
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
  connectDesktop(): Promise<RuntimeClientSession>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

async function createSubject(
  adapter: FakeGenericCliExecutionAdapter,
  transport: RuntimeLocalTransport = new NodeLocalRuntimeTransport(),
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
  let id = 0;
  const randomId = (): string => `cancellation-${++id}-${randomUUID()}`;
  let server = serverFor(adapter, transport, endpoint, token, randomId);
  await server.start();
  let control = await connect(transport, endpoint, token, randomId);
  let query = await connect(transport, endpoint, token, randomId);
  const subject: CancellationSubject = {
    adapter,
    get control() {
      return control;
    },
    eventPath: path.join(runtimeDirectory, 'tasks', 'events.log'),
    get query() {
      return query;
    },
    connectDesktop: () => connect(transport, endpoint, token, randomId),
    restart: async () => {
      await control.disconnect();
      await query.disconnect();
      await server.stop();
      server = serverFor(adapter, transport, endpoint, token, randomId);
      await server.start();
      control = await connect(transport, endpoint, token, randomId);
      query = await connect(transport, endpoint, token, randomId);
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
  transport: RuntimeLocalTransport,
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
  transport: RuntimeLocalTransport,
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

async function startShellTask(session: RuntimeClientSession, idempotencyKey: string) {
  const task = await createShellTask(session, `${idempotencyKey}-create`);
  const started = await session.startTask({ taskId: task.id, idempotencyKey: `${idempotencyKey}-start` });
  if (!started.attempt) throw new Error('expected a running attempt');
  return { id: task.id, attempt: started.attempt };
}

async function reconnectDesktop(subject: CancellationSubject): Promise<RuntimeClientSession> {
  await subject.control.disconnect();
  return subject.connectDesktop();
}

function emitOutputRange(
  adapter: FakeGenericCliExecutionAdapter,
  taskId: string,
  firstSequence: number,
  count: number,
): void {
  for (let sequence = firstSequence; sequence < firstSequence + count; sequence += 1) {
    adapter.emit(taskId, `output-${sequence}\n`);
  }
}

function expectOutputRange(
  output: readonly TaskOutputEvent[],
  taskId: string,
  attemptId: string,
  count: number,
): void {
  expect(output).toEqual(
    Array.from({ length: count }, (_, index) => ({
      kind: 'data',
      taskId,
      attemptId,
      sequence: index + 1,
      data: `output-${index + 1}\n`,
    })),
  );
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

function injectOutputWriteFailure(failure: (typeof OUTPUT_APPEND_FAILURES)[number]): void {
  const writeFileSync = fs.writeFileSync.bind(fs);
  let writes = 0;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    writes += 1;
    if (writes !== 1) return writeFileSync(file, data, options);
    if (failure === 'zero-write') return;
    writeFileSync(file, String(data).slice(0, 1), options);
    throw new Error('injected partial output write');
  });
}

async function waitForOutput(output: readonly TaskOutputEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (output.length === count) return;
    await waitForRuntimeUpdate();
  }
  throw new Error(`Expected ${count} output events; received ${output.length}`);
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

class GatedOutboundTransport implements RuntimeLocalTransport {
  private readonly transport = new NodeLocalRuntimeTransport();
  private gate: OutboundGate | null = null;

  connect(endpoint: RuntimeLocalEndpoint, deadlineMs: number): Promise<RuntimeFrameConnection> {
    return this.transport.connect(endpoint, deadlineMs);
  }

  async listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    return this.transport.listen(endpoint, (connection) => onConnection(new GatedOutboundConnection(connection, this)));
  }

  blockNextResponse(): OutboundGate {
    return this.installGate('response');
  }

  blockFirstOutput(): OutboundGate {
    return this.installGate('output');
  }

  takeGate(frame: Record<string, unknown>): OutboundGate | null {
    const gate = this.gate;
    if (!gate || (gate.kind === 'response' ? frame.kind !== 'runtime.response' : frame.kind !== 'runtime.output')) {
      return null;
    }
    this.gate = null;
    return gate;
  }

  private installGate(kind: OutboundGate['kind']): OutboundGate {
    if (this.gate) throw new Error('an outbound gate is already armed');
    const gate = new OutboundGate(kind);
    this.gate = gate;
    return gate;
  }
}

class GatedOutboundConnection implements RuntimeFrameConnection {
  constructor(
    private readonly connection: RuntimeFrameConnection,
    private readonly transport: GatedOutboundTransport,
  ) {}

  readFrame(deadlineMs: number): Promise<Record<string, unknown>> {
    return this.connection.readFrame(deadlineMs);
  }

  async writeFrame(frame: Record<string, unknown>, deadlineMs: number): Promise<void> {
    const gate = this.transport.takeGate(frame);
    if (gate) {
      gate.started.resolve();
      await gate.released.promise;
    }
    await this.connection.writeFrame(frame, deadlineMs);
  }

  onClose(listener: () => void): () => void {
    return this.connection.onClose(listener);
  }

  close(): void {
    this.connection.close();
  }
}

class OutboundGate {
  readonly started = deferred();
  readonly released = deferred();

  constructor(readonly kind: 'response' | 'output') {}

  release(): void {
    this.released.resolve();
  }
}

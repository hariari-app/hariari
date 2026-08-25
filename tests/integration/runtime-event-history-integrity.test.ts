import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';
import {
  appendTaskEventFrame,
  createSubject,
  deferred,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
  waitForTaskState,
} from './runtime-task-test-harness';

describe('authenticated Runtime event history integrity', () => {
  registerRuntimeTaskTestCleanup();

  it(
    'repairs a core-only Task create before retry and remains idempotent across restarts',
    repairsCoreOnlyTaskCreate,
  );
  it(
    'rejects an exact checksum-valid duplicate provider action decision on restart',
    rejectsDuplicateProviderDecision,
  );
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'rejects coordinated %s terminal operation forgery at the public seam',
    rejectsTerminalForgeryAtPublicSeam,
  );
  it.each(['completed', 'failed'] as const)(
    'waits for a gated %s settlement before graceful stop and replays it after restart',
    waitsForTerminalSettlementOnStop,
  );
  it(
    'rejects a failed pending terminal settlement during stop without hanging',
    rejectsFailedSettlementWithoutHanging,
  );
  it.each([
    ['shell', 'completed'],
    ['shell', 'failed'],
    ['shell', 'cancelled'],
    ['claude', 'completed'],
    ['claude', 'failed'],
    ['claude', 'cancelled'],
    ['resume', 'completed'],
    ['resume', 'failed'],
    ['resume', 'cancelled'],
    ['fork', 'completed'],
    ['fork', 'failed'],
    ['fork', 'cancelled'],
  ] as const)('replays a valid %s %s history', replaysValidTerminalHistory);
});

async function repairsCoreOnlyTaskCreate(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const request = {
    objective: 'Recover a crash-interrupted Task create.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude' as const,
    idempotencyKey: 'core-only-task-create',
  };
  const task = await runtime.createTask(request);
  const core = readTaskEvents(subject.runtimeDirectory).find(
    (event) => event.type === 'TaskCreated',
  )!;
  const { correlationId: _legacyMissingCorrelation, ...legacyCore } = core;
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, [legacyCore]);

  await expect(subject.restart()).resolves.toBeUndefined();
  const repaired = await subject.connect();
  await expect(repaired.createTask(request)).resolves.toEqual(task);
  await expect(repaired.getTaskTimeline(task.id)).resolves.toMatchObject({
    taskId: task.id,
    rawObservations: [],
    normalizedEvents: [{ kind: 'task-created', sequence: 1 }],
  });
  expect(readTaskEvents(subject.runtimeDirectory).map((event) => event.type)).toEqual([
    'TaskCreated',
    'NormalizedRuntimeEventRecorded',
  ]);
  await repaired.disconnect();

  await expect(subject.restart()).resolves.toBeUndefined();
  expect(readTaskEvents(subject.runtimeDirectory).map((event) => event.type)).toEqual([
    'TaskCreated',
    'NormalizedRuntimeEventRecorded',
  ]);
}

async function rejectsDuplicateProviderDecision(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const request = {
    objective: 'Reject a duplicated provider decision.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude' as const,
    idempotencyKey: 'duplicate-provider-decision-create',
  };
  const task = await runtime.createTask(request);
  const started = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: 'duplicate-provider-decision-start',
  });
  const action = {
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    idempotencyKey: 'duplicate-provider-decision-fork',
  };
  const forked = await runtime.forkProviderSession(action);
  const beforeRetry = readTaskEvents(subject.runtimeDirectory);
  await expect(runtime.forkProviderSession(action)).resolves.toEqual(forked);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(beforeRetry);
  const duplicate = readTaskEvents(subject.runtimeDirectory).find(
    (event) => event.type === 'ProviderSessionActionDecided',
  )!;
  await runtime.disconnect();
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), duplicate);

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsTerminalForgeryAtPublicSeam(
  state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: `Reject a forged ${state} terminal identity.`,
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: `terminal-${state}-forgery-create`,
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: `terminal-${state}-forgery-start` });
  if (state === 'cancelled') {
    await runtime.cancelTask({ taskId: task.id, idempotencyKey: 'authentic-cancel-key' });
  } else {
    adapter.exit(task.id, state === 'completed' ? 0 : 1);
  }
  await waitForTaskState(runtime, task.id, state);
  const timeline = await runtime.getTaskTimeline(task.id);
  const normalizedEvents = forgeTerminalEvents(timeline.normalizedEvents, state);

  expect(() =>
    parseTaskTimelineView({
      ...timeline,
      normalizedEvents,
      timeline: normalizedEvents.map((event) => ({
        eventId: event.id,
        sequence: event.sequence,
        occurredAt: event.occurrenceAt,
        message: timeline.timeline[event.sequence - 1]!.message,
      })),
    } as unknown as Record<string, unknown>),
  ).toThrow();
  const durable = forgeTerminalRecords(readTaskEvents(subject.runtimeDirectory), state);
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, durable);
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

function forgeTerminalEvents<T extends { readonly kind?: unknown }>(
  events: readonly T[],
  state: 'completed' | 'failed' | 'cancelled',
): readonly T[] {
  return events.map((event) => event.kind === `attempt-${state}`
    ? { ...event, idempotencyKey: 'forged-terminal-key',
        correlationId: 'forged-terminal-correlation' }
    : event);
}

function forgeTerminalRecords(
  records: readonly Record<string, unknown>[],
  state: 'completed' | 'failed' | 'cancelled',
): readonly Record<string, unknown>[] {
  return records.map((record) => {
    const event = record.event as { readonly kind?: unknown } | undefined;
    return event?.kind === `attempt-${state}`
      ? { ...record, event: forgeTerminalEvents([event], state)[0] }
      : record;
  });
}

async function waitsForTerminalSettlementOnStop(state: 'completed' | 'failed'): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: `Settle ${state} before Runtime stop.`,
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: `shutdown-${state}-create`,
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: `shutdown-${state}-start` });
  const gate = gateTerminalAppend(subject.runtimeDirectory, state, false);
  adapter.exit(task.id, state === 'completed' ? 0 : 1);
  await gate.entered.promise;
  let stopped = false;
  const stop = subject.stop().then(() => void (stopped = true));
  await Promise.resolve();
  await Promise.resolve();
  expect(stopped).toBe(false);

  gate.release.resolve();
  await stop;
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskTimeline(task.id)).resolves.toMatchObject({
    status: { task: { executionState: state } },
    normalizedEvents: expect.arrayContaining([
      expect.objectContaining({ kind: `attempt-${state}` }),
    ]),
  });
  await restarted.disconnect();
}

async function rejectsFailedSettlementWithoutHanging(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Bound failed settlement shutdown.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: 'shutdown-failure-create',
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'shutdown-failure-start' });
  const gate = gateTerminalAppend(subject.runtimeDirectory, 'completed', true);
  adapter.exit(task.id, 0);
  await gate.entered.promise;
  const stop = subject.stop();
  gate.release.resolve();

  await expect(stop).rejects.toBeInstanceOf(Error);
  await expect(subject.stop()).resolves.toBeUndefined();
  await runtime.disconnect();
}

function gateTerminalAppend(
  runtimeDirectory: string,
  state: 'completed' | 'failed',
  fail: boolean,
) {
  const entered = deferred();
  const release = deferred();
  const eventPath = path.join(runtimeDirectory, 'tasks', 'events.log');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (file !== eventPath || flags !== 'a') return handle;
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property !== 'write') return Reflect.get(target, property, receiver);
        return async (data: Buffer) => {
          const event = framedEvent(data);
          if (event.event?.kind !== `attempt-${state}`) return target.write(data);
          entered.resolve();
          await release.promise;
          if (fail) throw new Error('injected terminal settlement failure');
          return target.write(data);
        };
      },
    });
  });
  return { entered, release };
}

function framedEvent(data: Buffer): {
  readonly event?: { readonly kind?: unknown };
} {
  const length = data.readUInt32BE(0);
  return JSON.parse(data.subarray(36, 36 + length).toString('utf8')) as {
    readonly event?: { readonly kind?: unknown };
  };
}

async function replaysValidTerminalHistory(
  operation: 'shell' | 'claude' | 'resume' | 'fork',
  state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const adapter =
    operation === 'shell'
      ? new FakeGenericCliExecutionAdapter()
      : new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: `Replay ${operation} ${state}.`,
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: operation === 'shell' ? 'shell' : 'claude',
    idempotencyKey: `${operation}-${state}-create`,
  });
  let execution = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: `${operation}-${state}-start`,
  });
  if (operation === 'resume') {
    adapter.lose(task.id);
    execution = await runtime.resumeProviderSession({
      taskId: task.id,
      providerSessionId: execution.providerSession!.id,
      idempotencyKey: `${operation}-${state}-action`,
    });
  } else if (operation === 'fork') {
    execution = await runtime.forkProviderSession({
      taskId: task.id,
      providerSessionId: execution.providerSession!.id,
      idempotencyKey: `${operation}-${state}-action`,
    });
  }
  await settleValidHistory(runtime, adapter, task.id, execution.attempt!.id, operation, state);
  const terminal = await waitForTaskState(runtime, task.id, state);
  const timeline = await runtime.getTaskTimeline(task.id);
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(terminal);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
}

async function settleValidHistory(
  runtime: RuntimeClientSession,
  adapter: FakeGenericCliExecutionAdapter,
  taskId: string,
  attemptId: string,
  operation: 'shell' | 'claude' | 'resume' | 'fork',
  state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (state === 'cancelled') {
    await runtime.cancelTask({ taskId, idempotencyKey: `${operation}-${state}-cancel` });
  } else {
    adapter.exitAttempt(attemptId, state === 'completed' ? 0 : 1);
  }
}

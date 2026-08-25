import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { TaskExecutionView, TaskTimelineView, TaskView } from '../../src/shared/runtime/runtime-interface';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { GenericCliExecutionError } from '../../src/runtime/generic-cli-execution-adapter';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';
import {
  APPEND_DURABILITY_MODES,
  createSubject,
  observeExpectedExecutionAppend,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
  type RuntimeSubject,
  waitForTaskState,
} from './runtime-task-test-harness';

describe('authenticated Runtime event history recovery', () => {
  registerRuntimeTaskTestCleanup();

  it.each(createRecoveryCases())(
    'repairs task.create $name after $mode durability before retry and repeated restart',
    verifiesCreateRecovery,
  );

  it.each(startRecoveryCases())(
    'repairs $provider task.start $name after $mode durability before retry and repeated restart',
    verifiesStartRecovery,
  );

  it.each(providerRecoveryCases())(
    'repairs provider.$action $name after $mode durability before retry and repeated restart',
    verifiesProviderActionRecovery,
  );

  it.each(terminalRecoveryCases())(
    'repairs task.$state $name after $mode durability before retry and repeated restart',
    verifiesTerminalRecovery,
  );

  it.each(['start', 'resume', 'fork'] as const)(
    'preserves durable provider observation time for context-only %s recovery',
    verifiesContextOnlyRecovery,
  );
  it('repairs a raw-only Claude observation before publication', verifiesRawOnlyRecovery);
  it('repairs a core terminal state before publication without status masking',
    verifiesTerminalPublicationRepair);
  it('fails closed with a stable error for an unrecoverable normalized gap',
    verifiesUnrecoverableGap);
  it.each(['start', 'resume', 'fork'] as const)(
    'repairs a normalized-start crash prefix for %s start failure before retry and restart',
    verifiesStartFailurePrefixRecovery,
  );
  it.each([
    ['started', 'AttemptStarted', 'attempt-started'],
    ['completed', 'AttemptCompleted', 'attempt-completed'],
    ['failed', 'AttemptFailed', 'attempt-failed'],
    ['cancellation-requested', 'CancellationRequested', 'cancellation-requested'],
    ['cancelled', 'AttemptCancelled', 'attempt-cancelled'],
  ] as const)(
    'preserves durable %s occurrence time when normalized repair happens after restart',
    verifiesDurableLifecycleOccurrence,
  );
  it('uses restart time only as the explicit fallback for a legacy untimed lifecycle record', verifiesLegacyLifecycleOccurrenceFallback);
  it('uses restart time only for a legacy untimed provider context', verifiesLegacyProviderObservationFallback);
});

async function verifiesLegacyProviderObservationFallback(): Promise<void> {
  let clock = Date.parse('2026-08-25T10:00:00.000Z');
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter(), () => clock);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest('legacy-provider-time-create'));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'legacy-provider-time-start' });
  const prefix = prefixThroughLast(subject.runtimeDirectory, 'ContextAllocated').map((record) => {
    if (record.type !== 'ContextAllocated') return record;
    const { observedAt: _legacyMissingTime, ...legacy } = record;
    return legacy;
  });
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  const restartedAt = '2026-08-25T11:00:00.000Z';
  clock = Date.parse(restartedAt);
  await subject.restart();
  const restarted = await subject.connect();
  const timeline = await restarted.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.find((event) => event.kind === 'provider-session-observed'))
    .toMatchObject({ occurrenceAt: restartedAt, observedAt: restartedAt });
}

async function verifiesLegacyLifecycleOccurrenceFallback(): Promise<void> {
  let clock = Date.parse('2026-08-25T10:00:00.000Z');
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter(), () => clock);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest('legacy-time-create'));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'legacy-time-start' });
  const prefix = prefixThrough(subject.runtimeDirectory, 'AttemptStarted').map((record) => {
    if (record.type !== 'AttemptStarted') return record;
    const { occurredAt: _removedLegacyTime, ...legacy } = record;
    return legacy;
  });
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  const restartedAt = '2026-08-25T11:00:00.000Z';
  clock = Date.parse(restartedAt);
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskTimeline(task.id)).resolves.toMatchObject({
    normalizedEvents: expect.arrayContaining([
      expect.objectContaining({ kind: 'attempt-started', occurrenceAt: restartedAt }),
    ]),
  });
}

async function verifiesDurableLifecycleOccurrence(
  phase: 'started' | 'completed' | 'failed' | 'cancellation-requested' | 'cancelled',
  coreType: string,
  normalizedKind: string,
): Promise<void> {
  let clock = Date.parse('2026-08-25T09:00:00.000Z');
  const effectAt = '2026-08-25T10:00:00.000Z';
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter, () => clock);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest(`${phase}-time-create`));
  clock = Date.parse(effectAt);
  await runtime.startTask({ taskId: task.id, idempotencyKey: `${phase}-time-start` });
  if (phase === 'completed' || phase === 'failed') {
    adapter.exit(task.id, phase === 'completed' ? 0 : 1);
    await waitForTaskState(runtime, task.id, phase);
  }
  if (phase === 'cancellation-requested' || phase === 'cancelled') {
    await runtime.cancelTask({ taskId: task.id, idempotencyKey: `${phase}-time-cancel` });
  }
  const prefix = prefixThrough(subject.runtimeDirectory, coreType);
  expect(prefix.at(-1)).toMatchObject({ type: coreType, occurredAt: effectAt });
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  clock = Date.parse('2026-08-25T11:00:00.000Z');
  await subject.restart();
  const restarted = await subject.connect();
  const timeline = await restarted.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.find((event) => event.kind === normalizedKind))
    .toMatchObject({ occurrenceAt: effectAt, observedAt: effectAt });
}

async function verifiesStartFailurePrefixRecovery(
  action: 'start' | 'resume' | 'fork',
): Promise<void> {
  const failedAttempt = action === 'start' ? 1 : 2;
  const adapter = new FakeClaudeCodeExecutionAdapter({
    startError: (request) => request.attempt.number === failedAttempt
      ? new GenericCliExecutionError('process-start-failed') : undefined,
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest(`${action}-prefix-create`));
  const parent = action === 'start' ? null : await runtime.startTask({
    taskId: task.id, idempotencyKey: `${action}-prefix-parent`,
  });
  if (action === 'resume') adapter.lose(task.id);
  const request = action === 'start'
    ? { taskId: task.id, idempotencyKey: `${action}-prefix-child` }
    : { taskId: task.id, providerSessionId: parent!.providerSession!.id,
        idempotencyKey: `${action}-prefix-child` };
  await expect(callFailureAction(runtime, action, request))
    .rejects.toEqual(new RuntimePortError('process-start-failed', true));
  const prefix = prefixThroughLastNormalizedStart(subject.runtimeDirectory);
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  const failed = await callFailureAction(restarted, action, request);
  expect(failed).toMatchObject({ attempt: { number: failedAttempt, state: 'failed' } });
  await assertFailurePrefixEffects(subject, restarted, adapter, task, action);
}

async function assertFailurePrefixEffects(
  subject: RuntimeSubject,
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
  task: TaskView,
  action: 'start' | 'resume' | 'fork',
): Promise<void> {
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(kinds(timeline).slice(-2)).toEqual(['attempt-started', 'attempt-failed']);
  expect(timeline.status.task.executionState).toBe('failed');
  expect(adapter.startCount(task.id)).toBe(action === 'start' ? 1 : 2);
  expect(adapter.stopCount(task.id)).toBe(action === 'fork' ? 1 : 0);
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.getTaskTimeline(task.id)).resolves.toEqual(timeline);
}

function callFailureAction(
  runtime: RuntimeClientSession,
  action: 'start' | 'resume' | 'fork',
  request: { readonly taskId: string; readonly idempotencyKey: string;
    readonly providerSessionId?: string },
): Promise<TaskExecutionView> {
  if (action === 'start') return runtime.startTask(request);
  const providerRequest = { ...request, providerSessionId: request.providerSessionId! };
  return action === 'resume'
    ? runtime.resumeProviderSession(providerRequest)
    : runtime.forkProviderSession(providerRequest);
}

function prefixThroughLastNormalizedStart(runtimeDirectory: string) {
  const events = readTaskEvents(runtimeDirectory);
  let index = -1;
  for (const [candidateIndex, record] of events.entries()) {
    const event = record.event as { readonly kind?: unknown } | undefined;
    if (record.type === 'NormalizedRuntimeEventRecorded' && event?.kind === 'attempt-started') {
      index = candidateIndex;
    }
  }
  if (index < 0) throw new Error('missing normalized attempt-started');
  return events.slice(0, index + 1);
}

async function verifiesContextOnlyRecovery(action: 'start' | 'resume' | 'fork'): Promise<void> {
  let clock = Date.parse('2026-08-25T10:00:00.000Z');
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter, () => clock);
  const runtime = await subject.connect();
  const request = taskRequest(`context-recovery-${action}-create`);
  const task = await runtime.createTask(request);
  const parent = action === 'start' ? null : await runtime.startTask({
    taskId: task.id, idempotencyKey: `context-recovery-${action}-parent`,
  });
  if (action === 'resume') adapter.lose(task.id);
  const observedAt = '2026-08-25T10:30:00.000Z';
  clock = Date.parse(observedAt);
  const operationKey = `context-recovery-${action}-child`;
  const uninterrupted = await callContextRecoveryAction(
    runtime, action, task.id, parent?.providerSession?.id ?? null, operationKey,
  );
  const prefix = prefixThroughLast(subject.runtimeDirectory, 'ContextAllocated');
  expect(prefix.at(-1)).toMatchObject({ observedAt });
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  clock = Date.parse('2026-08-25T11:00:00.000Z');
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  const retried = callContextRecoveryAction(
    restarted, action, task.id, parent?.providerSession?.id ?? null, operationKey,
  );
  await expect(retried).resolves.toEqual(uninterrupted);
  const timeline = await restarted.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.find((event) => event.kind === 'provider-session-observed' &&
    event.attemptId === uninterrupted.attempt?.id)).toMatchObject({
    occurrenceAt: observedAt, observedAt,
  });
  expect(adapter.startCount(task.id)).toBe(action === 'start' ? 1 : 2);
}

function callContextRecoveryAction(
  runtime: RuntimeClientSession,
  action: 'start' | 'resume' | 'fork',
  taskId: string,
  providerSessionId: string | null,
  idempotencyKey: string,
): Promise<TaskExecutionView> {
  if (action === 'start') return runtime.startTask({ taskId, idempotencyKey });
  if (!providerSessionId) throw new Error('missing provider session');
  return callProviderAction(runtime, action, { taskId, providerSessionId, idempotencyKey });
}

async function verifiesRawOnlyRecovery(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest('raw-recovery-create'));
  const start = { taskId: task.id, idempotencyKey: 'raw-recovery-start' };
  const uninterrupted = await runtime.startTask(start);
  const prefix = prefixThrough(subject.runtimeDirectory, 'RawProviderObservationRecorded');
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.startTask(start)).resolves.toEqual(uninterrupted);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toMatchObject({
    status: uninterrupted,
    normalizedEvents: [
      { kind: 'task-created' },
      { kind: 'provider-session-observed' },
      { kind: 'attempt-started' },
    ],
  });
  expect(adapter.startCount(task.id)).toBe(1);
}

async function verifiesTerminalPublicationRepair(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest('terminal-recovery-create'));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'terminal-recovery-start' });
  adapter.exit(task.id, 0);
  const uninterrupted = await waitForTaskState(runtime, task.id, 'completed');
  const prefix = prefixThrough(subject.runtimeDirectory, 'AttemptCompleted');
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await subject.restart();
  const firstRestart = await subject.connect();
  await expect(firstRestart.getTaskExecution(task.id)).resolves.toEqual(uninterrupted);
  await firstRestart.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(uninterrupted);
  const timeline = await restarted.getTaskTimeline(task.id);
  expect(timeline.status).toEqual(uninterrupted);
  expect(timeline.normalizedEvents.at(-1)).toMatchObject({ kind: 'attempt-completed' });
}

async function verifiesUnrecoverableGap(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask(taskRequest('poisoned-gap-create'));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'poisoned-gap-start' });
  const invalid = readTaskEvents(subject.runtimeDirectory).filter((event) =>
    event.type !== 'RawProviderObservationRecorded');
  await runtime.disconnect();
  await subject.stop();
  rewriteTaskEvents(subject.runtimeDirectory, invalid);
  await expect(subject.restart()).rejects.toEqual(
    new TaskStorageError('event-history-invalid'),
  );
}

async function verifiesCreateRecovery(testCase: CreateRecoveryCase): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const correlation = `create-${testCase.name}-${testCase.mode}-correlation`;
  const runtime = await subject.connectWithCorrelations([correlation]);
  const request = taskRequest(`create-${testCase.name}-${testCase.mode}`);
  const observed = exerciseFault(subject, 'task.create', testCase);
  let first: TaskView | null = null;
  if (testCase.mode === 'complete') first = await runtime.createTask(request);
  else await expect(runtime.createTask(request)).rejects
    .toEqual(new RuntimePortError('internal', true));
  observed.assertObserved();
  const durableTask = readTaskEvents(subject.runtimeDirectory)
    .find((event) => event.type === 'TaskCreated')?.task as TaskView | undefined;
  await runtime.disconnect();
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connectWithCorrelations([correlation]);
  const task = await restarted.createTask(request);
  if (first) expect(task).toEqual(first);
  if (durableTask) expect(task.id).toBe(durableTask.id);
  const timeline = await restarted.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.map(eventIdentity)).toEqual([
    ['task-created', correlation, request.idempotencyKey],
  ]);
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.getTaskTimeline(task.id)).resolves.toEqual(timeline);
}

async function verifiesStartRecovery(testCase: StartRecoveryCase): Promise<void> {
  const original = testCase.provider === 'claude'
    ? new FakeClaudeCodeExecutionAdapter()
    : new FakeGenericCliExecutionAdapter();
  const subject = await createSubject(() => original);
  const correlation = `start-${testCase.provider}-${testCase.name}-${testCase.mode}-correlation`;
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, correlation,
  ]);
  const task = await runtime.createTask({
    ...taskRequest(`start-${testCase.provider}-${testCase.name}-${testCase.mode}-create`),
    provider: testCase.provider,
  });
  const request = {
    taskId: task.id,
    idempotencyKey: `start-${testCase.provider}-${testCase.name}-${testCase.mode}`,
  };
  const observed = exerciseFault(subject, `task.start.${testCase.provider}`, testCase);
  const failedStart = testCase.mode !== 'complete' &&
    (testCase.boundary.type === 'ContextAllocated' ||
      testCase.boundary.type === 'AttemptStarted');
  const reservationRejects = testCase.mode !== 'complete' &&
    boundaryWriteCall(testCase.boundary, `task.start.${testCase.provider}`) < 3;
  let first: TaskExecutionView | null = null;
  if (failedStart || reservationRejects) {
    await expect(runtime.startTask(request)).rejects
      .toEqual(new RuntimePortError('internal', true));
  } else first = await runtime.startTask(request);
  observed.assertObserved();
  await runtime.disconnect();
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connectWithCorrelations([correlation]);
  const result = await restarted.startTask(request);
  if (first) expect(result).toEqual(first);
  await assertStartRecovery(subject, original, task, result, failedStart, testCase, restarted);
}

async function assertStartRecovery(
  subject: RuntimeSubject,
  adapter: FakeGenericCliExecutionAdapter,
  task: TaskView,
  result: TaskExecutionView,
  failedStart: boolean,
  testCase: StartRecoveryCase,
  runtime: RuntimeClientSession,
): Promise<void> {
  expect(result).toMatchObject({
    task: { id: task.id, executionState: failedStart ? 'failed' : 'running' },
    run: { number: 1 },
    attempt: { number: 1, state: failedStart ? 'failed' : 'running' },
  });
  const timeline = await runtime.getTaskTimeline(task.id);
  const hasProviderObservation = testCase.provider === 'claude' &&
    !(failedStart && testCase.boundary.type === 'ContextAllocated');
  const expectedKinds = [
    'task-created',
    ...(hasProviderObservation ? ['provider-session-observed'] : []),
    'attempt-started',
    ...(failedStart ? ['attempt-failed'] : []),
  ];
  expect(kinds(timeline)).toEqual(expectedKinds);
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(failedStart ? 1 : 0);
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.getTaskTimeline(task.id)).resolves.toEqual(timeline);
}

async function verifiesProviderActionRecovery(testCase: ProviderRecoveryCase): Promise<void> {
  const original = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => original);
  const correlation = `${testCase.action}-${testCase.name}-${testCase.mode}-correlation`;
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, `${correlation}-start`, correlation,
  ]);
  const task = await runtime.createTask(taskRequest(
    `${testCase.action}-${testCase.name}-${testCase.mode}-create`,
  ));
  const parent = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: `${testCase.action}-${testCase.name}-${testCase.mode}-start`,
  });
  if (testCase.action === 'resume') original.lose(task.id);
  const request = {
    taskId: task.id,
    providerSessionId: parent.providerSession!.id,
    idempotencyKey: `${testCase.action}-${testCase.name}-${testCase.mode}`,
  };
  const operation = `provider.${testCase.action}`;
  const observed = exerciseFault(subject, operation, testCase);
  const failedCoreStart = testCase.mode !== 'complete' &&
    testCase.boundary.type === 'AttemptStarted';
  const firstRejects = testCase.mode !== 'complete' &&
    (failedCoreStart || boundaryWriteCall(testCase.boundary, operation) <= 4) &&
    !(testCase.action === 'fork' && testCase.boundary.type === 'AttemptSuperseded');
  let first: TaskExecutionView | null = null;
  if (firstRejects) {
    await expect(callProviderAction(runtime, testCase.action, request)).rejects
      .toEqual(new RuntimePortError('internal', true));
  } else first = await callProviderAction(runtime, testCase.action, request);
  observed.assertObserved();
  const recovered = restoredProviderAdapter(original, task.id, testCase.action, failedCoreStart);
  await runtime.disconnect();
  await subject.restartWith(recovered);
  await subject.restart();
  const restarted = await subject.connectWithCorrelations([correlation]);
  const result = await callProviderAction(restarted, testCase.action, request);
  if (first) expect(result).toEqual(first);
  await assertProviderRecovery(
    subject, recovered, restarted, task, parent, result, testCase, failedCoreStart,
  );
}

function restoredProviderAdapter(
  original: FakeClaudeCodeExecutionAdapter,
  taskId: string,
  action: 'resume' | 'fork',
  failedCoreStart: boolean,
): FakeClaudeCodeExecutionAdapter {
  const starts = original.startsFor(taskId);
  const recovered = new FakeClaudeCodeExecutionAdapter();
  const state = starts.length > 1 ? (failedCoreStart ? 'lost' : 'live')
    : (action === 'resume' ? 'lost' : 'live');
  recovered.restore(starts.at(-1)!, state, {
    starts: starts.length,
    stops: original.stopCount(taskId),
  });
  return recovered;
}

async function assertProviderRecovery(
  subject: RuntimeSubject,
  adapter: FakeClaudeCodeExecutionAdapter,
  runtime: RuntimeClientSession,
  task: TaskView,
  parent: TaskExecutionView,
  result: TaskExecutionView,
  testCase: ProviderRecoveryCase,
  failedCoreStart: boolean,
): Promise<void> {
  expect(result).toMatchObject({
    task: { id: task.id, executionState: failedCoreStart ? 'failed' : 'running' },
    run: parent.run,
    attempt: { number: 2, state: failedCoreStart ? 'failed' : 'running' },
    providerSession: { parentId: parent.providerSession!.id,
      lineage: testCase.action === 'resume' ? 'native-resume' : 'fork' },
  });
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.rawObservations).toHaveLength(2);
  expect(adapter.startCount(task.id)).toBe(2);
  expect(adapter.stopCount(task.id)).toBe(
    testCase.action === 'fork' ? (failedCoreStart ? 2 : 1) : (failedCoreStart ? 1 : 0),
  );
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.getTaskTimeline(task.id)).resolves.toEqual(timeline);
}

async function verifiesTerminalRecovery(testCase: TerminalRecoveryCase): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const key = `terminal-${testCase.state}-${testCase.name}-${testCase.mode}`;
  const correlation = `${key}-correlation`;
  let runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, `${correlation}-start`, correlation,
  ]);
  const task = await runtime.createTask(taskRequest(`${key}-create`));
  const start = { taskId: task.id, idempotencyKey: `${key}-start` };
  await runtime.startTask(start);
  const historicalStart = adapter.startsFor(task.id)[0]!;
  const observed = exerciseFault(subject, `task.${testCase.state}`, testCase);
  if (testCase.state === 'cancelled') {
    runtime = await recoverCancellation(
      subject, runtime, adapter, historicalStart, task, key, correlation, testCase, observed,
    );
  } else {
    adapter.exit(task.id, testCase.state === 'completed' ? 0 : 1);
  }
  const status = await waitForTaskState(runtime, task.id, testCase.state);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  await runtime.disconnect();
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  if (testCase.state === 'cancelled') {
    await restarted.cancelTask({ taskId: task.id, idempotencyKey: `${key}-cancel` });
  } else {
    await restarted.startTask(start);
  }
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(status);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  expect(adapter.startCount(task.id)).toBe(1);
  if (testCase.state !== 'cancelled') expect(adapter.stopCount(task.id)).toBe(0);
}

async function recoverCancellation(
  subject: RuntimeSubject,
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
  historicalStart: ReturnType<FakeClaudeCodeExecutionAdapter['startsFor']>[number],
  task: TaskView,
  key: string,
  correlation: string,
  testCase: TerminalRecoveryCase,
  observed: ReturnType<typeof exerciseFault>,
): Promise<RuntimeClientSession> {
  const cancel = { taskId: task.id, idempotencyKey: `${key}-cancel` };
  const firstRejects = testCase.mode !== 'complete' &&
    (testCase.boundary.type === 'CancellationRequested' ||
      testCase.boundary.normalizedKind === 'cancellation-requested');
  if (firstRejects) await expect(runtime.cancelTask(cancel)).rejects
    .toEqual(new RuntimePortError('internal', true));
  else await runtime.cancelTask(cancel);
  observed.assertObserved();
  const recovered = new FakeClaudeCodeExecutionAdapter();
  recovered.restore(historicalStart, adapter.hasRunning(task.id) ? 'live' : 'lost', {
    starts: 1,
    stops: adapter.stopCount(task.id),
  });
  await runtime.disconnect();
  await subject.restartWith(recovered);
  await subject.restart();
  const restarted = await subject.connectWithCorrelations([correlation]);
  await restarted.cancelTask(cancel);
  expect(recovered.startCount(task.id)).toBe(1);
  expect(recovered.stopCount(task.id)).toBe(1);
  return restarted;
}

function callProviderAction(
  runtime: RuntimeClientSession,
  action: 'resume' | 'fork',
  request: { readonly taskId: string; readonly providerSessionId: string;
    readonly idempotencyKey: string },
) {
  return action === 'resume'
    ? runtime.resumeProviderSession(request)
    : runtime.forkProviderSession(request);
}

function prefixThrough(runtimeDirectory: string, eventType: string) {
  const events = readTaskEvents(runtimeDirectory);
  const index = events.findIndex((event) => event.type === eventType);
  if (index < 0) throw new Error(`missing ${eventType}`);
  return events.slice(0, index + 1);
}

function prefixThroughLast(runtimeDirectory: string, eventType: string) {
  const events = readTaskEvents(runtimeDirectory);
  let index = -1;
  for (const [candidate, event] of events.entries()) {
    if (event.type === eventType) index = candidate;
  }
  if (index < 0) throw new Error(`missing ${eventType}`);
  return events.slice(0, index + 1);
}

interface EventBoundary {
  readonly name: string;
  readonly type: string;
  readonly normalizedKind?: string;
}

function kinds(timeline: TaskTimelineView) {
  return timeline.normalizedEvents.map((event) => event.kind);
}

function eventIdentity(event: TaskTimelineView['normalizedEvents'][number]) {
  return [event.kind, event.correlationId, event.idempotencyKey];
}

function exerciseFault(
  subject: RuntimeSubject,
  operation: string,
  testCase: { readonly boundary: EventBoundary;
    readonly mode: (typeof APPEND_DURABILITY_MODES)[number] },
) {
  return observeExpectedExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'),
    {
      operation,
      writeCall: boundaryWriteCall(testCase.boundary, operation),
      eventType: testCase.boundary.type,
      normalizedKind: testCase.boundary.normalizedKind,
    },
    testCase.mode,
  );
}

function boundaryWriteCall(boundary: EventBoundary, operation: string): number {
  const boundaries = operation === 'task.create'
    ? CREATE_BOUNDARIES
    : operation === 'task.start.shell'
      ? SHELL_START_BOUNDARIES
      : operation === 'task.start.claude'
        ? CLAUDE_START_BOUNDARIES
        : operation === 'provider.resume' || operation === 'provider.fork'
          ? PROVIDER_BOUNDARIES
          : TERMINAL_BOUNDARIES[operation.slice(5) as keyof typeof TERMINAL_BOUNDARIES];
  const index = boundaries.findIndex((candidate) => candidate.name === boundary.name);
  if (index < 0) throw new Error(`missing append boundary ${operation}/${boundary.name}`);
  return index + 1;
}

function boundary(name: string, type: string, normalizedKind?: string): EventBoundary {
  return { name, type, normalizedKind };
}

const CREATE_BOUNDARIES = [
  boundary('core TaskCreated', 'TaskCreated'),
  boundary('normalized task-created', 'NormalizedRuntimeEventRecorded', 'task-created'),
] as const;

const SHELL_START_BOUNDARIES = [
  boundary('RunCreated', 'RunCreated'),
  boundary('AttemptCreated', 'AttemptCreated'),
  boundary('ContextAllocated', 'ContextAllocated'),
  boundary('core AttemptStarted', 'AttemptStarted'),
  boundary('normalized attempt-started', 'NormalizedRuntimeEventRecorded', 'attempt-started'),
] as const;

const CLAUDE_START_BOUNDARIES = [
  ...SHELL_START_BOUNDARIES.slice(0, 3),
  boundary('raw provider observation', 'RawProviderObservationRecorded'),
  boundary('normalized provider observation', 'NormalizedRuntimeEventRecorded',
    'provider-session-observed'),
  ...SHELL_START_BOUNDARIES.slice(3),
] as const;

const PROVIDER_BOUNDARIES = [
  boundary('ProviderSessionActionDecided', 'ProviderSessionActionDecided'),
  boundary('AttemptSupersessionRequested', 'AttemptSupersessionRequested'),
  boundary('AttemptSuperseded', 'AttemptSuperseded'),
  boundary('reserved child Attempt', 'provider-child'),
  boundary('ContextAllocated', 'ContextAllocated'),
  boundary('raw provider observation', 'RawProviderObservationRecorded'),
  boundary('normalized provider observation', 'NormalizedRuntimeEventRecorded',
    'provider-session-observed'),
  boundary('core AttemptStarted', 'AttemptStarted'),
  boundary('normalized attempt-started', 'NormalizedRuntimeEventRecorded', 'attempt-started'),
] as const;

const TERMINAL_BOUNDARIES = {
  completed: [
    boundary('core AttemptCompleted', 'AttemptCompleted'),
    boundary('normalized attempt-completed', 'NormalizedRuntimeEventRecorded', 'attempt-completed'),
  ],
  failed: [
    boundary('core AttemptFailed', 'AttemptFailed'),
    boundary('normalized attempt-failed', 'NormalizedRuntimeEventRecorded', 'attempt-failed'),
  ],
  cancelled: [
    boundary('CancellationRequested', 'CancellationRequested'),
    boundary('normalized cancellation-requested', 'NormalizedRuntimeEventRecorded',
      'cancellation-requested'),
    boundary('core AttemptCancelled', 'AttemptCancelled'),
    boundary('normalized attempt-cancelled', 'NormalizedRuntimeEventRecorded', 'attempt-cancelled'),
  ],
} as const;

function createRecoveryCases() {
  return durabilityCases(CREATE_BOUNDARIES);
}

function startRecoveryCases() {
  return [
    ...durabilityCases(SHELL_START_BOUNDARIES).map((item) => ({ ...item, provider: 'shell' as const })),
    ...durabilityCases(CLAUDE_START_BOUNDARIES).map((item) => ({ ...item, provider: 'claude' as const })),
  ];
}

function providerRecoveryCases() {
  return (['resume', 'fork'] as const).flatMap((action) => {
    const boundaries = PROVIDER_BOUNDARIES.map((item) => item.type === 'provider-child'
      ? boundary(item.name, action === 'resume' ? 'AttemptResumed' : 'AttemptForked')
      : item);
    return durabilityCases(boundaries).map((item) => ({ ...item, action }));
  });
}

function terminalRecoveryCases() {
  return (Object.keys(TERMINAL_BOUNDARIES) as Array<keyof typeof TERMINAL_BOUNDARIES>)
    .flatMap((state) => durabilityCases(TERMINAL_BOUNDARIES[state])
      .map((item) => ({ ...item, state })));
}

function durabilityCases<T extends EventBoundary>(boundaries: readonly T[]) {
  return boundaries.flatMap((item) =>
    APPEND_DURABILITY_MODES.map((mode) => ({
      boundary: item,
      name: item.name,
      mode,
    })));
}

type CreateRecoveryCase = ReturnType<typeof createRecoveryCases>[number];
type StartRecoveryCase = ReturnType<typeof startRecoveryCases>[number];
type ProviderRecoveryCase = ReturnType<typeof providerRecoveryCases>[number];
type TerminalRecoveryCase = ReturnType<typeof terminalRecoveryCases>[number];

function taskRequest(idempotencyKey: string) {
  return {
    objective: 'Recover every durable event prefix.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude' as const,
    idempotencyKey,
  };
}

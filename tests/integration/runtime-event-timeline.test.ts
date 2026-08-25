import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import {
  EVENT_REDACTION_FIELDS as INTERFACE_REDACTION_FIELDS,
  EVENT_TIMELINE_MESSAGES as INTERFACE_TIMELINE_MESSAGES,
} from '../../src/shared/runtime/runtime-interface';
import type {
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import {
  EVENT_REDACTION_FIELDS,
  EVENT_TIMELINE_MESSAGES,
} from '../../src/shared/runtime/event-timeline-contract';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  FAILED_APPEND_MODES,
  corruptExecutionAppend,
  createSubject,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline', registerEventTimelineTests);

function registerEventTimelineTests(): void {
  registerRuntimeTaskTestCleanup();
  registerTimelineContractTests();
  registerTimelineRecoveryTests();
}

function registerTimelineContractTests(): void {
  it('re-exports the canonical event timeline allowlists without copies', () => {
    expect(EVENT_REDACTION_FIELDS).toEqual([
      'nativeSessionId', 'capabilities', 'providerNativeId', 'absolutePath',
      'command', 'environment', 'secret', 'unproven',
    ]);
    expect(EVENT_TIMELINE_MESSAGES).toEqual({
      'task-created': 'Task created',
      'provider-session-observed': 'Claude provider session observed',
      'attempt-started': 'Attempt started',
      'attempt-completed': 'Attempt completed',
      'attempt-failed': 'Attempt failed',
      'attempt-cancelled': 'Attempt cancelled',
    });
    expect(INTERFACE_REDACTION_FIELDS).toBe(EVENT_REDACTION_FIELDS);
    expect(INTERFACE_TIMELINE_MESSAGES).toBe(EVENT_TIMELINE_MESSAGES);
  });
  it(
    'projects separate allowlisted provider evidence as a deterministic timeline after replay',
    projectsProviderEvidenceTimeline,
  );
  for (const boundary of PROVIDER_OBSERVATION_APPEND_BOUNDARIES) {
    for (const mode of FAILED_APPEND_MODES) {
      it(
        `repairs ${boundary.name} ${mode} append before a same-key retry and restart`,
        () => repairsProviderObservationAppend(boundary.write, mode),
      );
    }
  }
  it('fails closed when unsafe provider evidence is found in durable bytes',
    rejectsUnsafeProviderEvidence);
  it('fails closed when a future provider-evidence schema is found in durable bytes',
    rejectsFutureProviderEvidence);
  it('fails closed when a normalized event crosses Task identities',
    rejectsCrossTaskNormalizedEvidence);
  it('fails closed when a normalized durable event kind is an inherited object key',
    rejectsInheritedNormalizedEventKind);
  it('fails closed when an unreferenced raw observation crosses Task identities',
    rejectsCrossTaskRawProtocolView);
  it('retains distinct literal request correlations for accepted timeline operations',
    retainsRequestCorrelations);
  it('retains operation-specific identities through native resume and fork',
    retainsProviderOperationIdentities);
  it('stores only allowlisted evidence from the provider observation boundary',
    storesActualAllowlistedProviderEvidence);
}

function registerTimelineRecoveryTests(): void {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'rebuilds the %s Task, status, and full lifecycle timeline after projection deletion',
    rebuildsTerminalLifecycle,
  );
  it.each(FAILED_APPEND_MODES)(
    'repairs task-created normalized evidence after a %s append and same-key retry',
    repairsTaskCreatedEvidence,
  );
  it.each(FAILED_APPEND_MODES)(
    'repairs attempt-started normalized evidence after a %s append and same-key retry',
    repairsAttemptStartedEvidence,
  );
  it.each(PROVIDER_OPERATION_APPEND_CASES)(
    'repairs $operation $boundary $mode evidence before same-key retry and restart',
    repairsProviderOperationEvidence,
  );
  it.each(TERMINAL_APPEND_CASES)(
    'repairs $state normalized evidence after a $mode append and restart',
    repairsTerminalEvidence,
  );
}

const PROVIDER_OBSERVATION_APPEND_BOUNDARIES = [
  { name: 'raw observation', write: 4 },
  { name: 'normalized event', write: 5 },
] as const;

const PROVIDER_OPERATION_APPEND_CASES = (['resume', 'fork'] as const).flatMap((operation) =>
  ([
    { boundary: 'raw observation', write: 6 },
    { boundary: 'normalized observation', write: 7 },
    { boundary: 'normalized attempt start', write: 9 },
  ] as const).flatMap(({ boundary, write }) => FAILED_APPEND_MODES.map((mode) => ({
    operation, boundary, write, mode,
  }))));

const TERMINAL_APPEND_CASES = (['completed', 'failed', 'cancelled'] as const).flatMap((state) =>
  FAILED_APPEND_MODES.map((mode) => ({ state, mode })));

async function projectsProviderEvidenceTimeline(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, started, timeline } = await startTimelineTask(runtime, 'timeline');

  assertTimelineProjection(task, started, timeline);
  assertSafeRawEvidence(subject.runtimeDirectory, task.id, timeline);
  await assertTimelineReplay(subject, runtime, task, started, timeline);
}

function assertTimelineProjection(
  task: TaskView,
  started: TaskExecutionView,
  timeline: TaskTimelineView,
): void {
  expect(timeline).toMatchObject({ taskId: task.id, status: started });
  expect(timeline.rawObservations).toMatchObject([{
      schema: 'hariari.provider-observation',
      version: 1,
      taskId: task.id,
      provider: 'claude',
      kind: 'provider-session-observed',
      observedAt: '2026-08-21T10:00:00.000Z',
      evidence: { sessionState: 'active' },
      redaction: { status: 'allowlisted', omittedFields: ['nativeSessionId', 'capabilities'] },
  }]);
  assertNormalizedProjection(task, timeline);
  assertReadableTimeline(timeline);
}

function assertNormalizedProjection(task: TaskView, timeline: TaskTimelineView): void {
  expect(timeline.normalizedEvents).toMatchObject([{
      schema: 'hariari.runtime.event', version: 1, taskId: task.id,
      kind: 'task-created', idempotencyKey: 'timeline-create', sequence: 1,
      occurrenceAt: '2026-08-21T10:00:00.000Z', observedAt: '2026-08-21T10:00:00.000Z',
      redaction: { status: 'allowlisted', omittedFields: [] },
    }, {
      schema: 'hariari.runtime.event',
      version: 1,
      taskId: task.id,
      kind: 'provider-session-observed',
      idempotencyKey: 'timeline-start',
      occurrenceAt: '2026-08-21T10:00:00.000Z',
      observedAt: '2026-08-21T10:00:00.000Z',
      sequence: 2,
      redaction: { status: 'allowlisted', omittedFields: ['nativeSessionId', 'capabilities'] },
    }, {
      schema: 'hariari.runtime.event', version: 1, taskId: task.id,
      kind: 'attempt-started', idempotencyKey: 'timeline-start', sequence: 3,
      occurrenceAt: '2026-08-21T10:00:00.000Z', observedAt: '2026-08-21T10:00:00.000Z',
      redaction: { status: 'allowlisted', omittedFields: [] },
  }]);
  expect(timeline.rawObservations[0]?.id).not.toBe(timeline.normalizedEvents[1]?.id);
  expect(timeline.normalizedEvents[1]?.correlationId).not.toBe('timeline-start');
  expect(timeline.normalizedEvents[1]?.causationId).toBe(timeline.rawObservations[0]?.id);
}

function assertReadableTimeline(timeline: TaskTimelineView): void {
  expect(timeline.timeline).toMatchObject([{
      sequence: 1, occurredAt: '2026-08-21T10:00:00.000Z', message: 'Task created',
    }, {
      sequence: 2,
      occurredAt: '2026-08-21T10:00:00.000Z',
      message: 'Claude provider session observed',
    }, {
      sequence: 3, occurredAt: '2026-08-21T10:00:00.000Z', message: 'Attempt started',
  }]);
  expect(timeline.timeline[1]?.eventId).toBe(timeline.normalizedEvents[1]?.id);
}

function assertSafeRawEvidence(
  runtimeDirectory: string,
  taskId: string,
  timeline: TaskTimelineView,
): void {
  const rawFramePayloads = framedPayloads(
    fs.readFileSync(path.join(runtimeDirectory, 'tasks', 'events.log')),
  ).filter((payload) => payload.type === 'RawProviderObservationRecorded');
  expect(rawFramePayloads).toEqual([{ type: 'RawProviderObservationRecorded', version: 1,
    taskId, observation: timeline.rawObservations[0] }]);
  expect(JSON.stringify(rawFramePayloads)).not.toMatch(
    /fake-local-checkout|processId|ptyId|command|environment|token/,
  );
}

async function assertTimelineReplay(
  subject: Awaited<ReturnType<typeof createSubject>>,
  runtime: RuntimeClientSession,
  task: TaskView,
  started: TaskExecutionView,
  timeline: TaskTimelineView,
): Promise<void> {
  await runtime.disconnect();
  fs.rmSync(path.join(subject.runtimeDirectory, 'tasks', 'projection.json'));
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.listTasks()).resolves.toContainEqual(task);
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(started);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
}

async function repairsProviderObservationAppend(
  failedWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Repair durable provider evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: `repair-${failedWrite}-${mode}-create`,
  });
  const request = { taskId: task.id, idempotencyKey: `repair-${failedWrite}-${mode}-start` };
  corruptExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'),
    failedWrite,
    mode,
  );

  const started = await runtime.startTask(request);
  const timeline = await runtime.getTaskTimeline(task.id);
  await expect(runtime.startTask(request)).resolves.toEqual(started);
  expect(timeline.rawObservations).toHaveLength(1);
  expect(timeline.normalizedEvents).toHaveLength(3);
  await runtime.disconnect();

  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
}

async function repairsTaskCreatedEvidence(
  mode: (typeof FAILED_APPEND_MODES)[number],
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const request = {
    objective: 'Repair Task creation evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude' as const,
    idempotencyKey: `task-created-${mode}`,
  };
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), 2, mode);

  await expect(runtime.createTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
  const task = await runtime.createTask(request);
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.map((event) => event.kind)).toEqual(['task-created']);
  await assertTimelineReplay(subject, runtime, task, timeline.status, timeline);
}

async function repairsAttemptStartedEvidence(
  mode: (typeof FAILED_APPEND_MODES)[number],
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Repair attempt start evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: `attempt-started-${mode}-create`,
  });
  const request = { taskId: task.id, idempotencyKey: `attempt-started-${mode}` };
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), 7, mode);

  const started = await runtime.startTask(request);
  await expect(runtime.startTask(request)).resolves.toEqual(started);
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.map((event) => event.kind)).toEqual([
    'task-created', 'provider-session-observed', 'attempt-started',
  ]);
  await assertTimelineReplay(subject, runtime, task, started, timeline);
}

async function repairsProviderOperationEvidence(
  fault: (typeof PROVIDER_OPERATION_APPEND_CASES)[number],
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task, started } = await startTimelineTask(runtime, `repair-${fault.operation}-${fault.mode}`);
  if (fault.operation === 'resume') adapter.lose(task.id);
  const request = {
    taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: `repair-${fault.operation}-${fault.boundary}-${fault.mode}`,
  };
  corruptExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'), fault.write, fault.mode,
  );

  const result = fault.operation === 'resume'
    ? await runtime.resumeProviderSession(request) : await runtime.forkProviderSession(request);
  const retry = fault.operation === 'resume'
    ? runtime.resumeProviderSession(request) : runtime.forkProviderSession(request);
  await expect(retry).resolves.toEqual(result);
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.rawObservations).toHaveLength(2);
  expect(timeline.normalizedEvents).toHaveLength(5);
  await assertTimelineReplay(subject, runtime, task, result, timeline);
}

async function repairsTerminalEvidence(
  fault: (typeof TERMINAL_APPEND_CASES)[number],
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const key = `repair-${fault.state}-${fault.mode}`;
  const cancellationCorrelation = `${key}-cancel-correlation`;
  const runtime = fault.state === 'cancelled'
    ? await subject.connectWithCorrelations([
        `${key}-create-correlation`,
        `${key}-start-correlation`,
        `${key}-start-retry-correlation`,
        cancellationCorrelation,
        cancellationCorrelation,
      ])
    : await subject.connect();
  const { task } = await startTimelineTask(runtime, key);
  const write = fault.state === 'cancelled' ? 3 : 2;
  corruptExecutionAppend(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), write, fault.mode);

  if (fault.state === 'cancelled') {
    const request = { taskId: task.id, idempotencyKey: `${key}-cancel` };
    await runtime.cancelTask(request);
    await runtime.cancelTask(request);
    await waitForExecutionState(runtime, task.id, 'cancelled');
  } else {
    await settleTimelineTask(runtime, adapter, task.id, fault.state);
  }
  const status = await runtime.getTaskExecution(task.id);
  const timeline = await runtime.getTaskTimeline(task.id);
  await expect(runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` }))
    .resolves.toEqual(status);
  expect(timeline.normalizedEvents.at(-1)?.kind).toBe(`attempt-${fault.state}`);
  if (fault.state === 'cancelled') {
    expect(timeline.normalizedEvents.at(-1)?.correlationId).toBe(cancellationCorrelation);
    expect(timeline.normalizedEvents.filter((event) => event.kind === 'attempt-cancelled'))
      .toHaveLength(1);
  }
  await assertTimelineReplay(subject, runtime, task, status, timeline);
}

async function rejectsUnsafeProviderEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Reject unsafe durable evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: 'unsafe-evidence-create',
  });
  const timeline = await runtime.startTask({ taskId: task.id, idempotencyKey: 'unsafe-evidence-start' })
    .then(() => runtime.getTaskTimeline(task.id));
  const unsafe = {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    observation: {
      ...timeline.rawObservations[0], absolutePath: '/private/provider/secret',
      command: 'export SECRET_TOKEN=unsafe', environment: { SECRET_TOKEN: 'unsafe' },
      providerNativeId: 'native-secret', nested: { secretLikeToken: 'unsafe' },
    },
  };
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  appendFramedPayload(eventPath, unsafe);
  expect(fs.readFileSync(eventPath, 'utf8')).toContain('SECRET_TOKEN=unsafe');
  await runtime.disconnect();

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsFutureProviderEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Reject future durable evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: 'future-evidence-create',
  });
  const timeline = await runtime.startTask({ taskId: task.id, idempotencyKey: 'future-evidence-start' })
    .then(() => runtime.getTaskTimeline(task.id));
  appendFramedPayload(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    observation: { ...timeline.rawObservations[0], version: 2 },
  });
  await runtime.disconnect();

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsCrossTaskNormalizedEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const first = await createStartedTimelineTask(runtime, 'first');
  const second = await createStartedTimelineTask(runtime, 'second');
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  appendFramedPayload(eventPath, {
    type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: first.taskId,
    event: {
      ...second.normalizedEvents[0], id: `${second.normalizedEvents[0]?.id}-cross-task`,
      taskId: first.taskId, runId: first.status.run?.id,
      attemptId: first.status.attempt?.id, providerSessionId: first.status.providerSession?.id,
      sequence: first.normalizedEvents.length + 1,
    },
  });
  await runtime.disconnect();

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsInheritedNormalizedEventKind(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Reject inherited normalized event kinds.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: 'inherited-kind-create',
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'inherited-kind-start' });
  const timeline = await runtime.getTaskTimeline(task.id);
  appendFramedPayload(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'NormalizedRuntimeEventRecorded',
    version: 1,
    taskId: task.id,
    event: {
      schema: 'hariari.runtime.event',
      version: 1,
      id: 'independently-built-inherited-kind-event',
      taskId: task.id,
      runId: timeline.status.run?.id,
      attemptId: timeline.status.attempt?.id,
      providerSessionId: timeline.status.providerSession?.id,
      kind: 'toString',
      correlationId: 'inherited-kind-correlation',
      causationId: timeline.normalizedEvents.at(-1)?.id,
      idempotencyKey: 'inherited-kind-operation',
      sequence: timeline.normalizedEvents.length + 1,
      occurrenceAt: '2026-08-21T10:00:00.000Z',
      observedAt: '2026-08-21T10:00:00.000Z',
      redaction: { status: 'allowlisted', omittedFields: [] },
    },
  });
  await runtime.disconnect();

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsCrossTaskRawProtocolView(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { timeline } = await startTimelineTask(runtime, 'raw-protocol-identity');
  const crossTaskObservation = {
    schema: 'hariari.provider-observation' as const,
    version: 1 as const,
    id: 'independent-cross-task-observation',
    taskId: 'different-task',
    provider: 'claude' as const,
    kind: 'provider-session-observed' as const,
    observedAt: '2026-08-21T10:00:00.000Z',
    evidence: { sessionState: 'active' as const },
    redaction: { status: 'allowlisted' as const, omittedFields: [] },
  };

  expect(() => parseTaskTimelineView({
    ...timeline,
    rawObservations: [...timeline.rawObservations, crossTaskObservation],
  } as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function retainsRequestCorrelations(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connectWithCorrelations(Object.values(REQUEST_CORRELATIONS));
  const task = await runtime.createTask({
    objective: 'Retain request correlations.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude',
    idempotencyKey: 'literal-create-idempotency',
  });
  const started = await runtime.startTask({
    taskId: task.id,
    idempotencyKey: 'literal-start-idempotency',
  });
  adapter.lose(task.id);
  const resumed = await runtime.resumeProviderSession({
    taskId: task.id,
    providerSessionId: started.providerSession!.id,
    idempotencyKey: 'literal-resume-idempotency',
  });
  await runtime.forkProviderSession({
    taskId: task.id,
    providerSessionId: resumed.providerSession!.id,
    idempotencyKey: 'literal-fork-idempotency',
  });
  await runtime.cancelTask({
    taskId: task.id,
    idempotencyKey: 'literal-cancel-idempotency',
  });
  await waitForExecutionState(runtime, task.id, 'cancelled');
  const timeline = await runtime.getTaskTimeline(task.id);

  expectTimelineRequestCorrelations(timeline);
  await assertTimelineReplay(subject, runtime, task, timeline.status, timeline);
}

const REQUEST_CORRELATIONS = {
  create: 'literal-create-correlation',
  start: 'literal-start-correlation',
  resume: 'literal-resume-correlation',
  fork: 'literal-fork-correlation',
  cancel: 'literal-cancel-correlation',
} as const;

function expectTimelineRequestCorrelations(timeline: TaskTimelineView): void {
  expect(timeline.normalizedEvents.map((event) => [
    event.kind,
    event.correlationId,
    event.idempotencyKey,
  ])).toEqual([
    ['task-created', REQUEST_CORRELATIONS.create, 'literal-create-idempotency'],
    ['provider-session-observed', REQUEST_CORRELATIONS.start, 'literal-start-idempotency'],
    ['attempt-started', REQUEST_CORRELATIONS.start, 'literal-start-idempotency'],
    ['provider-session-observed', REQUEST_CORRELATIONS.resume, 'literal-resume-idempotency'],
    ['attempt-started', REQUEST_CORRELATIONS.resume, 'literal-resume-idempotency'],
    ['provider-session-observed', REQUEST_CORRELATIONS.fork, 'literal-fork-idempotency'],
    ['attempt-started', REQUEST_CORRELATIONS.fork, 'literal-fork-idempotency'],
    ['attempt-cancelled', REQUEST_CORRELATIONS.cancel, 'literal-cancel-idempotency'],
  ]);
}

async function retainsProviderOperationIdentities(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task, started } = await startTimelineTask(runtime, 'operation-identities');
  adapter.lose(task.id);
  const resumed = await runtime.resumeProviderSession({
    taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: 'operation-identities-resume',
  });
  const forked = await runtime.forkProviderSession({
    taskId: task.id, providerSessionId: resumed.providerSession!.id,
    idempotencyKey: 'operation-identities-fork',
  });

  const timeline = await runtime.getTaskTimeline(task.id);
  const providerEvents = timeline.normalizedEvents
    .filter((event) => event.kind === 'provider-session-observed');
  expect(providerEvents).toHaveLength(3);
  assertProviderOperation(providerEvents[0], timeline.rawObservations[0], started,
    'operation-identities-start', 2);
  assertProviderOperation(providerEvents[1], timeline.rawObservations[1], resumed,
    'operation-identities-resume', 4);
  assertProviderOperation(providerEvents[2], timeline.rawObservations[2], forked,
    'operation-identities-fork', 6);
  await runtime.disconnect();
}

function assertProviderOperation(
  event: TaskTimelineView['normalizedEvents'][number] | undefined,
  observation: TaskTimelineView['rawObservations'][number] | undefined,
  execution: TaskExecutionView,
  idempotencyKey: string,
  sequence: number,
): void {
  expect(event).toMatchObject({
    taskId: execution.task.id, runId: execution.run?.id, attemptId: execution.attempt?.id,
    providerSessionId: execution.providerSession?.id, idempotencyKey, sequence,
  });
  expect(event?.correlationId).not.toBe(idempotencyKey);
  expect(event?.id).not.toBe(execution.providerSession?.id);
  expect(event?.causationId).toBe(observation?.id);
  expect(event?.id).not.toBe(observation?.id);
}

async function storesActualAllowlistedProviderEvidence(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({
    providerObservation: () => ({
      provider: 'claude', kind: 'provider-session-observed', sessionState: 'active',
      nativeSessionId: 'native-unsafe-value', capabilities: { resume: true, fork: true },
      absolutePath: '/private/provider/unsafe-path', command: 'print unsafe-command-value',
      environment: { SECRET_TOKEN: 'unsafe-environment-value' },
      providerNativeId: 'unsafe-provider-id', token: 'unsafe-token-value',
      nested: { secret: 'unsafe-nested-value' },
    }),
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'actual-evidence');

  expect(timeline.rawObservations[0]).toMatchObject({
    taskId: task.id,
    evidence: { sessionState: 'active' },
    redaction: { status: 'allowlisted', omittedFields: [
      'nativeSessionId', 'capabilities', 'providerNativeId', 'absolutePath',
      'command', 'environment', 'secret', 'unproven',
    ] },
  });
  const durable = fs.readFileSync(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), 'utf8');
  expect(durable).not.toMatch(
    /native-unsafe-value|unsafe-path|unsafe-command-value|unsafe-environment-value|unsafe-provider-id|unsafe-token-value|unsafe-nested-value/,
  );
  await runtime.disconnect();
}

async function rebuildsTerminalLifecycle(
  terminalState: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, `lifecycle-${terminalState}`);
  await settleTimelineTask(runtime, adapter, task.id, terminalState);
  const status = await runtime.getTaskExecution(task.id);
  const timeline = await runtime.getTaskTimeline(task.id);

  expect(timeline.normalizedEvents.map((event) => event.kind)).toEqual([
    'task-created', 'provider-session-observed', 'attempt-started', `attempt-${terminalState}`,
  ]);
  expect(timeline.timeline.map((entry) => entry.message)).toEqual([
    'Task created', 'Claude provider session observed', 'Attempt started',
    terminalState === 'completed' ? 'Attempt completed'
      : terminalState === 'failed' ? 'Attempt failed' : 'Attempt cancelled',
  ]);
  await assertTimelineReplay(subject, runtime, task, status, timeline);
}

async function settleTimelineTask(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
  taskId: string,
  terminalState: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (terminalState === 'cancelled') {
    await runtime.cancelTask({ taskId, idempotencyKey: 'lifecycle-cancelled-cancel' });
  } else {
    adapter.exit(taskId, terminalState === 'completed' ? 0 : 1);
  }
  await waitForExecutionState(runtime, taskId, terminalState);
}

async function waitForExecutionState(
  runtime: RuntimeClientSession,
  taskId: string,
  expected: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await runtime.getTaskExecution(taskId);
    const timeline = await runtime.getTaskTimeline(taskId);
    if (execution.task.executionState === expected &&
      timeline.normalizedEvents.some((event) => event.kind === `attempt-${expected}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not reach ${expected}`);
}

async function createStartedTimelineTask(
  runtime: RuntimeClientSession,
  key: string,
) {
  const task = await runtime.createTask({
    objective: `Start ${key} timeline task.`, project: 'Hariari', repository: 'fake-local-checkout',
    baseRef: 'HEAD', provider: 'claude', idempotencyKey: `${key}-create`,
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` });
  return runtime.getTaskTimeline(task.id);
}

async function startTimelineTask(
  runtime: RuntimeClientSession,
  key: string,
): Promise<{ readonly task: TaskView; readonly started: TaskExecutionView; readonly timeline: TaskTimelineView }> {
  const task = await runtime.createTask({
    objective: 'Expose one safe provider observation.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: `${key}-create`,
  });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` });
  await expect(runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` }))
    .resolves.toEqual(started);
  return { task, started, timeline: await runtime.getTaskTimeline(task.id) };
}

function framedPayloads(bytes: Buffer): readonly Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const payloadOffset = offset + 36;
    payloads.push(JSON.parse(bytes.subarray(payloadOffset, payloadOffset + length).toString('utf8')));
    offset = payloadOffset + length;
  }
  return payloads;
}

function appendFramedPayload(eventPath: string, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.alloc(36 + body.length);
  frame.writeUInt32BE(body.length, 0);
  createHash('sha256').update(body).digest().copy(frame, 4);
  body.copy(frame, 36);
  fs.appendFileSync(eventPath, frame);
}

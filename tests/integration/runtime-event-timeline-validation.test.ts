import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import { TaskEventTimeline } from '../../src/runtime/task-event-timeline';
import { TaskModule } from '../../src/runtime/task-module';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { timelineEntry } from '../../src/shared/runtime/event-timeline-contract';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  appendTaskEventFrame,
  createStartedTask,
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
  type RuntimeSubject,
  waitForTaskState,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline validation', registerValidationTests);

function registerValidationTests(): void {
  registerRuntimeTaskTestCleanup();
  registerRoundSevenIdentityTests();
  registerRoundSevenDuplicateTests();
  registerReplayErrorTaxonomyTests();
  registerExistingValidationTests();
}

function registerReplayErrorTaxonomyTests(): void {
  it('maps a checksum-valid structurally invalid core record to event-history-invalid',
    rejectsStructurallyInvalidCoreRecord);
  it('maps checksum-valid core lifecycle ordering corruption to event-history-invalid',
    rejectsCoreLifecycleOrderingCorruption);
  it('maps contradictory checksum-valid terminal records to event-history-invalid',
    rejectsContradictoryTerminalRecords);
  it('keeps a physical checksum failure classified as internal', rejectsPhysicalChecksumFailure);
}

async function rejectsStructurallyInvalidCoreRecord(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, 'invalid-core-record');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RunCreated', version: 1, taskId: task.id,
    idempotencyKey: 'invalid-core-run', correlationId: 'invalid-core-correlation',
    fingerprint: 'invalid-core-fingerprint',
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsCoreLifecycleOrderingCorruption(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startTimelineTask(runtime, 'invalid-core-order');
  const records = [...readTaskEvents(subject.runtimeDirectory)];
  const startedIndex = records.findIndex((event) => event.type === 'AttemptStarted');
  const attemptIndex = records.findIndex((event) => event.type === 'AttemptCreated');
  const [started] = records.splice(startedIndex, 1);
  records.splice(attemptIndex + 1, 0, started!);
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, records);
  await expectInvalidHistory(subject);
}

async function rejectsContradictoryTerminalRecords(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, 'contradictory-terminal');
  adapter.exit(task.id, 0);
  await waitForTaskState(runtime, task.id, 'completed');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'AttemptFailed', version: 1, taskId: task.id,
    occurredAt: '2026-08-25T10:00:00.000Z',
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsPhysicalChecksumFailure(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startTimelineTask(runtime, 'physical-checksum-failure');
  await runtime.disconnect();
  await subject.stop();
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  const bytes = fs.readFileSync(eventPath);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  fs.writeFileSync(eventPath, bytes);
  await expect(subject.restart()).rejects.toEqual(new TaskStorageError('internal'));
}

function expectInvalidHistory(subject: RuntimeSubject): Promise<void> {
  return expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
}

function registerRoundSevenIdentityTests(): void {
  it.each(['start', 'resume', 'fork'] as const)(
    'rejects a coordinated %s observation rewrite at the public protocol seam',
    rejectsCoordinatedObservationRewriteAtProtocolSeam,
  );
  it.each(['start', 'resume', 'fork'] as const)(
    'fails replay on a coordinated %s observation rewrite',
    rejectsCoordinatedObservationRewriteOnReplay,
  );
  it.each(['start', 'resume', 'fork'] as const)(
    'binds the coordinated %s observation phases to the authoritative execution operation',
    rejectsRewrittenObservationAndStartOnReplay,
  );
}

function registerRoundSevenDuplicateTests(): void {
  it('rejects an exact checksum-valid duplicate durable TaskCreated record',
    rejectsExactDuplicateTaskCreatedOnReplay);
  it('rejects an exact checksum-valid duplicate durable raw observation record',
    rejectsExactDuplicateRawObservationOnReplay);
  it('keeps Task command retries idempotent without appending duplicate durable records',
    retainsCommandRetryIdempotency);
  it('keeps in-memory TaskModule retries from producing duplicate records',
    retainsInMemoryTaskModuleIdempotency);
  it('rejects an exact duplicate raw observation in an in-memory TaskEventTimeline',
    rejectsInMemoryTimelineRawDuplicate);
}

function registerExistingValidationTests(): void {
  it('fails closed on unsafe durable provider evidence', rejectsUnsafeProviderEvidence);
  it('fails closed on a future durable provider-evidence schema', rejectsFutureProviderEvidence);
  it('fails closed on a noncanonical raw observation identity', rejectsNoncanonicalRawIdentity);
  it('rejects a forged canonical raw link at the public protocol seam',
    rejectsForgedRawLinkAtProtocolSeam);
  it('fails closed when durable raw evidence names a foreign provider session',
    rejectsForeignProviderSessionEvidence);
  it('fails closed on an unlinked same-Task raw observation after replay',
    rejectsSameTaskRawOrphan);
  it('rejects a normalized provider event whose raw evidence is missing',
    rejectsMissingRawEvidence);
  it('fails closed on a noncanonical normalized event identity',
    rejectsNoncanonicalNormalizedIdentity);
  it('fails closed when a canonical task-created event crosses Tasks',
    rejectsCrossTaskCreatedEvent);
  it('rejects a second canonical task-created event at the public protocol seam',
    rejectsDuplicateTaskCreatedAtProtocolSeam);
  it('fails replay rather than overwriting Task ownership with an alternate create key',
    rejectsTaskCreateOwnershipCollision);
  it('binds the replayed task-created event to the durable Task create identity',
    rejectsReplacedTaskCreatedIdentity);
  it('fails closed on an inherited-object normalized event kind',
    rejectsInheritedNormalizedEventKind);
  it('rejects an attempt terminal event without its attempt-started phase',
    rejectsTerminalWithoutStart);
  it('rejects a terminal event that disagrees with final Task and Attempt status',
    rejectsTerminalStatusMismatch);
  it('rejects an unreferenced cross-Task raw observation at the public protocol seam',
    rejectsCrossTaskRawProtocolView);
}

async function rejectsUnsafeProviderEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'unsafe-evidence');
  const unsafe = {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    providerSessionId: timeline.status.providerSession?.id,
    idempotencyKey: 'unsafe-evidence-start',
    observation: {
      ...timeline.rawObservations[0], absolutePath: '/private/provider/secret',
      command: 'export SECRET_TOKEN=unsafe', environment: { SECRET_TOKEN: 'unsafe' },
      providerNativeId: 'native-secret', nested: { secretLikeToken: 'unsafe' },
    },
  };
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  appendTaskEventFrame(eventPath, unsafe);
  expect(fs.readFileSync(eventPath, 'utf8')).toContain('SECRET_TOKEN=unsafe');
  await runtime.disconnect();
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsFutureProviderEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'future-evidence');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    providerSessionId: timeline.status.providerSession?.id,
    idempotencyKey: 'future-evidence-start',
    observation: { ...timeline.rawObservations[0], version: 2 },
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsNoncanonicalRawIdentity(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'raw-identity');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    providerSessionId: timeline.status.providerSession?.id,
    idempotencyKey: 'raw-identity-start',
    observation: { ...timeline.rawObservations[0], id: 'syntactically-valid-arbitrary-id' },
  });
  await runtime.disconnect();
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsForgedRawLinkAtProtocolSeam(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'forged-raw-link');
  const forgedId = `provider-observation:${task.id}:${timeline.status.providerSession?.id}:forged-key`;
  expect(() => parseTaskTimelineView(({
    ...timeline,
    rawObservations: [{ ...timeline.rawObservations[0], id: forgedId }],
    normalizedEvents: timeline.normalizedEvents.map((event) =>
      event.kind === 'provider-session-observed' ? { ...event, causationId: forgedId } : event),
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsCoordinatedObservationRewriteAtProtocolSeam(
  operation: ProviderObservationOperation,
): Promise<void> {
  const { runtime, timeline } = await operationTimeline(operation, `protocol-${operation}`);
  const forged = forgeLatestObservation(timeline, `forged-${operation}-operation`);
  expect(() => parseTaskTimelineView(forged as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsCoordinatedObservationRewriteOnReplay(
  operation: ProviderObservationOperation,
): Promise<void> {
  const { subject, runtime, timeline } = await operationTimeline(operation, `replay-${operation}`);
  const forged = forgeLatestObservation(timeline, `forged-${operation}-operation`);
  const rawId = timeline.rawObservations.at(-1)!.id;
  const providerEventId = timeline.normalizedEvents.filter((event) =>
    event.kind === 'provider-session-observed').at(-1)!.id;
  const durable = readTaskEvents(subject.runtimeDirectory).map((record) => {
    const observation = record.observation as { readonly id?: unknown } | undefined;
    if (record.type === 'RawProviderObservationRecorded' && observation?.id === rawId) {
      return { ...record, idempotencyKey: forged.rawObservations.at(-1)!.idempotencyKey,
        observation: forged.rawObservations.at(-1) };
    }
    const event = record.event as { readonly id?: unknown } | undefined;
    return record.type === 'NormalizedRuntimeEventRecorded' && event?.id === providerEventId
      ? { ...record, event: forged.normalizedEvents.find((item) => item.id === providerEventId) }
      : record;
  });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, durable);
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsRewrittenObservationAndStartOnReplay(
  operation: ProviderObservationOperation,
): Promise<void> {
  const { subject, runtime, timeline } = await operationTimeline(operation, `authority-${operation}`);
  const key = `forged-${operation}-authority`;
  const forged = forgeLatestObservation(timeline, key);
  const attemptId = timeline.status.attempt!.id;
  const durable = readTaskEvents(subject.runtimeDirectory).map((record) => {
    const observation = record.observation as { readonly id?: unknown } | undefined;
    if (record.type === 'RawProviderObservationRecorded' &&
      observation?.id === timeline.rawObservations.at(-1)!.id) {
      return { ...record, idempotencyKey: key, observation: forged.rawObservations.at(-1) };
    }
    const event = record.event as { readonly attemptId?: unknown; readonly kind?: unknown } | undefined;
    if (record.type !== 'NormalizedRuntimeEventRecorded' || event?.attemptId !== attemptId) {
      return record;
    }
    if (event.kind === 'provider-session-observed') {
      return { ...record, event: forged.normalizedEvents.find((item) =>
        item.attemptId === attemptId && item.kind === 'provider-session-observed') };
    }
    return event.kind === 'attempt-started'
      ? { ...record, event: { ...event, idempotencyKey: key } }
      : record;
  });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, durable);
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsExactDuplicateTaskCreatedOnReplay(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startTimelineTask(runtime, 'duplicate-durable-task-created');
  const duplicate = readTaskEvents(subject.runtimeDirectory).find((event) =>
    event.type === 'TaskCreated')!;
  await runtime.disconnect();
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), duplicate);
  await expectInvalidHistory(subject);
}

async function rejectsExactDuplicateRawObservationOnReplay(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startTimelineTask(runtime, 'duplicate-durable-raw');
  const duplicate = readTaskEvents(subject.runtimeDirectory).find((event) =>
    event.type === 'RawProviderObservationRecorded')!;
  await runtime.disconnect();
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), duplicate);
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function retainsCommandRetryIdempotency(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const request = {
    objective: 'Keep retries out of durable history.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude' as const,
    idempotencyKey: 'retry-without-duplicate-create',
  };
  const task = await runtime.createTask(request);
  const start = { taskId: task.id, idempotencyKey: 'retry-without-duplicate-start' };
  const started = await runtime.startTask(start);
  const before = readTaskEvents(subject.runtimeDirectory);
  await expect(runtime.createTask(request)).resolves.toEqual(task);
  await expect(runtime.startTask(start)).resolves.toEqual(started);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(before);
  await runtime.disconnect();
  await expect(subject.restart()).resolves.toBeUndefined();
}

async function retainsInMemoryTaskModuleIdempotency(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-task-module-duplicate-'));
  try {
    const module = new TaskModule(root, () => Date.parse('2026-08-21T10:00:00.000Z'),
      () => 'in-memory-task-id');
    await module.start();
    const request = {
      objective: 'Keep an in-memory retry idempotent.', project: 'Hariari',
      repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude' as const,
      idempotencyKey: 'in-memory-create-key',
    };
    const task = await module.create(request, 'in-memory-create-correlation');
    await expect(module.create(request, 'ignored-retry-correlation')).resolves.toEqual(task);
    expect(readTaskEvents(root).filter((event) => event.type === 'TaskCreated')).toHaveLength(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function rejectsInMemoryTimelineRawDuplicate(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'in-memory-raw-duplicate');
  const observation = timeline.rawObservations[0]!;
  const record = {
    type: 'RawProviderObservationRecorded' as const, version: 1 as const, taskId: task.id,
    providerSessionId: observation.providerSessionId,
    idempotencyKey: observation.idempotencyKey,
    observation,
  };
  const projection = new TaskEventTimeline({
    now: () => observation.observedAt,
    append: async () => undefined,
    execution: () => { throw new Error('not needed for raw replay'); },
  });
  projection.apply(record, timeline.status);
  expect(() => projection.apply(record, timeline.status)).toThrow();
  await runtime.disconnect();
}

async function operationTimeline(operation: ProviderObservationOperation, key: string) {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task, timeline: started } = await startTimelineTask(runtime, key);
  if (operation === 'resume') {
    adapter.lose(task.id);
    await runtime.resumeProviderSession({ taskId: task.id,
      providerSessionId: started.status.providerSession!.id,
      idempotencyKey: `${key}-resume` });
  }
  if (operation === 'fork') {
    await runtime.forkProviderSession({ taskId: task.id,
      providerSessionId: started.status.providerSession!.id,
      idempotencyKey: `${key}-fork` });
  }
  return { subject, runtime, timeline: await runtime.getTaskTimeline(task.id) };
}

function forgeLatestObservation(timeline: Awaited<ReturnType<RuntimeClientSession['getTaskTimeline']>>, key: string) {
  const raw = timeline.rawObservations.at(-1)!;
  const rawId = `provider-observation:${raw.taskId}:${raw.providerSessionId}:${key}`;
  const observation = { ...raw, id: rawId, idempotencyKey: key };
  const providerEvent = timeline.normalizedEvents.filter((event) =>
    event.kind === 'provider-session-observed').at(-1)!;
  return {
    ...timeline,
    rawObservations: timeline.rawObservations.map((item) => item.id === raw.id ? observation : item),
    normalizedEvents: timeline.normalizedEvents.map((event) => event.id === providerEvent.id
      ? { ...event, idempotencyKey: key, causationId: rawId }
      : event),
  };
}

type ProviderObservationOperation = 'start' | 'resume' | 'fork';

async function rejectsForeignProviderSessionEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'foreign-session');
  const providerSessionId = 'foreign-provider-session';
  const idempotencyKey = 'foreign-session-orphan';
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    providerSessionId, idempotencyKey,
    observation: {
      ...timeline.rawObservations[0], providerSessionId, idempotencyKey,
      id: `provider-observation:${task.id}:${providerSessionId}:${idempotencyKey}`,
    },
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsSameTaskRawOrphan(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'same-task-orphan');
  const providerSessionId = timeline.status.providerSession!.id;
  const idempotencyKey = 'same-task-orphan-extra';
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
    providerSessionId, idempotencyKey,
    observation: {
      ...timeline.rawObservations[0], providerSessionId, idempotencyKey,
      id: `provider-observation:${task.id}:${providerSessionId}:${idempotencyKey}`,
    },
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsMissingRawEvidence(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { timeline } = await startTimelineTask(runtime, 'missing-raw-evidence');
  expect(() => parseTaskTimelineView(({
    ...timeline,
    rawObservations: [],
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsNoncanonicalNormalizedIdentity(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'normalized-identity');
  const started = timeline.normalizedEvents.at(-1)!;
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: task.id,
    event: { ...started, id: 'syntactically-valid-arbitrary-id',
      kind: 'attempt-completed', causationId: started.id, sequence: started.sequence + 1 },
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsCrossTaskCreatedEvent(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const first = await createStartedTimelineTask(runtime, 'first');
  const second = await createStartedTimelineTask(runtime, 'second');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: first.taskId,
    event: second.normalizedEvents[0],
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsDuplicateTaskCreatedAtProtocolSeam(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'duplicate-create-protocol');
  const alternateKey = 'alternate-canonical-create';
  const duplicate = {
    ...timeline.normalizedEvents[0],
    id: `runtime-event:task-created:${task.id}:none:${alternateKey}`,
    idempotencyKey: alternateKey,
    correlationId: 'alternate-canonical-correlation',
    sequence: 2,
  };
  const normalizedEvents = [
    timeline.normalizedEvents[0]!,
    duplicate,
    ...timeline.normalizedEvents.slice(1).map((event) => ({
      ...event,
      sequence: event.sequence + 1,
    })),
  ];
  expect(() => parseTaskTimelineView(({
    ...timeline,
    normalizedEvents,
    timeline: normalizedEvents.map(timelineEntry),
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsTaskCreateOwnershipCollision(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, 'create-ownership-collision');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'TaskCreated', version: 1,
    task: { ...task, objective: 'Forged replacement objective.' },
    idempotencyKey: 'alternate-create-owner',
    correlationId: 'alternate-create-correlation',
    fingerprint: 'alternate-create-fingerprint',
  });
  await runtime.disconnect();
  await expectInvalidHistory(subject);
}

async function rejectsReplacedTaskCreatedIdentity(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Retain the durable create owner.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: 'owned-create-key',
  });
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  await runtime.disconnect();
  const bytes = fs.readFileSync(eventPath);
  fs.truncateSync(eventPath, 36 + bytes.readUInt32BE(0));
  const idempotencyKey = 'replacement-create-key';
  appendTaskEventFrame(eventPath, {
    type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: task.id,
    event: {
      schema: 'hariari.runtime.event', version: 1,
      id: `runtime-event:task-created:${task.id}:none:${idempotencyKey}`,
      taskId: task.id, runId: null, attemptId: null, providerSessionId: null,
      kind: 'task-created', correlationId: 'replacement-create-correlation',
      causationId: null, idempotencyKey, sequence: 1,
      occurrenceAt: task.createdAt, observedAt: task.createdAt,
      redaction: { status: 'allowlisted', omittedFields: [] },
    },
  });
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsInheritedNormalizedEventKind(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { task, timeline } = await startTimelineTask(runtime, 'inherited-kind');
  appendTaskEventFrame(path.join(subject.runtimeDirectory, 'tasks', 'events.log'), {
    type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: task.id,
    event: {
      schema: 'hariari.runtime.event', version: 1, id: 'independent-inherited-kind',
      taskId: task.id, runId: timeline.status.run?.id,
      attemptId: timeline.status.attempt?.id,
      providerSessionId: timeline.status.providerSession?.id, kind: 'toString',
      correlationId: 'inherited-kind-correlation',
      causationId: timeline.normalizedEvents.at(-1)?.id,
      idempotencyKey: 'inherited-kind-operation', sequence: timeline.normalizedEvents.length + 1,
      occurrenceAt: '2026-08-21T10:00:00.000Z', observedAt: '2026-08-21T10:00:00.000Z',
      redaction: { status: 'allowlisted', omittedFields: [] },
    },
  });
  await runtime.disconnect();
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsTerminalWithoutStart(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, 'terminal-without-start');
  adapter.exit(task.id, 0);
  await waitForTaskState(runtime, task.id, 'completed');
  const timeline = await runtime.getTaskTimeline(task.id);
  const providerEvent = timeline.normalizedEvents.find((event) =>
    event.kind === 'provider-session-observed')!;
  const normalizedEvents = timeline.normalizedEvents
    .filter((event) => event.kind !== 'attempt-started')
    .map((event, index) => event.kind === 'attempt-completed'
      ? { ...event, sequence: index + 1, causationId: providerEvent.id }
      : { ...event, sequence: index + 1 });
  expect(() => parseTaskTimelineView(({
    ...timeline,
    normalizedEvents,
    timeline: normalizedEvents.map(timelineEntry),
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  const durable = readTaskEvents(subject.runtimeDirectory)
    .filter((record) => (record.event as { readonly kind?: unknown } | undefined)?.kind !==
      'attempt-started')
    .map((record) => {
      const event = record.event as Record<string, unknown> | undefined;
      return event?.kind === 'attempt-completed'
        ? { ...record, event: { ...event, sequence: (event.sequence as number) - 1,
            causationId: providerEvent.id } }
        : record;
    });
  fs.truncateSync(eventPath, 0);
  for (const record of durable) appendTaskEventFrame(eventPath, record);
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
}

async function rejectsTerminalStatusMismatch(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const { task } = await startTimelineTask(runtime, 'terminal-status-mismatch');
  adapter.exit(task.id, 0);
  await waitForTaskState(runtime, task.id, 'completed');
  const timeline = await runtime.getTaskTimeline(task.id);
  const normalizedEvents = timeline.normalizedEvents.map((event) =>
    event.kind === 'attempt-completed' ? {
      ...event,
      kind: 'attempt-failed' as const,
      id: `runtime-event:attempt-failed:${task.id}:${event.attemptId}:${event.providerSessionId}`,
    } : event);
  expect(() => parseTaskTimelineView(({
    ...timeline,
    normalizedEvents,
    timeline: normalizedEvents.map(timelineEntry),
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsCrossTaskRawProtocolView(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { timeline } = await startTimelineTask(runtime, 'raw-protocol-identity');
  const providerSessionId = timeline.status.providerSession!.id;
  const idempotencyKey = 'cross-task-evidence';
  const crossTaskObservation = {
    schema: 'hariari.provider-observation' as const, version: 1 as const,
    id: `provider-observation:different-task:${providerSessionId}:${idempotencyKey}`,
    taskId: 'different-task', providerSessionId, idempotencyKey,
    provider: 'claude' as const, kind: 'provider-session-observed' as const,
    observedAt: '2026-08-21T10:00:00.000Z', evidence: { sessionState: 'active' as const },
    redaction: { status: 'allowlisted' as const, omittedFields: [] },
  };
  expect(() => parseTaskTimelineView(({
    ...timeline,
    rawObservations: [...timeline.rawObservations, crossTaskObservation],
  }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function createStartedTimelineTask(runtime: RuntimeClientSession, key: string) {
  const { task } = await startTimelineTask(runtime, key);
  return runtime.getTaskTimeline(task.id);
}

async function startTimelineTask(runtime: RuntimeClientSession, key: string) {
  const { task } = await createStartedTask(runtime, {
    objective: `Start ${key} timeline task.`, project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: `${key}-create`,
  }, `${key}-start`);
  return { task, timeline: await runtime.getTaskTimeline(task.id) };
}

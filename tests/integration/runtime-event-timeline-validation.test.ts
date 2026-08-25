import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import { timelineEntry } from '../../src/shared/runtime/event-timeline-contract';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  appendTaskEventFrame,
  createStartedTask,
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  waitForTaskState,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline validation', registerValidationTests);

function registerValidationTests(): void {
  registerRuntimeTaskTestCleanup();
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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
  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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

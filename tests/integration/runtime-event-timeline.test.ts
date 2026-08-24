import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type {
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
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
}

const PROVIDER_OBSERVATION_APPEND_BOUNDARIES = [
  { name: 'raw observation', write: 4 },
  { name: 'normalized event', write: 5 },
] as const;

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
  expect(timeline).toMatchObject({
    taskId: task.id,
    status: started,
    rawObservations: [{
      schema: 'hariari.provider-observation',
      version: 1,
      taskId: task.id,
      provider: 'claude',
      kind: 'provider-session-observed',
      observedAt: '2026-08-21T10:00:00.000Z',
      redaction: { status: 'allowlisted', omittedFields: ['nativeSessionId', 'capabilities'] },
    }],
    normalizedEvents: [{
      schema: 'hariari.runtime.event',
      version: 1,
      taskId: task.id,
      kind: 'provider-session-observed',
      idempotencyKey: 'timeline-start',
      occurrenceAt: '2026-08-21T10:00:00.000Z',
      observedAt: '2026-08-21T10:00:00.000Z',
      sequence: 1,
      redaction: { status: 'allowlisted', omittedFields: ['nativeSessionId', 'capabilities'] },
    }],
    timeline: [{
      sequence: 1,
      occurredAt: '2026-08-21T10:00:00.000Z',
      message: 'Claude provider session observed',
    }],
  });
  expect(timeline.rawObservations[0]?.id).not.toBe(timeline.normalizedEvents[0]?.id);
  expect(timeline.normalizedEvents[0]).toMatchObject({
    correlationId: timeline.rawObservations[0]?.id,
    causationId: timeline.rawObservations[0]?.id,
  });
  expect(timeline.timeline[0]?.eventId).toBe(timeline.normalizedEvents[0]?.id);
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
  expect(timeline.normalizedEvents).toHaveLength(1);
  await runtime.disconnect();

  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
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
      taskId: first.taskId, sequence: 2,
    },
  });
  await runtime.disconnect();

  await expect(subject.restart()).rejects.toBeInstanceOf(Error);
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

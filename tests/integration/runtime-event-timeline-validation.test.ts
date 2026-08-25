import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  appendTaskEventFrame,
  createStartedTask,
  createSubject,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline validation', registerValidationTests);

function registerValidationTests(): void {
  registerRuntimeTaskTestCleanup();
  it('fails closed on unsafe durable provider evidence', rejectsUnsafeProviderEvidence);
  it('fails closed on a future durable provider-evidence schema', rejectsFutureProviderEvidence);
  it('fails closed on a noncanonical raw observation identity', rejectsNoncanonicalRawIdentity);
  it('fails closed on a noncanonical normalized event identity',
    rejectsNoncanonicalNormalizedIdentity);
  it('fails closed when a canonical task-created event crosses Tasks',
    rejectsCrossTaskCreatedEvent);
  it('fails closed on an inherited-object normalized event kind',
    rejectsInheritedNormalizedEventKind);
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

async function rejectsCrossTaskRawProtocolView(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const { timeline } = await startTimelineTask(runtime, 'raw-protocol-identity');
  const crossTaskObservation = {
    schema: 'hariari.provider-observation' as const, version: 1 as const,
    id: 'independent-cross-task-observation', taskId: 'different-task',
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

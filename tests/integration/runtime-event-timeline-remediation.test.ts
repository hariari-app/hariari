import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { timelineEntry } from '../../src/shared/runtime/event-timeline-contract';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createStartedTask,
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
  type RuntimeSubject,
} from './runtime-task-test-harness';

const INVALID_TIMESTAMPS = [
  '2026-02-30T00:00:00.000Z',
  '2026-01-01Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.0000Z',
  '2026-01-01T00:00:00.000+00:00',
  '2026-01-01 00:00:00.000Z',
] as const;

describe('authenticated Runtime event timeline remediation', () => {
  registerRuntimeTaskTestCleanup();

  it.each(['resume', 'fork'] as const)(
    'rejects a forged child %s identity that replaces its accepted decision',
    rejectsForgedProviderChildIdentity,
  );
  it('validates corruption before appending a later repair', rejectsCorruptionBeforeRepair);
  it('rejects same-Task execution-context substitution on restart', rejectsSameTaskContextReuse);
  it('rejects cross-Task execution-context substitution on restart', rejectsCrossTaskContextReuse);
  it('rejects duplicate contexts and ambiguous session owners at the protocol seam',
    rejectsAmbiguousPublicContextOwnership);
  it.each(INVALID_TIMESTAMPS)('rejects noncanonical durable core time %s',
    rejectsNoncanonicalDurableTime);
  it.each(INVALID_TIMESTAMPS)('rejects noncanonical public timeline time %s',
    rejectsNoncanonicalPublicTime);
});

async function rejectsForgedProviderChildIdentity(action: 'resume' | 'fork'): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, `forged-${action}`);
  if (action === 'resume') adapter.lose(started.task.id);
  await providerAction(runtime, action, started.task.id, started.execution.providerSession!.id,
    `authoritative-${action}`);
  const records = readTaskEvents(subject.runtimeDirectory);
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, forgeChildTimeline(records, action));
  await expectInvalidHistory(subject);
}

function forgeChildTimeline(
  records: readonly Record<string, unknown>[],
  action: 'resume' | 'fork',
): readonly Record<string, unknown>[] {
  const child = records.find((record) =>
    record.type === (action === 'resume' ? 'AttemptResumed' : 'AttemptForked'))!;
  const attemptId = (child.attempt as { readonly id: string }).id;
  const context = records.filter((record) => record.type === 'ContextAllocated').at(-1)!;
  const sessionId = (context.providerSession as { readonly id: string }).id;
  const authoritativeKey = action === 'resume' ? child.actionKey : child.forkKey;
  const rawId = `provider-observation:${child.taskId}:${sessionId}:${authoritativeKey}`;
  const forgedRawId = `provider-observation:${child.taskId}:${sessionId}:forged-${action}`;
  return records.map((record) => {
    if (record === child) {
      const keyField = action === 'resume' ? 'actionKey' : 'forkKey';
      return { ...record, [keyField]: `forged-${action}`, correlationId: `forged-${action}` };
    }
    const observation = record.observation as Record<string, unknown> | undefined;
    if (record.type === 'RawProviderObservationRecorded' && observation?.id === rawId) {
      return { ...record, idempotencyKey: `forged-${action}`,
        observation: { ...observation, id: forgedRawId, idempotencyKey: `forged-${action}` } };
    }
    const event = record.event as Record<string, unknown> | undefined;
    if (record.type !== 'NormalizedRuntimeEventRecorded' || event?.attemptId !== attemptId) {
      return record;
    }
    return { ...record, event: { ...event, idempotencyKey: `forged-${action}`,
      correlationId: `forged-${action}`,
      ...(event.kind === 'provider-session-observed' ? { causationId: forgedRawId } : {}) } };
  });
}

async function rejectsCorruptionBeforeRepair(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, 'corrupt-before-repair');
  await runtime.forkProviderSession({ taskId: started.task.id,
    providerSessionId: started.execution.providerSession!.id, idempotencyKey: 'repairable-fork' });
  const prefix = forgeAttemptTimelineIdentity(
    prefixThroughLastContext(subject.runtimeDirectory),
    started.task.id,
    started.execution.attempt!.id,
    started.execution.providerSession!.id,
  );
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(prefix);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(prefix);
}

function forgeAttemptTimelineIdentity(
  records: readonly Record<string, unknown>[],
  taskId: string,
  attemptId: string,
  sessionId: string,
): readonly Record<string, unknown>[] {
  const priorKey = 'corrupt-before-repair-start';
  const rawId = `provider-observation:${taskId}:${sessionId}:${priorKey}`;
  const forgedId = `provider-observation:${taskId}:${sessionId}:corrupt-prefix`;
  return records.map((record) => {
    const observation = record.observation as Record<string, unknown> | undefined;
    if (record.type === 'RawProviderObservationRecorded' && observation?.id === rawId) {
      return { ...record, idempotencyKey: 'corrupt-prefix',
        observation: { ...observation, id: forgedId, idempotencyKey: 'corrupt-prefix' } };
    }
    const event = record.event as Record<string, unknown> | undefined;
    if (record.type !== 'NormalizedRuntimeEventRecorded' || event?.attemptId !== attemptId) {
      return record;
    }
    return { ...record, event: { ...event, idempotencyKey: 'corrupt-prefix',
      correlationId: 'corrupt-prefix',
      ...(event.kind === 'provider-session-observed' ? { causationId: forgedId } : {}) } };
  });
}

async function rejectsSameTaskContextReuse(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, 'same-task-context');
  await runtime.forkProviderSession({ taskId: started.task.id,
    providerSessionId: started.execution.providerSession!.id, idempotencyKey: 'same-task-fork' });
  const records = readTaskEvents(subject.runtimeDirectory);
  const contexts = records.filter((record) => record.type === 'ContextAllocated');
  const parentId = (contexts[0]!.context as { readonly id: string }).id;
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, substituteContext(records, contexts[1]!, parentId));
  await expectInvalidHistory(subject);
}

async function rejectsCrossTaskContextReuse(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startClaudeTask(runtime, 'cross-task-first');
  await startClaudeTask(runtime, 'cross-task-second');
  const records = readTaskEvents(subject.runtimeDirectory);
  const contexts = records.filter((record) => record.type === 'ContextAllocated');
  const firstId = (contexts[0]!.context as { readonly id: string }).id;
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, substituteContext(records, contexts[1]!, firstId));
  await expectInvalidHistory(subject);
}

function substituteContext(
  records: readonly Record<string, unknown>[],
  target: Record<string, unknown>,
  contextId: string,
): readonly Record<string, unknown>[] {
  return records.map((record) => record !== target ? record : {
    ...record,
    context: { ...(record.context as object), id: contextId },
    providerSession: { ...(record.providerSession as object), executionContextId: contextId },
  });
}

async function rejectsAmbiguousPublicContextOwnership(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, 'public-context-owner');
  const timeline = await runtime.getTaskTimeline(started.task.id);
  const context = timeline.status.executionContexts[0]!;
  const forged = { ...timeline, status: { ...timeline.status,
    executionContexts: [context, context] } };
  expect(() => parseTaskTimelineView(forged as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function rejectsNoncanonicalDurableTime(timestamp: string): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startClaudeTask(runtime, `durable-time-${timestamp}`);
  const records = readTaskEvents(subject.runtimeDirectory).map((record) => {
    if (record.type === 'AttemptStarted') return { ...record, occurredAt: timestamp };
    const event = record.event as Record<string, unknown> | undefined;
    return record.type === 'NormalizedRuntimeEventRecorded' && event?.kind === 'attempt-started'
      ? { ...record, event: { ...event, occurrenceAt: timestamp, observedAt: timestamp } }
      : record;
  });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, records);
  await expectInvalidHistory(subject);
}

async function rejectsNoncanonicalPublicTime(timestamp: string): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, `public-time-${timestamp}`);
  const timeline = await runtime.getTaskTimeline(started.task.id);
  const events = timeline.normalizedEvents.map((event) => event.kind === 'attempt-started'
    ? { ...event, occurrenceAt: timestamp, observedAt: timestamp }
    : event);
  expect(() => parseTaskTimelineView(({ ...timeline, normalizedEvents: events,
    timeline: events.map(timelineEntry) }) as unknown as Record<string, unknown>)).toThrow();
  await runtime.disconnect();
}

async function startClaudeTask(runtime: RuntimeClientSession, key: string) {
  return createStartedTask(runtime, {
    objective: `Validate ${key}.`, project: 'Hariari', repository: 'fake-local-checkout',
    baseRef: 'HEAD', provider: 'claude', idempotencyKey: `${key}-create`,
  }, `${key}-start`);
}

function providerAction(
  runtime: RuntimeClientSession,
  action: 'resume' | 'fork',
  taskId: string,
  providerSessionId: string,
  idempotencyKey: string,
) {
  const request = { taskId, providerSessionId, idempotencyKey };
  return action === 'resume'
    ? runtime.resumeProviderSession(request)
    : runtime.forkProviderSession(request);
}

function prefixThroughLastContext(runtimeDirectory: string) {
  const records = readTaskEvents(runtimeDirectory);
  let index = -1;
  for (const [candidate, record] of records.entries()) {
    if (record.type === 'ContextAllocated') index = candidate;
  }
  return records.slice(0, index + 1);
}

function expectInvalidHistory(subject: RuntimeSubject): Promise<void> {
  return expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
}

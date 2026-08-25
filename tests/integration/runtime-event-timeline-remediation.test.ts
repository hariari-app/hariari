import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import {
  parseTaskExecutionView,
  parseTaskList,
  parseTaskTimelineView,
  parseTaskView,
} from '../../src/runtime/protocol-validation';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { TaskExecutionProjection } from '../../src/runtime/task-execution-projection';
import {
  GenericCliExecutionError,
  type GenericCliStartRequest,
} from '../../src/runtime/generic-cli-execution-adapter';
import { timelineEntry } from '../../src/shared/runtime/event-timeline-contract';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';
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
  it('rejects unknown authority fields throughout the public execution status',
    rejectsUnknownPublicExecutionFields);
  it('rejects an unknown durable Run authority field on restart',
    rejectsUnknownDurableRunField);
  it.each(['run', 'attempt', 'start-key'] as const)(
    'rejects a checksum-valid cross-Task %s collision without changing durable state',
    rejectsCrossTaskExecutionIdentityCollision,
  );
  it.each(['run', 'attempt', 'start-key'] as const)(
    'validates global %s ownership before mutating the execution projection',
    validatesExecutionIdentityBeforeProjectionMutation,
  );
  it('rejects same-Task child Attempt identity reuse before projection mutation',
    rejectsSameTaskChildAttemptIdentityReuse);
  it.each(['run', 'attempt', 'start-key'] as const)(
    'rejects a checksum-valid same-Task %s collision without changing durable state',
    rejectsSameTaskExecutionIdentityCollision,
  );
  it.each(['shell', 'claude'] as const)(
    'relaunches %s after restart from durable failed-allocation evidence',
    relaunchesAfterFailedAllocationCrash,
  );
  it.each(['resume', 'fork'] as const)(
    'relaunches Claude %s after restart from durable failed-allocation evidence',
    relaunchesProviderActionAfterFailedAllocationCrash,
  );
  it.each(['shell', 'claude'] as const)(
    'repairs a successful %s launch prefix once at the advanced restart clock',
    repairsSuccessfulLaunchPrefix,
  );
  it.each(['shell', 'claude'] as const)(
    'fails closed without mutating a legacy ambiguous %s context-only prefix',
    rejectsLegacyAmbiguousContextPrefix);
});

describe('authenticated Runtime canonical timeline timestamps', () => {
  registerRuntimeTaskTestCleanup();
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

async function rejectsUnknownPublicExecutionFields(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, 'public-exact-keys');
  const status = await runtime.getTaskExecution(started.task.id);
  const timeline = await runtime.getTaskTimeline(started.task.id);
  const forgeries = publicExecutionForgeries(status as unknown as Record<string, unknown>);
  for (const forged of forgeries) {
    expect(() => parseTaskExecutionView(forged)).toThrow();
    expect(() => parseTaskTimelineView({ ...timeline, status: forged })).toThrow();
  }
  expect(() => parseTaskView({ ...started.task, futureAuthority: true })).toThrow();
  expect(() => parseTaskList({ tasks: [started.task], futureAuthority: true })).toThrow();
  const legacyStatus = status as unknown as Record<string, unknown>;
  const { executionContexts: _legacyContexts, providerSession: _legacySession,
    ...legacyOmissions } = legacyStatus;
  expect(parseTaskExecutionView(legacyOmissions)).toMatchObject({
    executionContexts: [status.context], providerSession: null,
  });
  await runtime.disconnect();
}

function publicExecutionForgeries(status: Record<string, unknown>): Record<string, unknown>[] {
  const task = status.task as Record<string, unknown>;
  const run = status.run as Record<string, unknown>;
  const attempt = status.attempt as Record<string, unknown>;
  const context = status.context as Record<string, unknown>;
  const session = status.providerSession as Record<string, unknown>;
  const capabilities = session.capabilities as Record<string, unknown>;
  return [
    { ...status, futureAuthority: true },
    { ...status, task: { ...task, futureAuthority: true } },
    { ...status, run: { ...run, futureAuthority: true } },
    { ...status, attempt: { ...attempt, futureAuthority: true } },
    { ...status, attempts: [{ ...attempt, futureAuthority: true }] },
    { ...status, context: { ...context, futureAuthority: true } },
    { ...status, executionContexts: [{ ...context, futureAuthority: true }] },
    { ...status, providerSession: { ...session, futureAuthority: true } },
    { ...status, providerSessions: [{ ...session, futureAuthority: true }] },
    { ...status, providerSession: {
      ...session, capabilities: { ...capabilities, futureAuthority: true },
    } },
  ];
}

async function rejectsUnknownDurableRunField(): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startClaudeTask(runtime, 'durable-run-exact-keys');
  const records = readTaskEvents(subject.runtimeDirectory).map((record) =>
    record.type === 'RunCreated' ? { ...record, futureAuthority: true } : record);
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, records);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(records);
}

async function rejectsCrossTaskExecutionIdentityCollision(
  identity: 'run' | 'attempt' | 'start-key',
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startClaudeTask(runtime, `cross-${identity}-first`);
  await startClaudeTask(runtime, `cross-${identity}-second`);
  const records = forgeCrossTaskExecutionIdentity(
    readTaskEvents(subject.runtimeDirectory), identity,
  );
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, records);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(records);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(records);
}

function validatesExecutionIdentityBeforeProjectionMutation(
  identity: 'run' | 'attempt' | 'start-key',
): void {
  const projection = new TaskExecutionProjection({ taskExists: () => true });
  const sharedKey = identity === 'start-key' ? 'shared-key' : 'first-key';
  projection.apply(runEvent('task-a', 'run-a', sharedKey));
  projection.apply(attemptEvent('task-a', 'attempt-a'));
  const first = projection.optional('task-a');
  const secondKey = identity === 'start-key' ? sharedKey : 'second-key';
  const secondRun = identity === 'run' ? 'run-a' : 'run-b';
  if (identity === 'attempt') projection.apply(runEvent('task-b', secondRun, secondKey));
  const collision = identity === 'attempt'
    ? attemptEvent('task-b', 'attempt-a')
    : runEvent('task-b', secondRun, secondKey);
  expect(() => projection.apply(collision)).toThrow(new TaskStorageError('internal'));
  expect(projection.optional('task-a')).toBe(first);
  expect(projection.byKey(sharedKey)).toBe(first);
  expect(projection.optional('task-b')?.attempt ?? null).toBeNull();
}

function runEvent(taskId: string, runId: string, idempotencyKey: string) {
  return { type: 'RunCreated' as const, version: 1 as const, taskId, idempotencyKey,
    correlationId: `${idempotencyKey}-correlation`, fingerprint: `${taskId}-fingerprint`,
    run: { id: runId, number: 1 } };
}

function attemptEvent(taskId: string, attemptId: string) {
  return { type: 'AttemptCreated' as const, version: 1 as const, taskId,
    attempt: { id: attemptId, number: 1, state: 'starting' as const } };
}

function rejectsSameTaskChildAttemptIdentityReuse(): void {
  const projection = new TaskExecutionProjection({ taskExists: () => true });
  const ownedContext = { id: 'context-a', worktreeId: 'worktree-a', branchName: 'branch-a',
    baseCommit: 'base-a', processId: 'process-a', ptyId: 'pty-a' };
  const ownedSession = { id: 'session-a', provider: 'claude' as const,
    nativeSessionId: 'native-a', taskId: 'task-a', attemptId: 'attempt-a',
    executionContextId: ownedContext.id, capabilities: { resume: true, fork: true },
    parentId: null, lineage: 'new' as const };
  projection.apply(runEvent('task-a', 'run-a', 'start-key'));
  projection.apply(attemptEvent('task-a', 'attempt-a'));
  projection.apply({ type: 'ContextAllocated', version: 1, taskId: 'task-a',
    context: ownedContext, providerSession: ownedSession, launchOutcome: 'succeeded',
    observedAt: '2026-08-25T10:00:00.000Z' });
  projection.apply({ type: 'AttemptStarted', version: 1, taskId: 'task-a',
    occurredAt: '2026-08-25T10:00:00.000Z' });
  projection.apply({ type: 'ProviderSessionActionDecided', version: 1, taskId: 'task-a',
    action: 'fork', providerSessionId: ownedSession.id, idempotencyKey: 'fork-key',
    correlationId: 'fork-correlation', fingerprint: 'fork-fingerprint',
    outcome: 'accepted', decision: 'fork', reason: null });
  projection.apply({ type: 'AttemptSupersessionRequested', version: 1, taskId: 'task-a',
    actionKey: 'fork-key', parentAttemptId: 'attempt-a', parentSessionId: ownedSession.id,
    reason: 'fork' });
  projection.apply({ type: 'AttemptSuperseded', version: 1, taskId: 'task-a',
    actionKey: 'fork-key', attemptId: 'attempt-a', reason: 'fork' });
  const before = projection.optional('task-a');
  expect(() => projection.apply({ type: 'AttemptForked', version: 1, taskId: 'task-a',
    attempt: { id: 'attempt-a', number: 2, state: 'starting' },
    parentAttemptId: 'attempt-a', parentSessionId: ownedSession.id,
    forkKey: 'fork-key', correlationId: 'fork-correlation',
    plannedContext: { ...ownedContext, id: 'context-b' } })).toThrow();
  expect(projection.optional('task-a')).toBe(before);
}

function forgeCrossTaskExecutionIdentity(
  records: readonly Record<string, unknown>[],
  identity: 'run' | 'attempt' | 'start-key',
): readonly Record<string, unknown>[] {
  const type = identity === 'attempt' ? 'AttemptCreated' : 'RunCreated';
  const matching = records.filter((record) => record.type === type);
  const first = matching[0]!;
  const second = matching[1]!;
  return records.map((record) => {
    if (record !== second) return record;
    if (identity === 'run') return { ...record, run: { ...(record.run as object),
      id: (first.run as { readonly id: string }).id } };
    if (identity === 'attempt') return { ...record, attempt: { ...(record.attempt as object),
      id: (first.attempt as { readonly id: string }).id } };
    return { ...record, idempotencyKey: first.idempotencyKey };
  });
}

async function rejectsSameTaskExecutionIdentityCollision(
  identity: 'run' | 'attempt' | 'start-key',
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await startClaudeTask(runtime, `same-${identity}`);
  const original = readTaskEvents(subject.runtimeDirectory);
  const source = original.find((record) =>
    record.type === (identity === 'attempt' ? 'AttemptCreated' : 'RunCreated'))!;
  const collision = identity === 'run'
    ? { ...source, idempotencyKey: 'same-task-run-collision' }
    : identity === 'attempt'
      ? { ...source, attempt: { ...(source.attempt as object), number: 2 } }
      : { ...source, run: { ...(source.run as object), id: 'same-task-key-collision-run' } };
  const records = [...original, collision];
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, records);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(records);
}

async function relaunchesAfterFailedAllocationCrash(provider: 'shell' | 'claude'): Promise<void> {
  let failFirstLaunch = true;
  const options = { startError: (request: GenericCliStartRequest) => {
    if (!failFirstLaunch) return undefined;
    failFirstLaunch = false;
    return new GenericCliExecutionError('process-start-failed', failedContext(request));
  } };
  const adapter = provider === 'claude'
    ? new FakeClaudeCodeExecutionAdapter(options)
    : new FakeGenericCliExecutionAdapter(options);
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Recover a failed allocation crash.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider,
    idempotencyKey: `${provider}-failed-allocation-create`,
  });
  const request = { taskId: task.id, idempotencyKey: `${provider}-failed-allocation-start` };
  await expect(runtime.startTask(request)).rejects.toMatchObject({ code: 'process-start-failed' });
  const prefix = prefixThroughLastContext(subject.runtimeDirectory);
  expect(prefix.at(-1)).toMatchObject({ type: 'ContextAllocated', launchOutcome: 'failed' });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.getTaskExecution(task.id)).resolves.toMatchObject({
    task: { executionState: 'starting' }, attempt: { state: 'starting' }, context: null,
  });
  const relaunched = await restarted.startTask(request);
  expect(relaunched).toMatchObject({
    task: { executionState: 'running' }, attempt: { number: 1, state: 'running' },
  });
  expect(adapter.startCount(task.id)).toBe(2);
  const events = readTaskEvents(subject.runtimeDirectory);
  expect(events.filter((event) => event.type === 'ContextAllocated')).toHaveLength(2);
  expect(events.filter((event) => event.type === 'AttemptStarted')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'AttemptFailed')).toHaveLength(0);
  await assertStableExecutionReplay(subject, task.id, relaunched, events);
  expect(adapter.startCount(task.id)).toBe(2);
}

async function relaunchesProviderActionAfterFailedAllocationCrash(
  action: 'resume' | 'fork',
): Promise<void> {
  let failChild = true;
  const adapter = new FakeClaudeCodeExecutionAdapter({
    startError: (request) => {
      if (request.attempt.number !== 2 || !failChild) return undefined;
      failChild = false;
      return new GenericCliExecutionError('process-start-failed', failedContext(request));
    },
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaudeTask(runtime, `failed-${action}-allocation`);
  if (action === 'resume') adapter.lose(started.task.id);
  const request = { taskId: started.task.id,
    providerSessionId: started.execution.providerSession!.id,
    idempotencyKey: `failed-${action}-allocation-child` };
  await expect(providerAction(runtime, action, request.taskId, request.providerSessionId,
    request.idempotencyKey)).rejects.toMatchObject({ code: 'process-start-failed' });
  const prefix = prefixThroughLastContext(subject.runtimeDirectory);
  expect(prefix.at(-1)).toMatchObject({ launchOutcome: 'failed' });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  const relaunched = await providerAction(restarted, action, request.taskId,
    request.providerSessionId, request.idempotencyKey);
  expect(relaunched).toMatchObject({ attempt: { number: 2, state: 'running' } });
  expect(adapter.startCount(started.task.id)).toBe(3);
  const events = readTaskEvents(subject.runtimeDirectory);
  expect(events.filter((event) => event.type === 'ContextAllocated')).toHaveLength(3);
  expect(events.filter((event) => event.type === 'AttemptStarted')).toHaveLength(2);
  expect(events.filter((event) => event.type === 'AttemptFailed')).toHaveLength(0);
  await assertStableExecutionReplay(subject, started.task.id, relaunched, events);
  expect(adapter.startCount(started.task.id)).toBe(3);
}

async function assertStableExecutionReplay(
  subject: RuntimeSubject,
  taskId: string,
  expected: Awaited<ReturnType<RuntimeClientSession['getTaskExecution']>>,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  await subject.restart();
  const replay = await subject.connect();
  await expect(replay.getTaskExecution(taskId)).resolves.toEqual(expected);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(events);
}

async function repairsSuccessfulLaunchPrefix(provider: 'shell' | 'claude'): Promise<void> {
  let clock = Date.parse('2026-08-25T10:00:00.000Z');
  const adapter = provider === 'claude'
    ? new FakeClaudeCodeExecutionAdapter()
    : new FakeGenericCliExecutionAdapter();
  const subject = await createSubject(() => adapter, () => clock);
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Repair proven launch evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider,
    idempotencyKey: `${provider}-successful-prefix-create`,
  });
  await runtime.startTask({ taskId: task.id,
    idempotencyKey: `${provider}-successful-prefix-start` });
  const prefix = prefixThroughLastContext(subject.runtimeDirectory);
  expect(prefix.at(-1)).toMatchObject({ launchOutcome: 'succeeded' });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  const restartedAt = '2026-08-25T11:00:00.000Z';
  clock = Date.parse(restartedAt);
  await subject.restart();
  await subject.restart();
  const restarted = await subject.connect();
  const status = await restarted.getTaskExecution(task.id);
  expect(status).toMatchObject({ attempt: { state: 'running' } });
  expect(adapter.startCount(task.id)).toBe(1);
  const events = readTaskEvents(subject.runtimeDirectory);
  expect(events.filter((event) => event.type === 'AttemptStarted')).toEqual([
    expect.objectContaining({ occurredAt: restartedAt }),
  ]);
}

async function rejectsLegacyAmbiguousContextPrefix(provider: 'shell' | 'claude'): Promise<void> {
  const subject = await createSubject(() => provider === 'claude'
    ? new FakeClaudeCodeExecutionAdapter()
    : new FakeGenericCliExecutionAdapter());
  const runtime = await subject.connect();
  const task = await runtime.createTask({
    objective: 'Reject ambiguous legacy launch evidence.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider,
    idempotencyKey: `legacy-ambiguous-${provider}-create`,
  });
  await runtime.startTask({ taskId: task.id,
    idempotencyKey: `legacy-ambiguous-${provider}-start` });
  const prefix = prefixThroughLastContext(subject.runtimeDirectory).map((record) => {
    if (record.type !== 'ContextAllocated') return record;
    const { launchOutcome: _ambiguous, ...legacy } = record;
    return legacy;
  });
  await runtime.disconnect();
  rewriteTaskEvents(subject.runtimeDirectory, prefix);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(prefix);
  await expectInvalidHistory(subject);
  expect(readTaskEvents(subject.runtimeDirectory)).toEqual(prefix);
}

function failedContext(request: GenericCliStartRequest) {
  return {
    id: request.identities.contextId,
    worktreeId: request.identities.worktreeId,
    branchName: `hariari/task-${request.task.id}/run-${request.run.number}/attempt-${request.attempt.number}`,
    baseCommit: 'fake-base-commit',
    processId: request.identities.processId,
    ptyId: request.identities.ptyId,
  };
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

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type {
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';
import {
  APPEND_DURABILITY_MODES,
  assertAuthenticatedTaskReplay,
  createStartedTask,
  createSubject,
  observeExpectedExecutionAppend,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  type ExpectedAppendBoundary,
  type RuntimeSubject,
  waitForTaskState,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline durability', registerDurabilityTests);

const TASK_CREATE_CASES = cases([
  boundary('task.create', 'core TaskCreated', 1, 'TaskCreated'),
  boundary('task.create', 'normalized task-created', 2, 'NormalizedRuntimeEventRecorded',
    'task-created'),
]);
const SHELL_START_CASES = cases([
  boundary('task.start.shell', 'RunCreated', 1, 'RunCreated'),
  boundary('task.start.shell', 'AttemptCreated', 2, 'AttemptCreated'),
  boundary('task.start.shell', 'ContextAllocated', 3, 'ContextAllocated'),
]);
const PROVIDER_START_CASES = cases([
  boundary('task.start.claude', 'RunCreated', 1, 'RunCreated'),
  boundary('task.start.claude', 'AttemptCreated', 2, 'AttemptCreated'),
  boundary('task.start.claude', 'ContextAllocated', 3, 'ContextAllocated'),
  boundary('task.start', 'raw provider observation', 4, 'RawProviderObservationRecorded'),
  boundary('task.start', 'normalized provider observation', 5, 'NormalizedRuntimeEventRecorded',
    'provider-session-observed'),
  boundary('task.start', 'core AttemptStarted', 6, 'AttemptStarted'),
  boundary('task.start', 'normalized attempt-started', 7, 'NormalizedRuntimeEventRecorded',
    'attempt-started'),
]);
const PROVIDER_ACTION_CASES = (['provider.resume', 'provider.fork'] as const).flatMap((operation) =>
  cases([
    boundary(operation, 'ProviderSessionActionDecided', 1, 'ProviderSessionActionDecided'),
    boundary(operation, 'AttemptSupersessionRequested', 2, 'AttemptSupersessionRequested'),
    boundary(operation, 'AttemptSuperseded', 3, 'AttemptSuperseded'),
    boundary(operation, operation === 'provider.resume' ? 'AttemptResumed' : 'AttemptForked',
      4, operation === 'provider.resume' ? 'AttemptResumed' : 'AttemptForked'),
    boundary(operation, 'ContextAllocated', 5, 'ContextAllocated'),
    boundary(operation, 'raw provider observation', 6, 'RawProviderObservationRecorded'),
    boundary(operation, 'normalized provider observation', 7,
      'NormalizedRuntimeEventRecorded', 'provider-session-observed'),
    boundary(operation, 'core AttemptStarted', 8, 'AttemptStarted'),
    boundary(operation, 'normalized attempt-started', 9,
      'NormalizedRuntimeEventRecorded', 'attempt-started'),
  ]));
const TERMINAL_CASES = cases([
  terminalBoundary('completed', 'core AttemptCompleted', 1, 'AttemptCompleted'),
  terminalBoundary('completed', 'normalized attempt-completed', 2,
    'NormalizedRuntimeEventRecorded', 'attempt-completed'),
  terminalBoundary('failed', 'core AttemptFailed', 1, 'AttemptFailed'),
  terminalBoundary('failed', 'normalized attempt-failed', 2,
    'NormalizedRuntimeEventRecorded', 'attempt-failed'),
  terminalBoundary('cancelled', 'CancellationRequested', 1, 'CancellationRequested'),
  terminalBoundary('cancelled', 'normalized cancellation-requested', 2,
    'NormalizedRuntimeEventRecorded', 'cancellation-requested'),
  terminalBoundary('cancelled', 'core AttemptCancelled', 3, 'AttemptCancelled'),
  terminalBoundary('cancelled', 'normalized attempt-cancelled', 4,
    'NormalizedRuntimeEventRecorded', 'attempt-cancelled'),
]);

function registerDurabilityTests(): void {
  registerRuntimeTaskTestCleanup();
  it.each(TASK_CREATE_CASES)(
    'repairs $operation $name $mode with one effect and equivalent replay',
    verifiesTaskCreateBoundary,
  );
  it.each(PROVIDER_START_CASES)(
    'repairs $operation $name $mode with one effect and equivalent replay',
    verifiesProviderStartBoundary,
  );
  it.each(SHELL_START_CASES)(
    'repairs $operation $name $mode with one effect and equivalent replay',
    verifiesShellStartBoundary,
  );
  it.each(PROVIDER_ACTION_CASES)(
    'repairs $operation $name $mode with one effect and equivalent replay',
    verifiesProviderActionBoundary,
  );
  it.each(TERMINAL_CASES)(
    'repairs task.$state $name $mode with one effect and equivalent replay',
    verifiesTerminalBoundary,
  );
}

async function verifiesShellStartBoundary(fault: ShellStartCase): Promise<void> {
  const correlation = `shell-start-${fault.name}-${fault.mode}-correlation`;
  const adapter = new FakeGenericCliExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, correlation, correlation,
  ]);
  const createKey = `${fault.name}-${fault.mode}-create`;
  const startKey = `${fault.name}-${fault.mode}-start`;
  const task = await runtime.createTask({ ...taskRequest(createKey),
    provider: 'shell' });
  const request = { taskId: task.id, idempotencyKey: startKey };
  const observed = exerciseFault(subject, fault);
  const startFailed = fault.mode !== 'complete' && fault.eventType === 'ContextAllocated';
  if (fault.mode !== 'complete') {
    await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
  }
  const result = await runtime.startTask(request);
  await expect(runtime.startTask(request)).resolves.toEqual(result);
  observed.assertObserved();
  expect(result).toMatchObject({ task: { executionState: startFailed ? 'failed' : 'running' },
    run: { number: 1 }, attempt: { number: 1, state: startFailed ? 'failed' : 'running' } });
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(startFailed ? 1 : 0);
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.normalizedEvents.map(eventIdentity)).toEqual([
    ['task-created', `${correlation}-create`, createKey],
    ['attempt-started', correlation, startKey],
    ...(startFailed ? [['attempt-failed', correlation, startKey]] : []),
  ]);
  await assertAuthenticatedTaskReplay(subject, runtime, task, result, timeline);
}

async function verifiesTaskCreateBoundary(fault: TaskCreateCase): Promise<void> {
  const correlation = `task-create-${fault.name}-${fault.mode}-correlation`;
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connectWithCorrelations([correlation, correlation, correlation]);
  const request = taskRequest(`task-create-${fault.name}-${fault.mode}`);
  const observed = exerciseFault(subject, fault);
  let task: TaskView;
  if (fault.mode === 'complete') {
    task = await runtime.createTask(request);
  } else {
    await expect(runtime.createTask(request)).rejects
      .toEqual(new RuntimePortError('internal', true));
    task = await runtime.createTask(request);
  }
  await expect(runtime.createTask(request)).resolves.toEqual(task);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(await runtime.listTasks()).toEqual([task]);
  expect(timeline.normalizedEvents.map(eventIdentity)).toEqual([
    ['task-created', correlation, request.idempotencyKey],
  ]);
  expect(eventCount(subject, 'TaskCreated')).toBe(1);
  expect(normalizedCount(subject, 'task-created')).toBe(1);
  await assertAuthenticatedTaskReplay(subject, runtime, task, timeline.status, timeline);
}

async function verifiesProviderStartBoundary(fault: ProviderStartCase): Promise<void> {
  const correlation = `provider-start-${fault.name}-${fault.mode}-correlation`;
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, correlation, correlation,
  ]);
  const task = await runtime.createTask(taskRequest(`${fault.name}-${fault.mode}-create`));
  const request = { taskId: task.id, idempotencyKey: `${fault.name}-${fault.mode}-start` };
  const observed = exerciseFault(subject, fault);
  const failedStart = fault.mode !== 'complete' &&
    (fault.eventType === 'ContextAllocated' || fault.eventType === 'AttemptStarted');
  const reservationRejects = fault.mode !== 'complete' && fault.writeCall < 3;
  let result: TaskExecutionView;
  if (failedStart || reservationRejects) {
    await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    result = await runtime.startTask(request);
  } else {
    result = await runtime.startTask(request);
  }
  await expect(runtime.startTask(request)).resolves.toEqual(result);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  const expectedKinds = failedStart
    ? fault.eventType === 'ContextAllocated'
      ? ['task-created', 'attempt-started', 'attempt-failed']
      : ['task-created', 'provider-session-observed', 'attempt-started', 'attempt-failed']
    : ['task-created', 'provider-session-observed', 'attempt-started'];
  expect(timeline.normalizedEvents.map((event) => event.kind)).toEqual(expectedKinds);
  expect(timeline.normalizedEvents.at(-1)).toMatchObject({
    kind: failedStart ? 'attempt-failed' : 'attempt-started',
    correlationId: correlation, idempotencyKey: request.idempotencyKey,
  });
  const contextFailed = failedStart && fault.eventType === 'ContextAllocated';
  expect(timeline.rawObservations).toHaveLength(contextFailed ? 0 : 1);
  expect(eventCount(subject, 'AttemptStarted')).toBe(failedStart ? 0 : 1);
  expect(normalizedCount(subject, 'provider-session-observed')).toBe(contextFailed ? 0 : 1);
  expect(normalizedCount(subject, failedStart ? 'attempt-failed' : 'attempt-started')).toBe(1);
  expect(adapter.startCount(task.id)).toBe(1);
  expect(adapter.stopCount(task.id)).toBe(failedStart ? 1 : 0);
  await assertAuthenticatedTaskReplay(subject, runtime, task, result, timeline);
}

async function verifiesProviderActionBoundary(fault: ProviderActionCase): Promise<void> {
  const correlation = `${fault.operation}-${fault.name}-${fault.mode}-correlation`;
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, `${correlation}-start`, correlation, correlation,
  ]);
  const { task, started } = await startTimelineTask(runtime, `${fault.name}-${fault.mode}`);
  if (fault.operation === 'provider.resume') adapter.lose(task.id);
  const request = { taskId: task.id, providerSessionId: started.providerSession!.id,
    idempotencyKey: `${fault.operation}-${fault.name}-${fault.mode}` };
  const observed = exerciseFault(subject, fault);
  const failedCoreStart = fault.eventType === 'AttemptStarted' && fault.mode !== 'complete';
  const firstCallRejects = fault.mode !== 'complete' &&
    (failedCoreStart || fault.writeCall <= 4) &&
    !(fault.operation === 'provider.fork' && fault.eventType === 'AttemptSuperseded');
  const result = await runProviderAction(runtime, fault.operation, request, firstCallRejects);
  await expect(callProviderAction(runtime, fault.operation, request)).resolves.toEqual(result);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.rawObservations).toHaveLength(2);
  expect(timeline.normalizedEvents).toHaveLength(failedCoreStart ? 6 : 5);
  const expectedTail = [
    ['provider-session-observed', correlation, request.idempotencyKey],
    ['attempt-started', correlation, request.idempotencyKey],
    ...(failedCoreStart
      ? [['attempt-failed', correlation, request.idempotencyKey]]
      : []),
  ];
  expect(timeline.normalizedEvents.slice(-expectedTail.length).map(eventIdentity))
    .toEqual(expectedTail);
  expect(eventCount(subject, 'AttemptStarted')).toBe(failedCoreStart ? 1 : 2);
  expect(result).toMatchObject({
    attempt: { number: 2, state: failedCoreStart ? 'failed' : 'running' },
    providerSession: { parentId: started.providerSession!.id,
      lineage: fault.operation === 'provider.resume' ? 'native-resume' : 'fork' },
  });
  expect(adapter.startCount(task.id)).toBe(2);
  expect(adapter.stopCount(task.id)).toBe(
    fault.operation === 'provider.fork' ? (failedCoreStart ? 2 : 1) : (failedCoreStart ? 1 : 0),
  );
  await assertAuthenticatedTaskReplay(subject, runtime, task, result, timeline);
}

async function verifiesTerminalBoundary(fault: TerminalCase): Promise<void> {
  const key = `terminal-${fault.state}-${fault.name}-${fault.mode}`;
  const correlation = `${key}-correlation`;
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, `${correlation}-start`, correlation, correlation, correlation,
  ]);
  const { task } = await startTimelineTask(runtime, key);
  const observed = exerciseFault(subject, fault);
  await settleTerminal(runtime, adapter, task.id, fault, key);
  observed.assertObserved();
  const status = await runtime.getTaskExecution(task.id);
  const timeline = await runtime.getTaskTimeline(task.id);
  const expectedKey = fault.state === 'cancelled' ? `${key}-cancel` : `${key}-start`;
  const expectedCorrelation = fault.state === 'cancelled' ? correlation : `${correlation}-start`;
  expect(timeline.normalizedEvents.at(-1)).toMatchObject({
    kind: `attempt-${fault.state}`, correlationId: expectedCorrelation,
    idempotencyKey: expectedKey,
  });
  expect(timeline.normalizedEvents.filter((event) => event.kind === `attempt-${fault.state}`))
    .toHaveLength(1);
  expect(eventCount(subject, terminalEventType(fault.state))).toBe(1);
  if (fault.state === 'cancelled') {
    expect(eventCount(subject, 'CancellationRequested')).toBe(1);
  }
  await assertAuthenticatedTaskReplay(subject, runtime, task, status, timeline);
}

async function runProviderAction(
  runtime: RuntimeClientSession,
  operation: ProviderActionCase['operation'],
  request: ProviderRequest,
  rejects: boolean,
): Promise<TaskExecutionView> {
  if (rejects) {
    await expect(callProviderAction(runtime, operation, request))
      .rejects.toEqual(new RuntimePortError('internal', true));
  }
  return callProviderAction(runtime, operation, request);
}

function callProviderAction(
  runtime: RuntimeClientSession,
  operation: ProviderActionCase['operation'],
  request: ProviderRequest,
): Promise<TaskExecutionView> {
  return operation === 'provider.resume'
    ? runtime.resumeProviderSession(request)
    : runtime.forkProviderSession(request);
}

async function settleTerminal(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
  taskId: string,
  fault: TerminalCase,
  key: string,
): Promise<void> {
  if (fault.state === 'cancelled') {
    const request = { taskId, idempotencyKey: `${key}-cancel` };
    if ((fault.eventType === 'CancellationRequested' ||
      fault.normalizedKind === 'cancellation-requested') && fault.mode !== 'complete') {
      await expect(runtime.cancelTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    }
    await runtime.cancelTask(request);
    await runtime.cancelTask(request);
  } else {
    adapter.exit(taskId, fault.state === 'completed' ? 0 : 1);
  }
  await waitForTaskState(runtime, taskId, fault.state);
  await runtime.startTask({ taskId, idempotencyKey: `${key}-start` });
}

async function startTimelineTask(
  runtime: RuntimeClientSession,
  key: string,
): Promise<{ readonly task: TaskView; readonly started: TaskExecutionView }> {
  const { task, execution } = await createStartedTask(
    runtime, taskRequest(`${key}-create`), `${key}-start`,
  );
  return { task, started: execution };
}

function exerciseFault(subject: RuntimeSubject, fault: DurabilityCase) {
  return observeExpectedExecutionAppend(
    path.join(subject.runtimeDirectory, 'tasks', 'events.log'),
    fault,
    fault.mode,
  );
}

function eventCount(subject: RuntimeSubject, type: string): number {
  return readTaskEvents(subject.runtimeDirectory).filter((event) => event.type === type).length;
}

function normalizedCount(subject: RuntimeSubject, kind: string): number {
  return readTaskEvents(subject.runtimeDirectory).filter((record) => {
    const event = record.event as { readonly kind?: unknown } | undefined;
    return record.type === 'NormalizedRuntimeEventRecorded' && event?.kind === kind;
  }).length;
}

function eventIdentity(event: TaskTimelineView['normalizedEvents'][number]) {
  return [event.kind, event.correlationId, event.idempotencyKey];
}

function terminalEventType(state: TerminalCase['state']): string {
  if (state === 'completed') {
    return 'AttemptCompleted';
  }
  if (state === 'failed') {
    return 'AttemptFailed';
  }
  return 'AttemptCancelled';
}

function taskRequest(idempotencyKey: string) {
  return {
    objective: 'Verify one named append boundary.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude' as const,
    idempotencyKey,
  };
}

function boundary(
  operation: string,
  name: string,
  writeCall: number,
  eventType: string,
  normalizedKind?: string,
): ExpectedAppendBoundary & { readonly name: string } {
  return { operation, name, writeCall, eventType, normalizedKind };
}

function terminalBoundary(
  state: 'completed' | 'failed' | 'cancelled',
  name: string,
  writeCall: number,
  eventType: string,
  normalizedKind?: string,
) {
  return { ...boundary(`task.${state}`, name, writeCall, eventType, normalizedKind), state };
}

function cases<T extends ExpectedAppendBoundary>(boundaries: readonly T[]) {
  return boundaries.flatMap((item) => APPEND_DURABILITY_MODES.map((mode) => ({ ...item, mode })));
}

type TaskCreateCase = (typeof TASK_CREATE_CASES)[number];
type ShellStartCase = (typeof SHELL_START_CASES)[number];
type ProviderStartCase = (typeof PROVIDER_START_CASES)[number];
type ProviderActionCase = (typeof PROVIDER_ACTION_CASES)[number];
type TerminalCase = (typeof TERMINAL_CASES)[number];
type DurabilityCase = TaskCreateCase | ProviderStartCase | ProviderActionCase | TerminalCase;
type ProviderRequest = {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
};

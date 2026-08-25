import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError, type RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type {
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  APPEND_DURABILITY_MODES,
  createSubject,
  exerciseExpectedExecutionAppend,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  type ExpectedAppendBoundary,
  type RuntimeSubject,
} from './runtime-task-test-harness';

describe('authenticated Runtime event timeline durability', registerDurabilityTests);

const TASK_CREATE_CASES = cases([
  boundary('task.create', 'core TaskCreated', 1, 'TaskCreated'),
  boundary('task.create', 'normalized task-created', 2, 'NormalizedRuntimeEventRecorded',
    'task-created'),
]);
const PROVIDER_START_CASES = cases([
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
  terminalBoundary('cancelled', 'core AttemptCancelled', 2, 'AttemptCancelled'),
  terminalBoundary('cancelled', 'normalized attempt-cancelled', 3,
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
  it.each(PROVIDER_ACTION_CASES)(
    'repairs $operation $name $mode with one effect and equivalent replay',
    verifiesProviderActionBoundary,
  );
  it.each(TERMINAL_CASES)(
    'repairs task.$state $name $mode with one effect and equivalent replay',
    verifiesTerminalBoundary,
  );
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
  await assertReplay(subject, runtime, task, timeline.status, timeline);
}

async function verifiesProviderStartBoundary(fault: ProviderStartCase): Promise<void> {
  const correlation = `provider-start-${fault.name}-${fault.mode}-correlation`;
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connectWithCorrelations([
    `${correlation}-create`, correlation, correlation,
  ]);
  const task = await runtime.createTask(taskRequest(`${fault.name}-${fault.mode}-create`));
  const request = { taskId: task.id, idempotencyKey: `${fault.name}-${fault.mode}-start` };
  const observed = exerciseFault(subject, fault);
  const failedCoreStart = fault.eventType === 'AttemptStarted' && fault.mode !== 'complete';
  let result: TaskExecutionView;
  if (failedCoreStart) {
    await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    result = await runtime.startTask(request);
  } else {
    result = await runtime.startTask(request);
  }
  await expect(runtime.startTask(request)).resolves.toEqual(result);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  const expectedKinds = failedCoreStart
    ? ['task-created', 'provider-session-observed', 'attempt-failed']
    : ['task-created', 'provider-session-observed', 'attempt-started'];
  expect(timeline.normalizedEvents.map((event) => event.kind)).toEqual(expectedKinds);
  expect(timeline.normalizedEvents.slice(-2).map(eventIdentity)).toEqual([
    ['provider-session-observed', correlation, request.idempotencyKey],
    [failedCoreStart ? 'attempt-failed' : 'attempt-started', correlation, request.idempotencyKey],
  ]);
  expect(timeline.rawObservations).toHaveLength(1);
  expect(eventCount(subject, 'AttemptStarted')).toBe(failedCoreStart ? 0 : 1);
  expect(normalizedCount(subject, 'provider-session-observed')).toBe(1);
  expect(normalizedCount(subject, failedCoreStart ? 'attempt-failed' : 'attempt-started')).toBe(1);
  await assertReplay(subject, runtime, task, result, timeline);
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
    (failedCoreStart || fault.eventType === 'ProviderSessionActionDecided');
  const result = await runProviderAction(runtime, fault.operation, request, firstCallRejects);
  await expect(callProviderAction(runtime, fault.operation, request)).resolves.toEqual(result);
  observed.assertObserved();
  const timeline = await runtime.getTaskTimeline(task.id);
  expect(timeline.rawObservations).toHaveLength(2);
  expect(timeline.normalizedEvents).toHaveLength(5);
  expect(timeline.normalizedEvents.slice(-2).map(eventIdentity)).toEqual([
    ['provider-session-observed', correlation, request.idempotencyKey],
    [failedCoreStart ? 'attempt-failed' : 'attempt-started', correlation, request.idempotencyKey],
  ]);
  expect(eventCount(subject, 'AttemptStarted')).toBe(failedCoreStart ? 1 : 2);
  await assertReplay(subject, runtime, task, result, timeline);
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
  await assertReplay(subject, runtime, task, status, timeline);
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
    if (fault.eventType === 'CancellationRequested' && fault.mode !== 'complete') {
      await expect(runtime.cancelTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    }
    await runtime.cancelTask(request);
    await runtime.cancelTask(request);
  } else {
    adapter.exit(taskId, fault.state === 'completed' ? 0 : 1);
  }
  await waitForTerminal(runtime, taskId, fault.state);
  await runtime.startTask({ taskId, idempotencyKey: `${key}-start` });
}

async function waitForTerminal(
  runtime: RuntimeClientSession,
  taskId: string,
  expected: TerminalCase['state'],
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

async function assertReplay(
  subject: RuntimeSubject,
  runtime: RuntimeClientSession,
  task: TaskView,
  status: TaskExecutionView,
  timeline: TaskTimelineView,
): Promise<void> {
  const tasks = await runtime.listTasks();
  await runtime.disconnect();
  fs.rmSync(path.join(subject.runtimeDirectory, 'tasks', 'projection.json'));
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.listTasks()).resolves.toEqual(tasks);
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(status);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
}

async function startTimelineTask(
  runtime: RuntimeClientSession,
  key: string,
): Promise<{ readonly task: TaskView; readonly started: TaskExecutionView }> {
  const task = await runtime.createTask(taskRequest(`${key}-create`));
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: `${key}-start` });
  return { task, started };
}

function exerciseFault(subject: RuntimeSubject, fault: DurabilityCase) {
  return exerciseExpectedExecutionAppend(
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
type ProviderStartCase = (typeof PROVIDER_START_CASES)[number];
type ProviderActionCase = (typeof PROVIDER_ACTION_CASES)[number];
type TerminalCase = (typeof TERMINAL_CASES)[number];
type DurabilityCase = TaskCreateCase | ProviderStartCase | ProviderActionCase | TerminalCase;
type ProviderRequest = {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
};

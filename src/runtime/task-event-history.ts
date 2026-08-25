import {
  allowlistProviderObservation,
  normalizedEvent,
} from '../shared/runtime/event-timeline-contract';
import type { NormalizedRuntimeEventView } from '../shared/runtime/runtime-interface';
import type {
  CancellationRequestedEvent,
  ContextAllocatedEvent,
  RawProviderObservationRecordedEvent,
  StoredProviderSession,
  TaskCreatedEvent,
  TaskEvent,
} from './task-events';

type RepairableEvent = Extract<TaskEvent, {
  type: 'RawProviderObservationRecorded' | 'NormalizedRuntimeEventRecorded' | 'AttemptStarted';
}>;

interface OperationIdentity {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

interface AttemptHistory {
  readonly id: string;
  readonly operation: OperationIdentity;
  context: ContextAllocatedEvent | null;
  observation: RawProviderObservationRecordedEvent | null;
  started: boolean;
  cancellation: CancellationRequestedEvent | null;
  terminal: 'completed' | 'failed' | 'cancelled' | null;
}

interface TaskHistoryAnalysis {
  readonly task: TaskCreatedEvent;
  readonly attempts: readonly AttemptHistory[];
  readonly normalized: readonly NormalizedRuntimeEventView[];
}

interface NormalizedDescriptor {
  readonly kind: NormalizedRuntimeEventView['kind'];
  readonly attempt: AttemptHistory | null;
  readonly operation: OperationIdentity;
  readonly providerSession: StoredProviderSession | null;
  readonly occurrenceAt: string | null;
  readonly observation: RawProviderObservationRecordedEvent | null;
}

export class TaskEventHistoryError extends Error {
  constructor(detail = 'invalid durable Task event history') {
    super(detail);
    this.name = 'TaskEventHistoryError';
  }
}

/** Analyzes durable Task histories and emits one canonical crash-repair step at a time. */
export class TaskEventHistory {
  private readonly records = new Set<string>();
  private readonly events: TaskEvent[] = [];

  accept(event: TaskEvent, currentAttemptId: string | null = null): void {
    const record = JSON.stringify([event, isAttemptScopedPhase(event) ? currentAttemptId : null]);
    if (this.records.has(record)) {
      throw new TaskEventHistoryError('duplicate durable Task event');
    }
    this.records.add(record);
    this.events.push(event);
  }

  nextRepair(taskId: string, now: string): RepairableEvent | null {
    const analysis = this.analyze(taskId);
    const missingObservation = analysis.attempts.find((attempt) =>
      attempt.context?.providerSession && !attempt.observation);
    if (missingObservation) {
      if (analysis.normalized.some((event) => event.attemptId === missingObservation.id)) {
        throw new TaskEventHistoryError('provider observation missing before later evidence');
      }
      return recoveredObservation(missingObservation, now);
    }

    const descriptors = normalizedDescriptors(analysis);
    assertNormalizedPrefix(analysis.normalized, descriptors);
    if (analysis.normalized.length < descriptors.length) {
      return {
        type: 'NormalizedRuntimeEventRecorded',
        version: 1,
        taskId,
        event: materializeDescriptor(
          taskId,
          descriptors[analysis.normalized.length]!,
          analysis.normalized,
          now,
        ),
      };
    }

    const unstatedStart = analysis.attempts.find((attempt) =>
      attempt.context && !attempt.started && !hasNormalizedStart(analysis, attempt));
    if (unstatedStart) {
      if (unstatedStart.cancellation || unstatedStart.terminal) throw new TaskEventHistoryError();
      return { type: 'AttemptStarted', version: 1, taskId };
    }
    return null;
  }

  assertComplete(taskId: string): void {
    const analysis = this.analyze(taskId);
    const incomplete = analysis.attempts.find((attempt) =>
      (attempt.context?.providerSession && !attempt.observation) ||
      (attempt.context && !attempt.started && !hasNormalizedStart(analysis, attempt)));
    if (incomplete) throw new TaskEventHistoryError(
      `incomplete attempt ${incomplete.id}: context=${Boolean(incomplete.context)} ` +
      `observation=${Boolean(incomplete.observation)} started=${incomplete.started}`,
    );
    const descriptors = normalizedDescriptors(analysis);
    assertNormalizedPrefix(analysis.normalized, descriptors);
    if (analysis.normalized.length !== descriptors.length) throw new TaskEventHistoryError(
      `incomplete normalized history: ${analysis.normalized.length}/${descriptors.length}`,
    );
  }

  private analyze(taskId: string): TaskHistoryAnalysis {
    const taskEvents = this.events.filter((event) => eventTaskId(event) === taskId);
    const task = taskEvents.find((event): event is TaskCreatedEvent => event.type === 'TaskCreated');
    if (!task) throw new TaskEventHistoryError();
    const attempts: AttemptHistory[] = [];
    const attemptsById = new Map<string, AttemptHistory>();
    const sessions = new Map<string, AttemptHistory>();
    const normalized: NormalizedRuntimeEventView[] = [];
    let operation: OperationIdentity | null = null;
    let current: AttemptHistory | null = null;

    for (const event of taskEvents) {
      if (event.type === 'RunCreated') {
        operation = operationIdentity(event.run.id, event.idempotencyKey, event.correlationId);
      } else if (event.type === 'AttemptCreated') {
        current = addAttempt(event.attempt.id, operation, attempts, attemptsById);
      } else if (event.type === 'AttemptResumed') {
        operation = operationIdentity(requiredRun(operation), event.actionKey, event.correlationId);
        current = addAttempt(event.attempt.id, operation, attempts, attemptsById);
      } else if (event.type === 'AttemptForked') {
        operation = operationIdentity(requiredRun(operation), event.forkKey, event.correlationId);
        current = addAttempt(event.attempt.id, operation, attempts, attemptsById);
      } else if (event.type === 'ContextAllocated') {
        current = requiredAttempt(current);
        current.context = event;
        if (event.providerSession) sessions.set(event.providerSession.id, current);
      } else if (event.type === 'RawProviderObservationRecorded') {
        const owner = sessions.get(event.providerSessionId) ?? requiredAttempt(current);
        if (owner.observation) throw new TaskEventHistoryError();
        owner.observation = event;
      } else if (event.type === 'AttemptStarted') {
        current = requiredAttempt(current);
        current.started = true;
      } else if (event.type === 'CancellationRequested') {
        current = requiredAttempt(current);
        current.cancellation = event;
      } else if (event.type === 'AttemptCompleted') {
        requiredAttempt(current).terminal = 'completed';
      } else if (event.type === 'AttemptFailed') {
        requiredAttempt(current).terminal = 'failed';
      } else if (event.type === 'AttemptCancelled') {
        requiredAttempt(current).terminal = 'cancelled';
      } else if (event.type === 'NormalizedRuntimeEventRecorded') {
        normalized.push(event.event);
      }
    }
    return { task, attempts, normalized };
  }
}

function addAttempt(
  id: string,
  operation: OperationIdentity | null,
  attempts: AttemptHistory[],
  attemptsById: Map<string, AttemptHistory>,
): AttemptHistory {
  if (!operation || attemptsById.has(id)) throw new TaskEventHistoryError();
  const attempt: AttemptHistory = {
    id,
    operation,
    context: null,
    observation: null,
    started: false,
    cancellation: null,
    terminal: null,
  };
  attempts.push(attempt);
  attemptsById.set(id, attempt);
  return attempt;
}

function normalizedDescriptors(analysis: TaskHistoryAnalysis): readonly NormalizedDescriptor[] {
  const create = analysis.task;
  const descriptors: NormalizedDescriptor[] = [{
    kind: 'task-created',
    attempt: null,
    operation: operationIdentity('', create.idempotencyKey, create.correlationId),
    providerSession: null,
    occurrenceAt: create.task.createdAt,
    observation: null,
  }];
  for (const attempt of analysis.attempts) {
    const session = attempt.context?.providerSession ?? null;
    if (attempt.observation) descriptors.push({
      kind: 'provider-session-observed', attempt, operation: attempt.operation,
      providerSession: session, occurrenceAt: attempt.observation.observation.observedAt,
      observation: attempt.observation,
    });
    if (attempt.started || hasNormalizedStart(analysis, attempt)) descriptors.push({
      kind: 'attempt-started', attempt, operation: attempt.operation,
      providerSession: session, occurrenceAt: null, observation: null,
    });
    if (attempt.cancellation) descriptors.push({
      kind: 'cancellation-requested', attempt,
      operation: operationIdentity(
        attempt.operation.runId,
        attempt.cancellation.idempotencyKey,
        attempt.cancellation.correlationId,
      ),
      providerSession: session, occurrenceAt: null, observation: null,
    });
    if (attempt.terminal) {
      const terminalOperation = attempt.terminal === 'cancelled' && attempt.cancellation
        ? operationIdentity(
            attempt.operation.runId,
            attempt.cancellation.idempotencyKey,
            attempt.cancellation.correlationId,
          )
        : attempt.operation;
      descriptors.push({
        kind: `attempt-${attempt.terminal}`,
        attempt,
        operation: terminalOperation,
        providerSession: session,
        occurrenceAt: null,
        observation: null,
      });
    }
  }
  return descriptors;
}

function hasNormalizedStart(
  analysis: TaskHistoryAnalysis,
  attempt: AttemptHistory,
): boolean {
  return analysis.normalized.some((event) =>
    event.attemptId === attempt.id && event.kind === 'attempt-started');
}

function assertNormalizedPrefix(
  actual: readonly NormalizedRuntimeEventView[],
  expected: readonly NormalizedDescriptor[],
): void {
  if (actual.length > expected.length) throw new TaskEventHistoryError();
  for (const [index, event] of actual.entries()) {
    const descriptor = expected[index];
    const expectedAttemptId = descriptor?.attempt?.id ?? null;
    if (!descriptor || event.kind !== descriptor.kind ||
      event.attemptId !== expectedAttemptId ||
      event.runId !== (descriptor.attempt ? descriptor.operation.runId : null) ||
      event.providerSessionId !== (descriptor.providerSession?.id ?? null) ||
      event.idempotencyKey !== descriptor.operation.idempotencyKey ||
      event.correlationId !== descriptor.operation.correlationId) {
      throw new TaskEventHistoryError(
        `normalized history mismatch at ${index}: ${event.kind}/${event.attemptId ?? 'none'} ` +
        `does not match ${descriptor?.kind ?? 'none'}/${expectedAttemptId ?? 'none'}`,
      );
    }
  }
}

function materializeDescriptor(
  taskId: string,
  descriptor: NormalizedDescriptor,
  prior: readonly NormalizedRuntimeEventView[],
  now: string,
): NormalizedRuntimeEventView {
  const occurrenceAt = descriptor.occurrenceAt ?? now;
  return normalizedEvent({
    taskId,
    runId: descriptor.attempt ? descriptor.operation.runId : null,
    attemptId: descriptor.attempt?.id ?? null,
    providerSessionId: descriptor.providerSession?.id ?? null,
    kind: descriptor.kind,
    idempotencyKey: descriptor.operation.idempotencyKey,
    correlationId: descriptor.operation.correlationId,
    sequence: prior.length + 1,
    occurrenceAt,
    observedAt: occurrenceAt,
    causationId: causationFor(descriptor, prior),
    ...(descriptor.observation
      ? { redaction: descriptor.observation.observation.redaction }
      : {}),
  });
}

function causationFor(
  descriptor: NormalizedDescriptor,
  prior: readonly NormalizedRuntimeEventView[],
): string | null {
  if (descriptor.kind === 'task-created') return null;
  if (descriptor.kind === 'provider-session-observed') {
    return descriptor.observation?.observation.id ?? null;
  }
  if (descriptor.kind === 'attempt-started') {
    return [...prior].reverse().find((event) =>
      event.attemptId === descriptor.attempt?.id &&
      event.kind === 'provider-session-observed')?.id ?? prior[0]?.id ?? null;
  }
  if (descriptor.kind === 'attempt-cancelled') {
    return [...prior].reverse().find((event) =>
      event.attemptId === descriptor.attempt?.id &&
      event.kind === 'cancellation-requested')?.id ?? null;
  }
  return [...prior].reverse().find((event) =>
    event.attemptId === descriptor.attempt?.id && event.kind === 'attempt-started')?.id ?? null;
}

function recoveredObservation(attempt: AttemptHistory, now: string): RepairableEvent {
  const session = attempt.context?.providerSession;
  if (!session) throw new TaskEventHistoryError();
  const observation = allowlistProviderObservation({
    taskId: session.taskId,
    providerSessionId: session.id,
    idempotencyKey: attempt.operation.idempotencyKey,
    observedAt: now,
    evidence: {
      provider: session.provider,
      kind: 'provider-session-observed',
      sessionState: 'active',
      nativeSessionId: session.nativeSessionId,
      capabilities: session.capabilities,
    },
  });
  return {
    type: 'RawProviderObservationRecorded',
    version: 1,
    taskId: session.taskId,
    providerSessionId: session.id,
    idempotencyKey: attempt.operation.idempotencyKey,
    observation,
  };
}

function operationIdentity(
  runId: string,
  idempotencyKey: string,
  correlationId: string,
): OperationIdentity {
  return { runId, idempotencyKey, correlationId };
}

function requiredRun(operation: OperationIdentity | null): string {
  if (!operation) throw new TaskEventHistoryError();
  return operation.runId;
}

function requiredAttempt(attempt: AttemptHistory | null): AttemptHistory {
  if (!attempt) throw new TaskEventHistoryError();
  return attempt;
}

function eventTaskId(event: TaskEvent): string {
  return event.type === 'TaskCreated' ? event.task.id : event.taskId;
}

function isAttemptScopedPhase(event: TaskEvent): boolean {
  return event.type === 'AttemptStarted' || event.type === 'AttemptCompleted' ||
    event.type === 'AttemptFailed' || event.type === 'AttemptCancelled';
}

import {
  allowlistProviderObservation,
  normalizedEvent,
} from '../shared/runtime/event-timeline-contract';
import type { NormalizedRuntimeEventView } from '../shared/runtime/runtime-interface';
import type {
  AttemptCancelledEvent,
  AttemptCompletedEvent,
  AttemptFailedEvent,
  AttemptStartedEvent,
  CancellationRequestedEvent,
  ContextAllocatedEvent,
  RawProviderObservationRecordedEvent,
  StoredProviderSession,
  TaskCreatedEvent,
  TaskEvent,
} from './task-events';
import {
  acceptedProviderActionIdentity,
  providerChildOperation,
  type AcceptedProviderActionIdentity,
} from './provider-action-identity';

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
  readonly failedContexts: ContextAllocatedEvent[];
  observation: RawProviderObservationRecordedEvent | null;
  started: AttemptStartedEvent | null;
  cancellation: CancellationRequestedEvent | null;
  terminal: TerminalEvent | null;
}

type TerminalEvent = AttemptCompletedEvent | AttemptFailedEvent | AttemptCancelledEvent;

interface TaskHistoryAnalysis {
  readonly task: TaskCreatedEvent;
  readonly attempts: readonly AttemptHistory[];
  readonly normalized: readonly NormalizedRuntimeEventView[];
}

interface HistoryScan {
  readonly attempts: AttemptHistory[];
  readonly attemptsById: Map<string, AttemptHistory>;
  readonly sessions: Map<string, AttemptHistory>;
  readonly acceptedActions: Map<string, AcceptedProviderActionIdentity>;
  readonly normalized: NormalizedRuntimeEventView[];
  operation: OperationIdentity | null;
  current: AttemptHistory | null;
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
    const descriptors = normalizedDescriptors(analysis);
    assertNormalizedPrefix(analysis.normalized, descriptors);
    const ambiguous = analysis.attempts.find(hasAmbiguousLegacyContext);
    if (ambiguous) throw new TaskEventHistoryError(
      `ambiguous legacy context-only prefix for attempt ${ambiguous.id}`,
    );
    const missingObservation = analysis.attempts.find((attempt) =>
      attempt.context?.providerSession && !attempt.observation);
    if (missingObservation) {
      if (analysis.normalized.some((event) => event.attemptId === missingObservation.id)) {
        throw new TaskEventHistoryError('provider observation missing before later evidence');
      }
      return recoveredObservation(missingObservation, now);
    }

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

    const unstatedStart = analysis.attempts.find(needsCoreStartRepair);
    if (unstatedStart) {
      return { type: 'AttemptStarted', version: 1, taskId, occurredAt: now };
    }
    return null;
  }

  assertComplete(taskId: string): void {
    const analysis = this.analyze(taskId);
    const incomplete = analysis.attempts.find((attempt) =>
      (attempt.context?.providerSession && !attempt.observation) ||
      needsCoreStartRepair(attempt) || hasAmbiguousLegacyContext(attempt));
    if (incomplete) throw new TaskEventHistoryError(
      `incomplete attempt ${incomplete.id}: context=${Boolean(incomplete.context)} ` +
      `observation=${Boolean(incomplete.observation)} started=${Boolean(incomplete.started)}`,
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
    const scan: HistoryScan = { attempts: [], attemptsById: new Map(), sessions: new Map(),
      acceptedActions: new Map(), normalized: [], operation: null, current: null };
    for (const event of taskEvents) acceptHistoryEvent(scan, event, taskId);
    return { task, attempts: scan.attempts, normalized: scan.normalized };
  }
}

function acceptHistoryEvent(scan: HistoryScan, event: TaskEvent, taskId: string): void {
  if (event.type === 'RunCreated') {
    scan.operation = operationIdentity(event.run.id, event.idempotencyKey, event.correlationId);
  } else if (event.type === 'AttemptCreated') {
    scan.current = addAttempt(event.attempt.id, scan.operation, scan.attempts, scan.attemptsById);
  } else if (event.type === 'ProviderSessionActionDecided') {
    acceptProviderDecision(scan, event);
  } else if (event.type === 'AttemptResumed' || event.type === 'AttemptForked') {
    acceptProviderChild(scan, event);
  } else if (event.type === 'ContextAllocated') {
    acceptContext(scan, event, taskId);
  } else if (event.type === 'RawProviderObservationRecorded') {
    acceptObservation(scan, event);
  } else if (event.type === 'AttemptStarted') {
    const current = requiredAttempt(scan.current);
    if (current.started) throw new TaskEventHistoryError();
    current.started = event;
  } else if (event.type === 'CancellationRequested') {
    const current = requiredAttempt(scan.current);
    if (current.cancellation) throw new TaskEventHistoryError();
    current.cancellation = event;
  } else if (event.type === 'AttemptCompleted' || event.type === 'AttemptFailed' ||
    event.type === 'AttemptCancelled') {
    setTerminal(requiredAttempt(scan.current), event);
  } else if (event.type === 'NormalizedRuntimeEventRecorded') {
    scan.normalized.push(event.event);
  }
}

function acceptProviderDecision(
  scan: HistoryScan,
  event: Extract<TaskEvent, { type: 'ProviderSessionActionDecided' }>,
): void {
  const owner = scan.sessions.get(event.providerSessionId);
  const runId = event.outcome === 'accepted' && event.decision !== 'exact-reattach'
    ? requiredRun(scan.operation) : '';
  const accepted = acceptedProviderActionIdentity(
    event, owner?.context?.providerSession ?? null, runId,
  );
  if (!accepted) return;
  if (scan.acceptedActions.has(accepted.actionKey)) throw new TaskEventHistoryError();
  scan.acceptedActions.set(accepted.actionKey, accepted);
}

function acceptProviderChild(
  scan: HistoryScan,
  event: Extract<TaskEvent, { type: 'AttemptResumed' | 'AttemptForked' }>,
): void {
  const key = event.type === 'AttemptResumed' ? event.actionKey : event.forkKey;
  const operation = providerChildOperation(scan.acceptedActions.get(key) ?? null, event);
  scan.acceptedActions.delete(key);
  scan.operation = operationIdentity(operation.runId, operation.idempotencyKey,
    operation.correlationId);
  scan.current = addAttempt(event.attempt.id, scan.operation, scan.attempts, scan.attemptsById);
}

function acceptContext(scan: HistoryScan, event: ContextAllocatedEvent, taskId: string): void {
  const current = requiredAttempt(scan.current);
  const session = event.providerSession;
  if (event.launchOutcome === 'failed') {
    if (session || event.observedAt !== undefined) throw new TaskEventHistoryError();
    current.failedContexts.push(event);
    return;
  }
  if (current.context || (session && (session.taskId !== taskId ||
    session.attemptId !== current.id || session.executionContextId !== event.context.id ||
    scan.sessions.has(session.id)))) throw new TaskEventHistoryError();
  current.context = event;
  if (session) scan.sessions.set(session.id, current);
}

function acceptObservation(scan: HistoryScan, event: RawProviderObservationRecordedEvent): void {
  const owner = scan.sessions.get(event.providerSessionId);
  if (!owner || owner.observation || event.idempotencyKey !== owner.operation.idempotencyKey ||
    (owner.context?.observedAt !== undefined &&
      event.observation.observedAt !== owner.context.observedAt)) throw new TaskEventHistoryError();
  owner.observation = event;
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
    failedContexts: [],
    observation: null,
    started: null,
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
    descriptors.push(...attemptDescriptors(attempt));
  }
  return descriptors;
}

function attemptDescriptors(attempt: AttemptHistory): readonly NormalizedDescriptor[] {
  const descriptors: NormalizedDescriptor[] = [];
  const providerSession = attempt.context?.providerSession ?? null;
  if (attempt.observation) descriptors.push({
    kind: 'provider-session-observed', attempt, operation: attempt.operation,
    providerSession, occurrenceAt: attempt.observation.observation.observedAt,
    observation: attempt.observation,
  });
  if (attempt.started || attempt.cancellation || attempt.terminal) descriptors.push({
    kind: 'attempt-started', attempt, operation: attempt.operation, providerSession,
    occurrenceAt: startOccurrence(attempt), observation: null,
  });
  if (attempt.cancellation) descriptors.push({
    kind: 'cancellation-requested', attempt,
    operation: cancellationOperation(attempt), providerSession,
    occurrenceAt: attempt.cancellation.occurredAt ?? null, observation: null,
  });
  if (attempt.terminal) descriptors.push({
    kind: terminalKind(attempt.terminal), attempt,
    operation: attempt.terminal.type === 'AttemptCancelled' && attempt.cancellation
      ? cancellationOperation(attempt) : attempt.operation,
    providerSession, occurrenceAt: attempt.terminal.occurredAt ?? null, observation: null,
  });
  return descriptors;
}

function needsCoreStartRepair(attempt: AttemptHistory): boolean {
  return Boolean(attempt.context?.launchOutcome === 'succeeded' && !attempt.started &&
    !attempt.cancellation && !attempt.terminal);
}

function hasAmbiguousLegacyContext(attempt: AttemptHistory): boolean {
  return Boolean(attempt.context && attempt.context.launchOutcome === undefined &&
    !attempt.started && !attempt.cancellation && !attempt.terminal);
}

function setTerminal(attempt: AttemptHistory, event: TerminalEvent): void {
  if (attempt.terminal) throw new TaskEventHistoryError();
  attempt.terminal = event;
}

function startOccurrence(attempt: AttemptHistory): string | null {
  if (attempt.started) return attempt.started.occurredAt ?? null;
  return attempt.cancellation?.occurredAt ?? attempt.terminal?.occurredAt ?? null;
}

function cancellationOperation(attempt: AttemptHistory): OperationIdentity {
  const cancellation = attempt.cancellation;
  if (!cancellation) throw new TaskEventHistoryError();
  return operationIdentity(
    attempt.operation.runId,
    cancellation.idempotencyKey,
    cancellation.correlationId,
  );
}

function terminalKind(event: TerminalEvent): Extract<
  NormalizedRuntimeEventView['kind'],
  'attempt-completed' | 'attempt-failed' | 'attempt-cancelled'
> {
  if (event.type === 'AttemptCompleted') return 'attempt-completed';
  if (event.type === 'AttemptFailed') return 'attempt-failed';
  return 'attempt-cancelled';
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
      event.correlationId !== descriptor.operation.correlationId ||
      (descriptor.occurrenceAt !== null &&
        (event.occurrenceAt !== descriptor.occurrenceAt ||
          event.observedAt !== descriptor.occurrenceAt))) {
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
    observedAt: attempt.context?.observedAt ?? now,
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

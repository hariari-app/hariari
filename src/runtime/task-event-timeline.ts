import {
  allowlistProviderObservation,
  assertEventTimelineHistory,
  assertEventTimelinePrefix,
  assertCanonicalNormalizedEventIdentity,
  assertCanonicalProviderObservationIdentity,
  assertCanonicalTaskCreatedIdentity,
  normalizedEvent,
  parseNormalizedRuntimeEvent,
  parseRawProviderObservation,
  timelineEntry,
} from '../shared/runtime/event-timeline-contract';
import type {
  NormalizedRuntimeEventView,
  RawProviderObservationView,
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../shared/runtime/runtime-interface';
import type {
  AttemptCancelledEvent,
  AttemptCompletedEvent,
  AttemptFailedEvent,
  NormalizedRuntimeEventRecordedEvent,
  RawProviderObservationRecordedEvent,
  StoredProviderSession,
} from './task-events';
import type { StoredExecution } from './task-execution-state';
import { eventTimelineOperationChain } from './task-execution-state';

type TimelineEvent = RawProviderObservationRecordedEvent | NormalizedRuntimeEventRecordedEvent;
type TerminalTaskEvent = AttemptCancelledEvent | AttemptCompletedEvent | AttemptFailedEvent;
type TerminalState = 'completed' | 'failed' | 'cancelled';
export type AttemptLifecycleKind = Exclude<NormalizedRuntimeEventView['kind'], 'task-created' | 'provider-session-observed'>;

interface TaskEventTimelineDependencies {
  readonly now: () => string;
  readonly append: (event: TimelineEvent | TerminalTaskEvent) => Promise<void>;
  readonly execution: (taskId: string) => StoredExecution;
}

interface ProviderObservationAppend {
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly observedAt: string;
  readonly evidence: unknown;
  readonly append: (event: TimelineEvent) => Promise<void>;
}

interface RecordLifecycleEvent {
  readonly taskId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly providerSessionId: string | null;
  readonly kind: Exclude<NormalizedRuntimeEventView['kind'], 'provider-session-observed'>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly append: (event: NormalizedRuntimeEventRecordedEvent) => Promise<void>;
}

export class ProviderObservationValidationError extends Error {
  constructor() {
    super('invalid provider observation authority');
    this.name = 'ProviderObservationValidationError';
  }
}

/** Owns canonical append validation and the disposable Task timeline projection. */
export class TaskEventTimeline {
  private readonly rawObservations = new Map<string, RawProviderObservationView[]>();
  private readonly normalizedEvents = new Map<string, NormalizedRuntimeEventView[]>();
  private readonly taskCreations = new Map<string, {
    readonly taskId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly createdAt: string;
  }>();

  constructor(private readonly dependencies: TaskEventTimelineDependencies) {}

  view(taskId: string, status: TaskExecutionView): TaskTimelineView {
    const normalizedEvents = [...(this.normalizedEvents.get(taskId) ?? [])];
    const rawObservations = [...(this.rawObservations.get(taskId) ?? [])];
    assertEventTimelineHistory(
      taskId,
      status,
      rawObservations,
      normalizedEvents,
      status.run ? eventTimelineOperationChain(this.dependencies.execution(taskId)) : undefined,
    );
    return {
      taskId,
      status,
      rawObservations,
      normalizedEvents,
      timeline: normalizedEvents.map(timelineEntry),
    };
  }

  assertReplayComplete(statuses: readonly TaskExecutionView[]): void {
    for (const status of statuses) {
      assertEventTimelineHistory(
        status.task.id,
        status,
        this.observations(status.task.id),
        this.events(status.task.id),
        status.run
          ? eventTimelineOperationChain(this.dependencies.execution(status.task.id))
          : undefined,
      );
    }
  }

  async repairMissingTaskCreations(tasks: readonly TaskView[]): Promise<void> {
    for (const task of tasks) {
      if (this.events(task.id).length > 0) continue;
      const identity = this.taskCreations.get(task.id);
      if (!identity) throw new Error('missing Task create identity');
      await this.recordTaskCreated(task, identity.idempotencyKey, identity.correlationId);
    }
  }

  registerTaskCreated(
    task: TaskView,
    idempotencyKey: string,
    correlationId: string,
  ): void {
    const identity = { taskId: task.id, idempotencyKey, correlationId, createdAt: task.createdAt };
    const existing = this.taskCreations.get(task.id);
    if (existing) throw new Error('duplicate Task create identity');
    this.taskCreations.set(task.id, identity);
  }

  hasMatchingProviderObservation(
    taskId: string,
    attemptId: string,
    providerSessionId: string,
  ): boolean {
    const event = this.events(taskId).find((candidate) =>
      candidate.kind === 'provider-session-observed' && candidate.attemptId === attemptId &&
      candidate.providerSessionId === providerSessionId);
    return event !== undefined && this.observations(taskId).some((item) => item.id === event.causationId);
  }

  hasLifecycleEvent(
    taskId: string,
    attemptId: string | null,
    kind: AttemptLifecycleKind,
  ): boolean {
    return this.events(taskId).some((event) => event.kind === kind && event.attemptId === attemptId);
  }

  apply(event: TimelineEvent, execution?: TaskExecutionView): void {
    if (event.type === 'RawProviderObservationRecorded') {
      this.applyRaw(event);
    }
    else {
      this.applyNormalized(event, execution);
    }
  }

  recordTaskCreated(
    task: TaskView,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<void> {
    return this.recordLifecycle({ taskId: task.id, runId: null, attemptId: null,
      providerSessionId: null, kind: 'task-created', idempotencyKey, correlationId,
      occurredAt: task.createdAt, append: this.dependencies.append });
  }

  recordAttemptLifecycle(
    execution: StoredExecution,
    kind: AttemptLifecycleKind,
    occurredAt: string = this.dependencies.now(),
  ): Promise<void> {
    const attempt = execution.attempt;
    if (!attempt) throw new Error('missing lifecycle attempt');
    const session = execution.providerSessions.find((candidate) =>
      candidate.attemptId === attempt.id) ?? null;
    const attemptOperation = execution.attemptOperations.find((candidate) =>
      candidate.attemptId === attempt.id);
    const operation = kind === 'attempt-started' ? attemptOperation : null;
    return this.recordLifecycle({ taskId: execution.taskId, runId: execution.run.id,
      attemptId: attempt.id, providerSessionId: session?.id ?? null, kind,
      idempotencyKey: operation?.idempotencyKey ?? execution.currentOperationKey,
      correlationId: operation?.correlationId ?? execution.currentCorrelationId,
      occurredAt,
      append: this.dependencies.append });
  }

  recordTerminalLifecycle(
    execution: StoredExecution,
    occurredAt?: string,
  ): Promise<void> {
    const state = execution.attempt?.state;
    if (state !== 'completed' && state !== 'failed' && state !== 'cancelled') {
      throw new Error('missing terminal lifecycle');
    }
    return this.recordAttemptLifecycle(execution, `attempt-${state}`, occurredAt);
  }

  async recordTerminalTransition(
    execution: StoredExecution,
    requested: TerminalState,
    exitCode?: number,
  ): Promise<StoredExecution> {
    if (isTerminalState(execution.attempt?.state)) {
      await this.recordTerminalLifecycle(execution);
      return execution;
    }
    const occurredAt = this.dependencies.now();
    const cancelled = requested === 'cancelled' || execution.attempt?.state === 'cancelling';
    const event: TerminalTaskEvent = cancelled
      ? { type: 'AttemptCancelled', version: 1, taskId: execution.taskId, occurredAt }
      : requested === 'completed'
        ? {
            type: 'AttemptCompleted',
            version: 1,
            taskId: execution.taskId,
            exitCode: exitCode ?? 0,
            occurredAt,
          }
        : { type: 'AttemptFailed', version: 1, taskId: execution.taskId, occurredAt };
    await this.dependencies.append(event);
    const terminal = this.dependencies.execution(execution.taskId);
    if (!this.hasLifecycleEvent(terminal.taskId, terminal.attempt?.id ?? null,
      'attempt-started')) {
      await this.recordAttemptLifecycle(terminal, 'attempt-started', occurredAt);
    }
    await this.recordTerminalLifecycle(terminal, occurredAt);
    return terminal;
  }

  recordProviderObservation(
    execution: StoredExecution,
    providerSession: StoredProviderSession,
    evidence: unknown,
  ): Promise<void> {
    const attempt = execution.attempt;
    if (!attempt) throw new Error('missing provider observation attempt');
    return this.appendProviderObservation({ taskId: execution.taskId, runId: execution.run.id,
      attemptId: attempt.id,
      providerSessionId: providerSession.id,
      idempotencyKey: execution.currentOperationKey,
      correlationId: execution.currentCorrelationId,
      observedAt: execution.providerObservationAt ?? this.dependencies.now(),
      evidence, append: this.dependencies.append });
  }

  validateProviderObservation(
    execution: StoredExecution,
    providerSession: StoredProviderSession,
    evidence: unknown,
    observedAt: string,
  ): void {
    const attempt = execution.attempt;
    try {
      if (!attempt) throw new Error('missing provider observation attempt');
      const observation = allowlistProviderObservation({
        taskId: execution.taskId, providerSessionId: providerSession.id,
        idempotencyKey: execution.currentOperationKey, observedAt, evidence,
      });
      normalizedEvent({
        taskId: execution.taskId, runId: execution.run.id, attemptId: attempt.id,
        providerSessionId: providerSession.id, kind: 'provider-session-observed',
        idempotencyKey: execution.currentOperationKey,
        correlationId: execution.currentCorrelationId,
        sequence: this.events(execution.taskId).length + 1,
        occurrenceAt: observation.observedAt, observedAt: observation.observedAt,
        causationId: observation.id, redaction: observation.redaction,
      });
    } catch {
      throw new ProviderObservationValidationError();
    }
  }

  private async appendProviderObservation(input: ProviderObservationAppend): Promise<void> {
    const candidate = allowlistProviderObservation({
      taskId: input.taskId,
      providerSessionId: input.providerSessionId,
      idempotencyKey: input.idempotencyKey,
      observedAt: input.observedAt,
      evidence: input.evidence,
    });
    const existingObservation = this.rawObservationById(candidate.id);
    const observation = existingObservation
      ? { ...candidate, observedAt: existingObservation.observedAt }
      : candidate;
    if (existingObservation) this.assertSame(existingObservation, observation);
    else await input.append({
      type: 'RawProviderObservationRecorded', version: 1,
      taskId: input.taskId, providerSessionId: input.providerSessionId,
      idempotencyKey: input.idempotencyKey, observation,
    });

    const existingEvent = this.events(input.taskId).find((event) =>
      event.kind === 'provider-session-observed' &&
      event.attemptId === input.attemptId &&
      event.providerSessionId === input.providerSessionId);
    if (existingEvent) {
      if (existingEvent.causationId !== observation.id ||
        existingEvent.idempotencyKey !== input.idempotencyKey ||
        existingEvent.correlationId !== input.correlationId) {
        throw new Error('conflicting event identity');
      }
      return;
    }

    const event = normalizedEvent({
      taskId: input.taskId,
      runId: input.runId,
      attemptId: input.attemptId,
      providerSessionId: input.providerSessionId,
      kind: 'provider-session-observed',
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      sequence: this.events(input.taskId).length + 1,
      occurrenceAt: observation.observedAt,
      observedAt: observation.observedAt,
      causationId: observation.id,
      redaction: observation.redaction,
    });
    await this.appendNormalized(input.taskId, event, input.append);
  }

  private async recordLifecycle(input: RecordLifecycleEvent): Promise<void> {
    const existing = this.events(input.taskId).find((event) =>
      event.kind === input.kind && event.attemptId === input.attemptId);
    if (existing) {
      if (existing.runId !== input.runId || existing.providerSessionId !== input.providerSessionId ||
        existing.idempotencyKey !== input.idempotencyKey ||
        existing.correlationId !== input.correlationId) {
        throw new Error('conflicting lifecycle event identity');
      }
      return;
    }
    const event = normalizedEvent({
      taskId: input.taskId,
      runId: input.runId,
      attemptId: input.attemptId,
      providerSessionId: input.providerSessionId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      sequence: this.events(input.taskId).length + 1,
      occurrenceAt: input.occurredAt,
      observedAt: input.occurredAt,
      causationId: this.lifecycleCausation(input),
    });
    await this.appendNormalized(input.taskId, event, input.append);
  }

  private async appendNormalized(
    taskId: string,
    event: NormalizedRuntimeEventView,
    append: (event: NormalizedRuntimeEventRecordedEvent) => Promise<void>,
  ): Promise<void> {
    const existing = this.normalizedEventById(event.id);
    if (existing) return this.assertSame(existing, event);
    await append({ type: 'NormalizedRuntimeEventRecorded', version: 1, taskId, event });
  }

  private lifecycleCausation(input: RecordLifecycleEvent): string | null {
    if (input.kind === 'task-created') return null;
    const events = this.events(input.taskId);
    if (input.kind === 'attempt-started') {
      return [...events].reverse().find((event) =>
        event.attemptId === input.attemptId && event.kind === 'provider-session-observed')?.id ??
        events.find((event) => event.kind === 'task-created')?.id ?? null;
    }
    if (input.kind === 'attempt-cancelled') {
      return [...events].reverse().find((event) =>
        event.attemptId === input.attemptId && event.kind === 'cancellation-requested')?.id ?? null;
    }
    return [...events].reverse().find((event) =>
      event.attemptId === input.attemptId && event.kind === 'attempt-started')?.id ??
      [...events].reverse().find((event) => event.attemptId === input.attemptId)?.id ??
      events.find((event) => event.kind === 'task-created')?.id ?? null;
  }

  private applyRaw(record: RawProviderObservationRecordedEvent): void {
    const observation = parseRawProviderObservation(record.observation);
    assertCanonicalProviderObservationIdentity(observation, record);
    const observations = this.observations(record.taskId);
    const existing = observations.find((candidate) => candidate.id === observation.id);
    if (existing) throw new Error('duplicate observation identity');
    if (this.rawObservationById(observation.id)) throw new Error('duplicate observation identity');
    this.rawObservations.set(record.taskId, [...observations, observation]);
  }

  private applyNormalized(
    record: NormalizedRuntimeEventRecordedEvent,
    execution: TaskExecutionView | undefined,
  ): void {
    const event = parseNormalizedRuntimeEvent(record.event);
    assertCanonicalNormalizedEventIdentity(event, record.taskId);
    if (event.kind === 'task-created') {
      const identity = this.taskCreations.get(record.taskId);
      if (!identity) throw new Error('missing Task create identity');
      assertCanonicalTaskCreatedIdentity(event, identity);
    }
    const events = this.events(record.taskId);
    if (event.taskId !== record.taskId || event.sequence !== events.length + 1) {
      throw new Error('invalid normalized event identity');
    }
    const existing = events.find((candidate) => candidate.id === event.id);
    if (existing) return this.assertSame(existing, event);
    if (this.normalizedEventById(event.id)) throw new Error('duplicate event identity');
    if (!execution) throw new Error('missing event execution');
    const updated = [...events, event];
    assertEventTimelinePrefix(
      record.taskId,
      execution,
      this.observations(record.taskId),
      updated,
    );
    this.normalizedEvents.set(record.taskId, updated);
  }

  private assertSame(left: object, right: object): void {
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('conflicting event identity');
  }

  private observations(taskId: string): readonly RawProviderObservationView[] {
    return this.rawObservations.get(taskId) ?? [];
  }

  private events(taskId: string): readonly NormalizedRuntimeEventView[] {
    return this.normalizedEvents.get(taskId) ?? [];
  }

  private rawObservationById(id: string): RawProviderObservationView | undefined {
    return [...this.rawObservations.values()].flat().find((observation) => observation.id === id);
  }

  private normalizedEventById(id: string): NormalizedRuntimeEventView | undefined {
    return [...this.normalizedEvents.values()].flat().find((event) => event.id === id);
  }
}

function isTerminalState(value: unknown): value is TerminalState {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

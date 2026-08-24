import {
  allowlistProviderObservation,
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
  NormalizedRuntimeEventRecordedEvent,
  RawProviderObservationRecordedEvent,
  StoredProviderSession,
} from './task-events';
import type { StoredExecution } from './task-execution-state';

type TimelineEvent = RawProviderObservationRecordedEvent | NormalizedRuntimeEventRecordedEvent;
export type AttemptLifecycleKind = Exclude<NormalizedRuntimeEventView['kind'], 'task-created' | 'provider-session-observed'>;

interface TaskEventTimelineDependencies {
  readonly now: () => string;
  readonly append: (event: TimelineEvent) => Promise<void>;
}

interface ProviderObservationAppend {
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
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
  readonly occurredAt: string;
  readonly append: (event: NormalizedRuntimeEventRecordedEvent) => Promise<void>;
}

/** Owns canonical append validation and the disposable Task timeline projection. */
export class TaskEventTimeline {
  private readonly rawObservations = new Map<string, RawProviderObservationView[]>();
  private readonly normalizedEvents = new Map<string, NormalizedRuntimeEventView[]>();

  constructor(private readonly dependencies: TaskEventTimelineDependencies) {}

  view(taskId: string, status: TaskExecutionView): TaskTimelineView {
    const normalizedEvents = [...(this.normalizedEvents.get(taskId) ?? [])];
    return {
      taskId,
      status,
      rawObservations: [...(this.rawObservations.get(taskId) ?? [])],
      normalizedEvents,
      timeline: normalizedEvents.map(timelineEntry),
    };
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

  apply(event: TimelineEvent, execution?: StoredExecution): void {
    if (event.type === 'RawProviderObservationRecorded') this.applyRaw(event);
    else {
      this.assertApplicableExecution(event.event, execution);
      this.applyNormalized(event);
    }
  }

  recordTaskCreated(
    task: TaskView,
    idempotencyKey: string,
  ): Promise<void> {
    return this.recordLifecycle({ taskId: task.id, runId: null, attemptId: null,
      providerSessionId: null, kind: 'task-created', idempotencyKey,
      occurredAt: task.createdAt, append: this.dependencies.append });
  }

  recordAttemptLifecycle(
    execution: StoredExecution,
    kind: AttemptLifecycleKind,
  ): Promise<void> {
    const attempt = execution.attempt;
    if (!attempt) throw new Error('missing lifecycle attempt');
    const session = execution.providerSessions.find((candidate) =>
      candidate.attemptId === attempt.id) ?? null;
    return this.recordLifecycle({ taskId: execution.taskId, runId: execution.run.id,
      attemptId: attempt.id, providerSessionId: session?.id ?? null, kind,
      idempotencyKey: execution.currentOperationKey, occurredAt: this.dependencies.now(),
      append: this.dependencies.append });
  }

  recordTerminalLifecycle(
    execution: StoredExecution,
  ): Promise<void> {
    const state = execution.attempt?.state;
    if (state !== 'completed' && state !== 'failed' && state !== 'cancelled') {
      throw new Error('missing terminal lifecycle');
    }
    return this.recordAttemptLifecycle(execution, `attempt-${state}`);
  }

  recordProviderObservation(
    execution: StoredExecution,
    providerSession: StoredProviderSession,
    idempotencyKey: string,
    evidence: unknown,
  ): Promise<void> {
    const attempt = execution.attempt;
    if (!attempt) throw new Error('missing provider observation attempt');
    return this.appendProviderObservation({ taskId: execution.taskId, runId: execution.run.id,
      attemptId: attempt.id, providerSessionId: providerSession.id, idempotencyKey,
      observedAt: this.dependencies.now(), evidence, append: this.dependencies.append });
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
      taskId: input.taskId, observation,
    });

    const event = normalizedEvent({
      taskId: input.taskId,
      runId: input.runId,
      attemptId: input.attemptId,
      providerSessionId: input.providerSessionId,
      kind: 'provider-session-observed',
      idempotencyKey: input.idempotencyKey,
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
        existing.idempotencyKey !== input.idempotencyKey) {
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
    return [...events].reverse().find((event) =>
      event.attemptId === input.attemptId && event.kind === 'attempt-started')?.id ??
      [...events].reverse().find((event) => event.attemptId === input.attemptId)?.id ??
      events.find((event) => event.kind === 'task-created')?.id ?? null;
  }

  private applyRaw(record: RawProviderObservationRecordedEvent): void {
    const observation = parseRawProviderObservation(record.observation);
    if (observation.taskId !== record.taskId) throw new Error('invalid event timeline');
    const observations = this.observations(record.taskId);
    const existing = observations.find((candidate) => candidate.id === observation.id);
    if (existing) return this.assertSame(existing, observation);
    if (this.rawObservationById(observation.id)) throw new Error('duplicate observation identity');
    this.rawObservations.set(record.taskId, [...observations, observation]);
  }

  private applyNormalized(record: NormalizedRuntimeEventRecordedEvent): void {
    const event = parseNormalizedRuntimeEvent(record.event);
    const events = this.events(record.taskId);
    if (event.taskId !== record.taskId || event.sequence !== events.length + 1) {
      throw new Error('invalid normalized event identity');
    }
    this.assertCausation(event, events);
    const existing = events.find((candidate) => candidate.id === event.id);
    if (existing) return this.assertSame(existing, event);
    if (this.normalizedEventById(event.id)) throw new Error('duplicate event identity');
    this.normalizedEvents.set(record.taskId, [...events, event]);
  }

  private assertApplicableExecution(
    event: NormalizedRuntimeEventView,
    execution: StoredExecution | undefined,
  ): void {
    if (event.kind === 'task-created') return;
    const attempt = execution?.attempts.find((candidate) => candidate.id === event.attemptId);
    if (!execution || event.runId !== execution.run.id || !attempt) {
      throw new Error('invalid event execution identity');
    }
    if (event.providerSessionId && !execution.providerSessions.some((candidate) =>
      candidate.id === event.providerSessionId && candidate.attemptId === attempt.id)) {
      throw new Error('invalid event provider-session identity');
    }
  }

  private assertCausation(
    event: NormalizedRuntimeEventView,
    prior: readonly NormalizedRuntimeEventView[],
  ): void {
    if (event.kind === 'task-created') {
      if (event.causationId !== null) throw new Error('invalid event causation');
      return;
    }
    if (event.kind === 'provider-session-observed') {
      const raw = event.causationId && this.rawObservationById(event.causationId);
      if (!raw || raw.taskId !== event.taskId || raw.observedAt !== event.observedAt ||
        JSON.stringify(raw.redaction) !== JSON.stringify(event.redaction)) {
        throw new Error('invalid event causation');
      }
      return;
    }
    if (!prior.some((candidate) => candidate.id === event.causationId)) {
      throw new Error('invalid event causation');
    }
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

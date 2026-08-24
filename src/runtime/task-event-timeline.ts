import type {
  NormalizedRuntimeEventView,
  RawProviderObservationView,
  TaskExecutionView,
  TaskTimelineView,
} from '../shared/runtime/runtime-interface';
import type {
  NormalizedRuntimeEventRecordedEvent,
  RawProviderObservationRecordedEvent,
  StoredContext,
  StoredProviderSession,
} from './task-events';

type TimelineEvent = RawProviderObservationRecordedEvent | NormalizedRuntimeEventRecordedEvent;

interface RecordProviderObservation {
  readonly taskId: string;
  readonly context: StoredContext;
  readonly providerSession: StoredProviderSession;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly append: (event: TimelineEvent) => Promise<void>;
}

/** Replayable public evidence projection backed by separate raw and normalized records. */
export class TaskEventTimeline {
  private readonly rawObservations = new Map<string, RawProviderObservationView[]>();
  private readonly normalizedEvents = new Map<string, NormalizedRuntimeEventView[]>();

  view(taskId: string, status: TaskExecutionView): TaskTimelineView {
    const normalizedEvents = [...(this.normalizedEvents.get(taskId) ?? [])];
    return {
      taskId,
      status,
      rawObservations: [...(this.rawObservations.get(taskId) ?? [])],
      normalizedEvents,
      timeline: normalizedEvents.map((event) => ({
        eventId: event.id,
        sequence: event.sequence,
        occurredAt: event.occurrenceAt,
        message: 'Claude provider session observed' as const,
      })),
    };
  }

  has(taskId: string, contextId: string, providerSessionId: string): boolean {
    return this.rawObservations.get(taskId)?.some((observation) => observation.id === contextId) === true &&
      this.normalizedEvents.get(taskId)?.some((event) =>
        event.id === providerSessionId && event.causationId === contextId) === true;
  }

  apply(event: TimelineEvent): void {
    if (event.type === 'RawProviderObservationRecorded') this.applyRaw(event);
    else this.applyNormalized(event);
  }

  async record(input: RecordProviderObservation): Promise<void> {
    const existingObservation = this.rawObservationById(input.context.id);
    const observedAt = existingObservation?.observedAt ?? input.observedAt;
    const redaction = {
      status: 'allowlisted' as const,
      omittedFields: ['nativeSessionId', 'capabilities'] as const,
    };
    const observation: RawProviderObservationView = {
      schema: 'hariari.provider-observation', version: 1, id: input.context.id, taskId: input.taskId,
      provider: 'claude', kind: 'provider-session-observed', observedAt, redaction,
    };
    if (existingObservation) this.assertSame(existingObservation, observation);
    else await input.append({ type: 'RawProviderObservationRecorded', version: 1, taskId: input.taskId, observation });

    const event: NormalizedRuntimeEventView = {
      schema: 'hariari.runtime.event', version: 1, id: input.providerSession.id, taskId: input.taskId,
      kind: 'provider-session-observed', correlationId: observation.id,
      causationId: observation.id, idempotencyKey: input.idempotencyKey,
      sequence: (this.normalizedEvents.get(input.taskId) ?? []).length + 1,
      occurrenceAt: observedAt, observedAt, redaction,
    };
    const existingEvent = this.normalizedEventById(event.id);
    if (existingEvent) this.assertSame(existingEvent, event);
    else await input.append({ type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: input.taskId, event });
  }

  private applyRaw(event: RawProviderObservationRecordedEvent): void {
    const observations = this.rawObservations.get(event.taskId) ?? [];
    const existing = observations.find((observation) => observation.id === event.observation.id);
    if (existing) return this.assertSame(existing, event.observation);
    if (this.rawObservationById(event.observation.id)) throw new Error('duplicate observation identity');
    this.rawObservations.set(event.taskId, [...observations, event.observation]);
  }

  private applyNormalized(event: NormalizedRuntimeEventRecordedEvent): void {
    const raw = this.rawObservationById(event.event.causationId);
    const events = this.normalizedEvents.get(event.taskId) ?? [];
    if (!raw || raw.taskId !== event.taskId || event.event.correlationId !== raw.id ||
      event.event.observedAt !== raw.observedAt || event.event.sequence !== events.length + 1) {
      throw new Error('invalid normalized event identity');
    }
    const existing = events.find((candidate) => candidate.id === event.event.id);
    if (existing) return this.assertSame(existing, event.event);
    if (this.normalizedEventById(event.event.id)) throw new Error('duplicate event identity');
    this.normalizedEvents.set(event.taskId, [...events, event.event]);
  }

  private assertSame(left: object, right: object): void {
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('conflicting event identity');
  }

  private rawObservationById(id: string): RawProviderObservationView | undefined {
    return [...this.rawObservations.values()].flat().find((observation) => observation.id === id);
  }

  private normalizedEventById(id: string): NormalizedRuntimeEventView | undefined {
    return [...this.normalizedEvents.values()].flat().find((event) => event.id === id);
  }
}

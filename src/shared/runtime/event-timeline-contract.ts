export const PROVIDER_OBSERVATION_SCHEMA = 'hariari.provider-observation' as const;
export const RUNTIME_EVENT_SCHEMA = 'hariari.runtime.event' as const;
export const EVENT_TIMELINE_SCHEMA_VERSION = 1 as const;

export const EVENT_REDACTION_FIELDS = [
  'nativeSessionId', 'capabilities', 'providerNativeId', 'absolutePath',
  'command', 'environment', 'secret', 'unproven',
] as const;

export const EVENT_TIMELINE_MESSAGES = {
  'task-created': 'Task created',
  'provider-session-observed': 'Claude provider session observed',
  'attempt-started': 'Attempt started',
  'attempt-completed': 'Attempt completed',
  'attempt-failed': 'Attempt failed',
  'attempt-cancelled': 'Attempt cancelled',
} as const;

export type NormalizedRuntimeEventKind = keyof typeof EVENT_TIMELINE_MESSAGES;
export type TaskTimelineMessage = (typeof EVENT_TIMELINE_MESSAGES)[NormalizedRuntimeEventKind];

export interface EventRedactionMetadata {
  readonly status: 'allowlisted';
  readonly omittedFields: readonly (typeof EVENT_REDACTION_FIELDS)[number][];
}

export interface RawProviderObservationView {
  readonly schema: typeof PROVIDER_OBSERVATION_SCHEMA;
  readonly version: typeof EVENT_TIMELINE_SCHEMA_VERSION;
  readonly id: string;
  readonly taskId: string;
  readonly provider: 'claude';
  readonly kind: 'provider-session-observed';
  readonly observedAt: string;
  readonly evidence: { readonly sessionState: 'active' };
  readonly redaction: EventRedactionMetadata;
}

export interface NormalizedRuntimeEventView {
  readonly schema: typeof RUNTIME_EVENT_SCHEMA;
  readonly version: typeof EVENT_TIMELINE_SCHEMA_VERSION;
  readonly id: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly providerSessionId: string | null;
  readonly kind: NormalizedRuntimeEventKind;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly occurrenceAt: string;
  readonly observedAt: string;
  readonly redaction: EventRedactionMetadata;
}

export interface TaskTimelineEntry {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly message: TaskTimelineMessage;
}

export interface EventTimelineStatus {
  readonly task: { readonly id: string };
  readonly run: { readonly id: string } | null;
  readonly attempts: readonly { readonly id: string }[];
  readonly providerSessions: readonly {
    readonly id: string;
    readonly attemptId: string;
  }[];
}

export interface EventTimelineView<TStatus extends EventTimelineStatus> {
  readonly taskId: string;
  readonly status: TStatus;
  readonly rawObservations: readonly RawProviderObservationView[];
  readonly normalizedEvents: readonly NormalizedRuntimeEventView[];
  readonly timeline: readonly TaskTimelineEntry[];
}

export class EventTimelineContractError extends Error {}

export interface NormalizedEventInput {
  readonly taskId: string;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly providerSessionId: string | null;
  readonly kind: NormalizedRuntimeEventView['kind'];
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly sequence: number;
  readonly occurrenceAt: string;
  readonly observedAt: string;
  readonly causationId: string | null;
  readonly redaction?: EventRedactionMetadata;
}

export interface ProviderObservationInput {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly observedAt: string;
  readonly evidence: unknown;
}

export function allowlistProviderObservation(
  input: ProviderObservationInput,
): RawProviderObservationView {
  const evidence = object(input.evidence);
  if (evidence.provider !== 'claude' || evidence.kind !== 'provider-session-observed' ||
    evidence.sessionState !== 'active') fail();
  return {
    schema: PROVIDER_OBSERVATION_SCHEMA,
    version: EVENT_TIMELINE_SCHEMA_VERSION,
    id: observationId(input),
    taskId: identifier(input.taskId),
    provider: 'claude',
    kind: 'provider-session-observed',
    observedAt: timestamp(input.observedAt),
    evidence: { sessionState: 'active' },
    redaction: redactionFor(evidence),
  };
}

export function normalizedEvent(input: NormalizedEventInput): NormalizedRuntimeEventView {
  return parseNormalizedRuntimeEvent({
    schema: RUNTIME_EVENT_SCHEMA,
    version: EVENT_TIMELINE_SCHEMA_VERSION,
    id: normalizedEventId(input),
    taskId: input.taskId,
    runId: input.runId,
    attemptId: input.attemptId,
    providerSessionId: input.providerSessionId,
    kind: input.kind,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    sequence: input.sequence,
    occurrenceAt: input.occurrenceAt,
    observedAt: input.observedAt,
    redaction: input.redaction ?? { status: 'allowlisted', omittedFields: [] },
  });
}

export function timelineEntry(event: NormalizedRuntimeEventView): TaskTimelineEntry {
  return {
    eventId: event.id,
    sequence: event.sequence,
    occurredAt: event.occurrenceAt,
    message: EVENT_TIMELINE_MESSAGES[event.kind],
  };
}

export function parseRawProviderObservation(value: unknown): RawProviderObservationView {
  const record = object(value);
  exactKeys(record, [
    'schema', 'version', 'id', 'taskId', 'provider', 'kind', 'observedAt', 'evidence', 'redaction',
  ]);
  if (record.schema !== PROVIDER_OBSERVATION_SCHEMA ||
    record.version !== EVENT_TIMELINE_SCHEMA_VERSION || record.provider !== 'claude' ||
    record.kind !== 'provider-session-observed') fail();
  const evidence = object(record.evidence);
  exactKeys(evidence, ['sessionState']);
  if (evidence.sessionState !== 'active') fail();
  return {
    schema: PROVIDER_OBSERVATION_SCHEMA,
    version: EVENT_TIMELINE_SCHEMA_VERSION,
    id: identifier(record.id),
    taskId: identifier(record.taskId),
    provider: 'claude',
    kind: 'provider-session-observed',
    observedAt: timestamp(record.observedAt),
    evidence: { sessionState: 'active' },
    redaction: parseRedaction(record.redaction),
  };
}

export function parseNormalizedRuntimeEvent(value: unknown): NormalizedRuntimeEventView {
  const record = object(value);
  exactKeys(record, [
    'schema', 'version', 'id', 'taskId', 'runId', 'attemptId', 'providerSessionId', 'kind',
    'correlationId', 'causationId', 'idempotencyKey', 'sequence', 'occurrenceAt',
    'observedAt', 'redaction',
  ]);
  if (record.schema !== RUNTIME_EVENT_SCHEMA ||
    record.version !== EVENT_TIMELINE_SCHEMA_VERSION || typeof record.kind !== 'string' ||
    !(record.kind in EVENT_TIMELINE_MESSAGES)) fail();
  const kind = record.kind as NormalizedRuntimeEventView['kind'];
  const event = {
    schema: RUNTIME_EVENT_SCHEMA,
    version: EVENT_TIMELINE_SCHEMA_VERSION,
    id: identifier(record.id),
    taskId: identifier(record.taskId),
    runId: optionalIdentifier(record.runId),
    attemptId: optionalIdentifier(record.attemptId),
    providerSessionId: optionalIdentifier(record.providerSessionId),
    kind,
    correlationId: identifier(record.correlationId),
    causationId: optionalIdentifier(record.causationId),
    idempotencyKey: identifier(record.idempotencyKey),
    sequence: positiveInteger(record.sequence),
    occurrenceAt: timestamp(record.occurrenceAt),
    observedAt: timestamp(record.observedAt),
    redaction: parseRedaction(record.redaction),
  };
  assertApplicableIdentities(event);
  return event;
}

export function parseTaskTimeline<TStatus extends EventTimelineStatus>(
  value: unknown,
  parseStatus: (value: unknown) => TStatus,
): EventTimelineView<TStatus> {
  const record = object(value);
  exactKeys(record, ['taskId', 'status', 'rawObservations', 'normalizedEvents', 'timeline']);
  const taskId = identifier(record.taskId);
  const status = parseStatus(record.status);
  if (status.task.id !== taskId) fail();
  const rawObservations = array(record.rawObservations).map(parseRawProviderObservation);
  const normalizedEvents = array(record.normalizedEvents).map(parseNormalizedRuntimeEvent);
  const timeline = array(record.timeline).map(parseTimelineEntry);
  validateTimeline(taskId, status, rawObservations, normalizedEvents, timeline);
  return { taskId, status, rawObservations, normalizedEvents, timeline };
}

function validateTimeline(
  taskId: string,
  status: EventTimelineStatus,
  raw: readonly RawProviderObservationView[],
  events: readonly NormalizedRuntimeEventView[],
  entries: readonly TaskTimelineEntry[],
): void {
  if (
    raw.some((item) => item.taskId !== taskId) ||
    new Set(raw.map((item) => item.id)).size !== raw.length ||
    new Set(events.map((item) => item.id)).size !== events.length ||
    entries.length !== events.length
  ) {
    fail();
  }
  for (const [index, event] of events.entries()) {
    if (event.taskId !== taskId || event.sequence !== index + 1 ||
      JSON.stringify(entries[index]) !== JSON.stringify(timelineEntry(event))) fail();
    validateStatusIdentities(status, event);
    validateCausation(raw, events.slice(0, index), event);
  }
}

function validateStatusIdentities(
  status: EventTimelineStatus,
  event: NormalizedRuntimeEventView,
): void {
  if (event.kind === 'task-created') return;
  if (!status.run || event.runId !== status.run.id || !event.attemptId ||
    !status.attempts.some((attempt) => attempt.id === event.attemptId)) fail();
  if (event.providerSessionId) {
    const session = status.providerSessions.find((item) => item.id === event.providerSessionId);
    if (!session || session.attemptId !== event.attemptId) fail();
  }
}

function validateCausation(
  raw: readonly RawProviderObservationView[],
  prior: readonly NormalizedRuntimeEventView[],
  event: NormalizedRuntimeEventView,
): void {
  if (event.kind === 'task-created') {
    if (event.causationId !== null) fail();
    return;
  }
  if (event.kind === 'provider-session-observed') {
    const observation = raw.find((item) => item.id === event.causationId);
    if (!observation || observation.taskId !== event.taskId ||
      observation.observedAt !== event.observedAt || event.occurrenceAt !== event.observedAt ||
      JSON.stringify(observation.redaction) !== JSON.stringify(event.redaction)) fail();
    return;
  }
  if (!prior.some((candidate) => candidate.id === event.causationId)) fail();
}

function assertApplicableIdentities(event: NormalizedRuntimeEventView): void {
  if (event.kind === 'task-created') {
    if (event.runId !== null || event.attemptId !== null || event.providerSessionId !== null) fail();
  } else if (event.runId === null || event.attemptId === null) fail();
  if (event.kind === 'provider-session-observed' && event.providerSessionId === null) fail();
  if (event.kind !== 'task-created' && event.causationId === null) fail();
  if (event.kind !== 'provider-session-observed' &&
    (event.occurrenceAt !== event.observedAt || event.redaction.omittedFields.length !== 0)) fail();
}

function parseTimelineEntry(value: unknown): TaskTimelineEntry {
  const record = object(value);
  exactKeys(record, ['eventId', 'sequence', 'occurredAt', 'message']);
  if (!Object.values(EVENT_TIMELINE_MESSAGES).includes(record.message as TaskTimelineEntry['message'])) {
    fail();
  }
  return { eventId: identifier(record.eventId), sequence: positiveInteger(record.sequence),
    occurredAt: timestamp(record.occurredAt), message: record.message as TaskTimelineEntry['message'] };
}

function redactionFor(value: Record<string, unknown>): EventRedactionMetadata {
  const omitted = new Set<EventRedactionMetadata['omittedFields'][number]>();
  for (const key of Object.keys(value)) {
    if (key === 'provider' || key === 'kind' || key === 'sessionState') continue;
    omitted.add(redactionField(key));
  }
  return {
    status: 'allowlisted',
    omittedFields: EVENT_REDACTION_FIELDS.filter((field) => omitted.has(field)),
  };
}

function redactionField(key: string): EventRedactionMetadata['omittedFields'][number] {
  if (key === 'nativeSessionId' || key === 'capabilities' || key === 'providerNativeId' ||
    key === 'absolutePath' || key === 'command' || key === 'environment') return key;
  if (/secret|token|credential/i.test(key)) return 'secret';
  return 'unproven';
}

function parseRedaction(value: unknown): EventRedactionMetadata {
  const record = object(value);
  exactKeys(record, ['status', 'omittedFields']);
  if (record.status !== 'allowlisted') fail();
  const fields = array(record.omittedFields);
  const indexes = fields.map(indexOfField);
  if (indexes.some((index, position) => position > 0 && indexes[position - 1]! >= index)) fail();
  return { status: 'allowlisted', omittedFields: fields as EventRedactionMetadata['omittedFields'] };
}

function indexOfField(value: unknown): number {
  const index = EVENT_REDACTION_FIELDS.indexOf(
    value as (typeof EVENT_REDACTION_FIELDS)[number],
  );
  if (index < 0) fail();
  return index;
}

function observationId(input: ProviderObservationInput): string {
  return `provider-observation:${input.taskId}:${input.providerSessionId}:${input.idempotencyKey}`;
}

function normalizedEventId(input: NormalizedEventInput): string {
  return `runtime-event:${input.kind}:${input.taskId}:${input.attemptId ?? 'none'}:${input.providerSessionId ?? input.idempotencyKey}`;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail();
  return value;
}

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail();
  return value as number;
}

function timestamp(value: unknown): string {
  const result = identifier(value);
  if (!result.endsWith('Z') || !Number.isFinite(Date.parse(result))) fail();
  return result;
}

function fail(): never {
  throw new EventTimelineContractError('invalid event timeline');
}

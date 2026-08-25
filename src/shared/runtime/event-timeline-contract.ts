import { parseCanonicalUtcTimestamp } from './canonical-utc-timestamp';
import {
  compactDerivedRuntimeIdentifier,
  RUNTIME_IDENTIFIER_MAX_LENGTH,
} from './runtime-identifier';

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
  'cancellation-requested': 'Cancellation requested',
  'attempt-completed': 'Attempt completed',
  'attempt-failed': 'Attempt failed',
  'attempt-cancelled': 'Attempt cancelled',
} as const;

export type NormalizedRuntimeEventKind = keyof typeof EVENT_TIMELINE_MESSAGES;
export type TaskTimelineMessage = (typeof EVENT_TIMELINE_MESSAGES)[NormalizedRuntimeEventKind];

export function isNormalizedRuntimeEventKind(
  value: unknown,
): value is NormalizedRuntimeEventKind {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(EVENT_TIMELINE_MESSAGES, value);
}

export interface EventRedactionMetadata {
  readonly status: 'allowlisted';
  readonly omittedFields: readonly (typeof EVENT_REDACTION_FIELDS)[number][];
}

export interface RawProviderObservationView {
  readonly schema: typeof PROVIDER_OBSERVATION_SCHEMA;
  readonly version: typeof EVENT_TIMELINE_SCHEMA_VERSION;
  readonly id: string;
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
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
  readonly task: { readonly id: string; readonly executionState: EventTimelineLifecycleState };
  readonly run: { readonly id: string } | null;
  readonly attempt: { readonly id: string; readonly state: EventTimelineLifecycleState } | null;
  readonly attempts: readonly { readonly id: string; readonly state: EventTimelineLifecycleState }[];
  readonly executionContexts: readonly { readonly id: string }[];
  readonly providerSessions: readonly {
    readonly id: string;
    readonly attemptId: string;
    readonly executionContextId: string;
  }[];
}

type EventTimelineLifecycleState =
  | 'ready'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'superseding'
  | 'superseded';

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

export interface ProviderObservationIdentity {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
}

export interface TaskCreationIdentity {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface EventTimelineOperationIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface EventTimelineOperationChain {
  readonly attempts: readonly EventTimelineOperationIdentity[];
  readonly cancellation: EventTimelineOperationIdentity | null;
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
    providerSessionId: identifier(input.providerSessionId),
    idempotencyKey: identifier(input.idempotencyKey),
    provider: 'claude',
    kind: 'provider-session-observed',
    observedAt: timestamp(input.observedAt),
    evidence: { sessionState: 'active' },
    redaction: redactionFor(evidence),
  };
}

export function normalizedEvent(input: NormalizedEventInput): NormalizedRuntimeEventView {
  if (!isNormalizedRuntimeEventKind(input.kind)) fail();
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
  if (!isNormalizedRuntimeEventKind(event.kind)) fail();
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
    'schema', 'version', 'id', 'taskId', 'providerSessionId', 'idempotencyKey', 'provider',
    'kind', 'observedAt', 'evidence', 'redaction',
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
    providerSessionId: identifier(record.providerSessionId),
    idempotencyKey: identifier(record.idempotencyKey),
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
    record.version !== EVENT_TIMELINE_SCHEMA_VERSION ||
    !isNormalizedRuntimeEventKind(record.kind)) fail();
  const kind = record.kind;
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

export function assertCanonicalProviderObservationIdentity(
  observation: RawProviderObservationView,
  identity: ProviderObservationIdentity,
): void {
  if (observation.taskId !== identity.taskId ||
    observation.providerSessionId !== identity.providerSessionId ||
    observation.idempotencyKey !== identity.idempotencyKey ||
    observation.id !== observationId(identity)) fail();
}

export function assertCanonicalNormalizedEventIdentity(
  event: NormalizedRuntimeEventView,
  taskId: string,
): void {
  if (event.taskId !== taskId || event.id !== normalizedEventId(event)) fail();
}

export function assertCanonicalTaskCreatedIdentity(
  event: NormalizedRuntimeEventView,
  identity: TaskCreationIdentity,
): void {
  const expected = normalizedEvent({
    taskId: identity.taskId,
    runId: null,
    attemptId: null,
    providerSessionId: null,
    kind: 'task-created',
    correlationId: identity.correlationId,
    idempotencyKey: identity.idempotencyKey,
    sequence: 1,
    occurrenceAt: identity.createdAt,
    observedAt: identity.createdAt,
    causationId: null,
  });
  if (JSON.stringify(event) !== JSON.stringify(expected)) fail();
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
  assertEventTimelineHistory(taskId, status, raw, events);
  if (entries.length !== events.length) fail();
  for (const [index, event] of events.entries()) {
    if (JSON.stringify(entries[index]) !== JSON.stringify(timelineEntry(event))) fail();
  }
}

export function assertEventTimelineHistory(
  taskId: string,
  status: EventTimelineStatus,
  raw: readonly RawProviderObservationView[],
  events: readonly NormalizedRuntimeEventView[],
  operations?: EventTimelineOperationChain,
): void {
  assertEventTimelinePrefix(taskId, status, raw, events);
  if (operations) validateOperationIdentities(taskId, status, events, operations);
  validateLifecycleStatus(status, events);
}

export function assertEventTimelinePrefix(
  taskId: string,
  status: EventTimelineStatus,
  raw: readonly RawProviderObservationView[],
  events: readonly NormalizedRuntimeEventView[],
): void {
  if (
    events[0]?.kind !== 'task-created' ||
    events.filter((event) => event.kind === 'task-created').length !== 1 ||
    raw.some((item) => item.taskId !== taskId) ||
    new Set(raw.map((item) => item.id)).size !== raw.length ||
    new Set(events.map((item) => item.id)).size !== events.length ||
    raw.length !== events.filter((event) => event.kind === 'provider-session-observed').length
  ) {
    fail();
  }
  for (const [index, event] of events.entries()) {
    assertCanonicalNormalizedEventIdentity(event, taskId);
    if (event.taskId !== taskId || event.sequence !== index + 1) fail();
    validateStatusIdentities(status, event);
    validateCausation(raw, events.slice(0, index), event);
  }
  const linkedRawIds = new Set(events
    .filter((event) => event.kind === 'provider-session-observed')
    .map((event) => event.causationId));
  if (raw.some((observation) => !linkedRawIds.has(observation.id))) fail();
}

function validateOperationIdentities(
  taskId: string,
  status: EventTimelineStatus,
  events: readonly NormalizedRuntimeEventView[],
  operations: EventTimelineOperationChain,
): void {
  if (operations.attempts.length !== status.attempts.length ||
    new Set(operations.attempts.map((operation) => operation.attemptId)).size !==
      operations.attempts.length) fail();
  for (const operation of operations.attempts) {
    if (operation.taskId !== taskId || operation.runId !== status.run?.id ||
      !status.attempts.some((attempt) => attempt.id === operation.attemptId)) fail();
    const phases = events.filter((event) => event.attemptId === operation.attemptId &&
      (event.kind === 'provider-session-observed' || event.kind === 'attempt-started' ||
        event.kind === 'attempt-completed' || event.kind === 'attempt-failed'));
    if (phases.some((event) => event.taskId !== operation.taskId ||
      event.runId !== operation.runId ||
      event.idempotencyKey !== operation.idempotencyKey ||
      event.correlationId !== operation.correlationId)) fail();
  }
  const cancellationEvents = events.filter((event) =>
    event.kind === 'cancellation-requested' || event.kind === 'attempt-cancelled');
  if ((operations.cancellation === null) !== (cancellationEvents.length === 0)) fail();
  if (operations.cancellation && cancellationEvents.some((event) =>
    event.taskId !== operations.cancellation!.taskId ||
    event.runId !== operations.cancellation!.runId ||
    event.attemptId !== operations.cancellation!.attemptId ||
    event.idempotencyKey !== operations.cancellation!.idempotencyKey ||
    event.correlationId !== operations.cancellation!.correlationId)) fail();
}

function validateLifecycleStatus(
  status: EventTimelineStatus,
  events: readonly NormalizedRuntimeEventView[],
): void {
  const currentState = status.attempt?.state ?? (status.run ? 'starting' : 'ready');
  if (status.task.executionState !== currentState ||
    new Set(status.attempts.map((attempt) => attempt.id)).size !== status.attempts.length ||
    new Set(status.executionContexts.map((context) => context.id)).size !==
      status.executionContexts.length ||
    new Set(status.providerSessions.map((session) => session.id)).size !==
      status.providerSessions.length ||
    status.providerSessions.some((session) =>
      status.attempts.filter((attempt) => attempt.id === session.attemptId).length !== 1 ||
      status.executionContexts.filter((context) =>
        context.id === session.executionContextId).length !== 1)) fail();
  if (status.attempt) {
    const current = status.attempts.find((attempt) => attempt.id === status.attempt?.id);
    if (!current || current.state !== status.attempt.state) fail();
  }
  for (const attempt of status.attempts) {
    const lifecycle = events.filter((event) => event.attemptId === attempt.id);
    const starts = lifecycle.filter((event) => event.kind === 'attempt-started');
    const terminals = lifecycle.filter((event) =>
      event.kind === 'attempt-completed' || event.kind === 'attempt-failed' ||
      event.kind === 'attempt-cancelled');
    const cancellations = lifecycle.filter((event) => event.kind === 'cancellation-requested');
    const providerEvents = lifecycle.filter((event) => event.kind === 'provider-session-observed');
    if (starts.length > 1 || terminals.length > 1 || providerEvents.length > 1 ||
      cancellations.length > 1) fail();
    const providerIndex = providerEvents[0] ? events.indexOf(providerEvents[0]) : -1;
    const startIndex = starts[0] ? events.indexOf(starts[0]) : -1;
    const terminalIndex = terminals[0] ? events.indexOf(terminals[0]) : -1;
    const cancellationIndex = cancellations[0] ? events.indexOf(cancellations[0]) : -1;
    if ((providerIndex >= 0 && startIndex >= 0 && providerIndex >= startIndex) ||
      (terminalIndex >= 0 && (startIndex < 0 || startIndex >= terminalIndex))) fail();
    if (cancellationIndex >= 0 && (startIndex < 0 || startIndex >= cancellationIndex ||
      (terminalIndex >= 0 && cancellationIndex >= terminalIndex))) fail();
    if (attempt.state !== 'starting' && starts.length !== 1) fail();
    const expectedTerminal = terminalKind(attempt.state);
    const expectsCancellation = attempt.state === 'cancelling' || attempt.state === 'cancelled';
    if (cancellations.length !== (expectsCancellation ? 1 : 0)) fail();
    if ((expectedTerminal === null && terminals.length !== 0) ||
      (expectedTerminal !== null &&
        (terminals.length !== 1 || terminals[0]?.kind !== expectedTerminal))) fail();
  }
}

function terminalKind(
  state: EventTimelineLifecycleState,
): Extract<NormalizedRuntimeEventKind,
  'attempt-completed' | 'attempt-failed' | 'attempt-cancelled'> | null {
  if (state === 'completed') return 'attempt-completed';
  if (state === 'failed') return 'attempt-failed';
  if (state === 'cancelled') return 'attempt-cancelled';
  return null;
}

function validateStatusIdentities(
  status: EventTimelineStatus,
  event: NormalizedRuntimeEventView,
): void {
  if (event.kind === 'task-created') return;
  if (!status.run || event.runId !== status.run.id || !event.attemptId ||
    !status.attempts.some((attempt) => attempt.id === event.attemptId)) fail();
  const sessions = status.providerSessions.filter((item) => item.attemptId === event.attemptId);
  if (sessions.length > 1 || event.providerSessionId !== (sessions[0]?.id ?? null)) fail();
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
    if (!event.providerSessionId) fail();
    const expectedObservationId = observationId({
      taskId: event.taskId,
      providerSessionId: event.providerSessionId,
      idempotencyKey: event.idempotencyKey,
    });
    const observation = raw.find((item) => item.id === event.causationId);
    if (!observation || event.causationId !== expectedObservationId ||
      observation.taskId !== event.taskId ||
      observation.providerSessionId !== event.providerSessionId ||
      observation.idempotencyKey !== event.idempotencyKey ||
      observation.observedAt !== event.observedAt || event.occurrenceAt !== event.observedAt ||
      JSON.stringify(observation.redaction) !== JSON.stringify(event.redaction)) fail();
    return;
  }
  if (event.kind === 'attempt-started') {
    const cause = event.providerSessionId
      ? prior.find((candidate) => candidate.kind === 'provider-session-observed' &&
          candidate.attemptId === event.attemptId &&
          candidate.providerSessionId === event.providerSessionId)
      : prior.find((candidate) => candidate.kind === 'task-created');
    if (!cause || event.causationId !== cause.id ||
      (event.providerSessionId !== null &&
        (event.idempotencyKey !== cause.idempotencyKey ||
          event.correlationId !== cause.correlationId))) fail();
    return;
  }
  validatePostStartCausation(prior, event);
}

function validatePostStartCausation(
  prior: readonly NormalizedRuntimeEventView[],
  event: NormalizedRuntimeEventView,
): void {
  if (event.kind === 'cancellation-requested') {
    const started = prior.find((candidate) => candidate.kind === 'attempt-started' &&
      candidate.attemptId === event.attemptId);
    if (!started || event.causationId !== started.id) fail();
    return;
  }
  if (event.kind === 'attempt-cancelled') {
    const cancellation = prior.find((candidate) => candidate.kind === 'cancellation-requested' &&
      candidate.attemptId === event.attemptId);
    if (!cancellation || event.causationId !== cancellation.id ||
      event.idempotencyKey !== cancellation.idempotencyKey ||
      event.correlationId !== cancellation.correlationId) fail();
    return;
  }
  const started = prior.find((candidate) => candidate.kind === 'attempt-started' &&
    candidate.attemptId === event.attemptId);
  if (!started || event.causationId !== started.id ||
    event.idempotencyKey !== started.idempotencyKey ||
    event.correlationId !== started.correlationId) fail();
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

function observationId(input: ProviderObservationIdentity): string {
  return compactDerivedRuntimeIdentifier(
    `provider-observation:${input.taskId}:${input.providerSessionId}:${input.idempotencyKey}`,
  );
}

function normalizedEventId(input: NormalizedEventInput): string {
  return compactDerivedRuntimeIdentifier(
    `runtime-event:${input.kind}:${input.taskId}:${input.attemptId ?? 'none'}:` +
      `${input.providerSessionId ?? input.idempotencyKey}`,
  );
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
  if (typeof value !== 'string' || value.length === 0 ||
    value.length > RUNTIME_IDENTIFIER_MAX_LENGTH) fail();
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
  try {
    return parseCanonicalUtcTimestamp(value);
  } catch {
    fail();
  }
}

function fail(): never {
  throw new EventTimelineContractError('invalid event timeline');
}

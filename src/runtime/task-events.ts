import {
  RUNTIME_IDENTIFIER_MAX_LENGTH,
  TASK_PROVIDERS,
  type ProviderSessionView,
  type TaskExecutionState,
  type TaskRecoveryView,
  type TaskRecoveryDecisionView,
  type TaskView,
  type NormalizedRuntimeEventView,
  type RawProviderObservationView,
} from '../shared/runtime/runtime-interface';
import {
  assertCanonicalNormalizedEventIdentity,
  assertCanonicalProviderObservationIdentity,
  parseNormalizedRuntimeEvent,
  parseRawProviderObservation,
} from '../shared/runtime/event-timeline-contract';
import { parseCanonicalUtcTimestamp } from '../shared/runtime/canonical-utc-timestamp';
import type {
  ProviderActionDecision,
  ProviderActionRejection,
  ProviderSessionAction,
  ProviderSessionActionDecidedEvent,
  ProviderSessionActionAbortedEvent,
} from './provider-session-lifecycle';
import {
  parseRecoveryDecisionView,
  parseRecoveryView,
} from './recovery-view-parser';
import { assertProviderActionFingerprint } from './provider-action-identity';

const TASK_PROVIDER_SET = new Set<string>(TASK_PROVIDERS);
const DURABLE_EVENT_TOKEN_MAX_LENGTH = 64;
const TASK_TEXT_MAX_LENGTH = 512;
const RUNTIME_REFERENCE_MAX_LENGTH = 512;
const DURABLE_FINGERPRINT_MAX_LENGTH = 4096;

export interface StoredRun {
  readonly id: string;
  readonly number: number;
}

export interface StoredAttempt {
  readonly id: string;
  readonly number: number;
  readonly state: TaskExecutionState;
  readonly exitCode?: number;
}

export interface StoredContext {
  readonly id: string;
  readonly worktreeId: string;
  readonly branchName: string;
  readonly baseCommit: string;
  readonly processId: string;
  readonly ptyId: string;
}

export interface StoredProviderSession {
  readonly id: string;
  readonly provider: 'claude';
  readonly nativeSessionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionContextId: string;
  readonly capabilities: { readonly resume: boolean; readonly fork: boolean };
  readonly parentId: string | null;
  readonly lineage: ProviderSessionView['lineage'];
}

export interface TaskCreatedEvent {
  readonly type: 'TaskCreated';
  readonly version: 1;
  readonly task: TaskView;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly fingerprint: string;
}

export interface RunCreatedEvent {
  readonly type: 'RunCreated';
  readonly version: 1;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly fingerprint: string;
  readonly run: StoredRun;
}

export interface AttemptCreatedEvent {
  readonly type: 'AttemptCreated';
  readonly version: 1;
  readonly taskId: string;
  readonly attempt: StoredAttempt;
}

export interface ContextAllocatedEvent {
  readonly type: 'ContextAllocated';
  readonly version: 1;
  readonly taskId: string;
  readonly context: StoredContext;
  readonly providerSession: StoredProviderSession | null;
  /** Missing only on legacy records whose context-only prefix is intentionally ambiguous. */
  readonly launchOutcome?: 'succeeded' | 'failed';
  /** Missing only on legacy records written before provider observation time was durable. */
  readonly observedAt?: string;
}

export interface RawProviderObservationRecordedEvent {
  readonly type: 'RawProviderObservationRecorded';
  readonly version: 1;
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
  readonly observation: RawProviderObservationView;
}

export interface NormalizedRuntimeEventRecordedEvent {
  readonly type: 'NormalizedRuntimeEventRecorded';
  readonly version: 1;
  readonly taskId: string;
  readonly event: NormalizedRuntimeEventView;
}

export type SupersessionReason = 'native-resume' | 'fork';

export interface AttemptSupersessionRequestedEvent {
  readonly type: 'AttemptSupersessionRequested';
  readonly version: 1;
  readonly taskId: string;
  readonly actionKey: string;
  readonly parentAttemptId: string;
  readonly parentSessionId: string;
  readonly reason: SupersessionReason;
}

export interface AttemptSupersededEvent {
  readonly type: 'AttemptSuperseded';
  readonly version: 1;
  readonly taskId: string;
  readonly actionKey: string;
  readonly attemptId: string;
  readonly reason: SupersessionReason;
}

export interface AttemptResumedEvent {
  readonly type: 'AttemptResumed';
  readonly version: 1;
  readonly taskId: string;
  readonly attempt: StoredAttempt;
  readonly sourceAttemptId: string;
  readonly sourceSessionId: string;
  readonly actionKey: string;
  readonly correlationId: string;
  readonly plannedContext: StoredContext;
}

export interface AttemptForkedEvent {
  readonly type: 'AttemptForked';
  readonly version: 1;
  readonly taskId: string;
  readonly attempt: StoredAttempt;
  readonly parentAttemptId: string;
  readonly parentSessionId: string;
  readonly forkKey: string;
  readonly correlationId: string;
  readonly plannedContext?: StoredContext;
}

interface TaskIdEvent {
  readonly version: 1;
  readonly taskId: string;
}

interface TimedTaskIdEvent extends TaskIdEvent {
  /** Missing only on legacy records written before lifecycle time was durable. */
  readonly occurredAt?: string;
}

export interface AttemptStartedEvent extends TimedTaskIdEvent { readonly type: 'AttemptStarted' }
export interface AttemptFailedEvent extends TimedTaskIdEvent { readonly type: 'AttemptFailed' }
export interface AttemptCancelledEvent extends TimedTaskIdEvent { readonly type: 'AttemptCancelled' }

export interface AttemptCompletedEvent extends TimedTaskIdEvent {
  readonly type: 'AttemptCompleted';
  readonly exitCode: number;
}

export interface CancellationRequestedEvent extends TaskIdEvent {
  readonly type: 'CancellationRequested';
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly fingerprint: string;
  /** Missing only on legacy records written before lifecycle time was durable. */
  readonly occurredAt?: string;
}

export interface TaskReconciledEvent extends TaskIdEvent {
  readonly type: 'TaskReconciled';
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly recovery: TaskRecoveryView;
}

export interface TaskRecoveryDecidedEvent extends TaskIdEvent {
  readonly type: 'TaskRecoveryDecided';
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly result: TaskRecoveryDecisionView;
}

export type TaskEvent =
  | TaskCreatedEvent | RunCreatedEvent | AttemptCreatedEvent | ContextAllocatedEvent
  | RawProviderObservationRecordedEvent | NormalizedRuntimeEventRecordedEvent
  | AttemptStartedEvent | AttemptCompletedEvent | AttemptFailedEvent
  | CancellationRequestedEvent | AttemptCancelledEvent
  | AttemptForkedEvent
  | AttemptSupersessionRequestedEvent | AttemptSupersededEvent | AttemptResumedEvent
  | ProviderSessionActionDecidedEvent | ProviderSessionActionAbortedEvent
  | TaskReconciledEvent | TaskRecoveryDecidedEvent;

export function parseTaskEvent(payload: Buffer): TaskEvent {
  const value = object(JSON.parse(payload.toString('utf8')));
  const type = eventToken(value.type);
  if (value.version !== 1) throw new Error('invalid event');
  return type === 'TaskCreated' ? parseTaskCreated(value) : parseExecutionEvent(value, type);
}

function parseTaskCreated(value: Record<string, unknown>): TaskCreatedEvent {
  exactKeys(value, [
    'type', 'version', 'task', 'idempotencyKey', 'correlationId', 'fingerprint',
  ]);
  const idempotencyKey = identity(value.idempotencyKey);
  return {
    type: 'TaskCreated', version: 1, task: parseTask(object(value.task)),
    idempotencyKey,
    correlationId: correlation(value.correlationId, idempotencyKey),
    fingerprint: fingerprint(value.fingerprint),
  };
}

function parseExecutionEvent(value: Record<string, unknown>, type: string): TaskEvent {
  const taskId = identity(value.taskId);
  if (type === 'RunCreated') return parseRunCreated(value, taskId);
  if (type === 'AttemptCreated') return parseAttemptCreated(value, taskId);
  if (type === 'AttemptForked') return parseAttemptForked(value, taskId);
  if (type === 'AttemptResumed') return parseAttemptResumed(value, taskId);
  if (type === 'ProviderSessionActionDecided') return parseProviderActionDecided(value, taskId);
  if (type === 'ProviderSessionActionAborted') {
    exactKeys(value, ['type', 'version', 'taskId', 'idempotencyKey', 'reason']);
    if (value.reason !== 'parent-still-live') throw new Error('invalid event');
    return { type, version: 1, taskId,
      idempotencyKey: identity(value.idempotencyKey), reason: value.reason };
  }
  if (type === 'AttemptSupersessionRequested') return parseSupersessionRequested(value, taskId);
  if (type === 'AttemptSuperseded') return parseAttemptSuperseded(value, taskId);
  if (type === 'ContextAllocated') return parseContextAllocated(value, taskId);
  if (type === 'RawProviderObservationRecorded') return parseRawProviderObservationRecorded(value, taskId);
  if (type === 'NormalizedRuntimeEventRecorded') return parseNormalizedRuntimeEventRecorded(value, taskId);
  if (type === 'TaskReconciled') return parseTaskReconciled(value, taskId);
  if (type === 'TaskRecoveryDecided') return parseTaskRecoveryDecided(value, taskId);
  if (type === 'AttemptStarted' || type === 'AttemptFailed' || type === 'AttemptCancelled') {
    exactKeys(value, ['type', 'version', 'taskId', 'occurredAt']);
    return { type, version: 1, taskId, ...parseOptionalOccurrence(value) };
  }
  if (type === 'AttemptCompleted') {
    exactKeys(value, ['type', 'version', 'taskId', 'exitCode', 'occurredAt']);
    return { type, version: 1, taskId,
      exitCode: integer(value.exitCode), ...parseOptionalOccurrence(value) };
  }
  if (type === 'CancellationRequested') return parseCancellation(value, taskId);
  throw new Error('invalid event');
}

function parseAttemptCreated(
  value: Record<string, unknown>,
  taskId: string,
): AttemptCreatedEvent {
  exactKeys(value, ['type', 'version', 'taskId', 'attempt']);
  return { type: 'AttemptCreated', version: 1, taskId,
    attempt: parseAttempt(object(value.attempt)) };
}

function parseRawProviderObservationRecorded(
  value: Record<string, unknown>,
  taskId: string,
): RawProviderObservationRecordedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'providerSessionId', 'idempotencyKey', 'observation',
  ]);
  const providerSessionId = identity(value.providerSessionId);
  const idempotencyKey = identity(value.idempotencyKey);
  const observation = parseRawProviderObservation(value.observation);
  assertCanonicalProviderObservationIdentity(
    observation,
    { taskId, providerSessionId, idempotencyKey },
  );
  return {
    type: 'RawProviderObservationRecorded', version: 1, taskId,
    providerSessionId, idempotencyKey, observation,
  };
}

function parseNormalizedRuntimeEventRecorded(
  value: Record<string, unknown>,
  taskId: string,
): NormalizedRuntimeEventRecordedEvent {
  exactKeys(value, ['type', 'version', 'taskId', 'event']);
  const event = parseNormalizedRuntimeEvent(value.event);
  assertCanonicalNormalizedEventIdentity(event, taskId);
  return { type: 'NormalizedRuntimeEventRecorded', version: 1, taskId, event };
}

function parseTaskRecoveryDecided(
  value: Record<string, unknown>,
  taskId: string,
): TaskRecoveryDecidedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'idempotencyKey', 'fingerprint', 'result',
  ]);
  const result = parseRecoveryDecisionView(value.result);
  if (result.taskId !== taskId) throw new Error('invalid recovery decision');
  return { type: 'TaskRecoveryDecided', version: 1, taskId,
    idempotencyKey: identity(value.idempotencyKey),
    fingerprint: fingerprint(value.fingerprint), result };
}

function parseTaskReconciled(
  value: Record<string, unknown>,
  taskId: string,
): TaskReconciledEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'idempotencyKey', 'fingerprint', 'recovery',
  ]);
  const recovery = parseRecoveryView(value.recovery);
  if (recovery.taskId !== taskId) throw new Error('invalid recovery');
  return { type: 'TaskReconciled', version: 1, taskId,
    idempotencyKey: identity(value.idempotencyKey),
    fingerprint: fingerprint(value.fingerprint), recovery };
}

function parseProviderActionDecided(
  value: Record<string, unknown>,
  taskId: string,
): ProviderSessionActionDecidedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'action', 'providerSessionId', 'idempotencyKey',
    'correlationId', 'fingerprint', 'outcome', 'decision', 'reason',
  ]);
  const outcome = value.outcome;
  if (outcome !== 'accepted' && outcome !== 'rejected') throw new Error('invalid event');
  const decision = optionalDecision(value.decision);
  const reason = optionalActionRejection(value.reason);
  if ((outcome === 'accepted') !== (decision !== null) ||
    (outcome === 'rejected') !== (reason !== null)) throw new Error('invalid event');
  const action = providerAction(value.action);
  if (outcome === 'accepted' && !(
    (action === 'resume' && (decision === 'exact-reattach' || decision === 'native-resume')) ||
    (action === 'fork' && decision === 'fork')
  )) throw new Error('invalid event');
  const idempotencyKey = identity(value.idempotencyKey);
  const event: ProviderSessionActionDecidedEvent = {
    type: 'ProviderSessionActionDecided', version: 1, taskId,
    action, providerSessionId: identity(value.providerSessionId),
    idempotencyKey,
    correlationId: correlation(value.correlationId, idempotencyKey),
    fingerprint: fingerprint(value.fingerprint),
    outcome, decision, reason };
  assertProviderActionFingerprint(event);
  return event;
}

function providerAction(value: unknown): ProviderSessionAction {
  if (value !== 'resume' && value !== 'fork') throw new Error('invalid event');
  return value;
}

function optionalDecision(value: unknown): ProviderActionDecision | null {
  if (value === null) return null;
  if (value !== 'exact-reattach' && value !== 'native-resume' && value !== 'fork') {
    throw new Error('invalid event');
  }
  return value;
}

function optionalActionRejection(value: unknown): ProviderActionRejection | null {
  if (value === null) return null;
  if (value !== 'not-found' && value !== 'task-not-ready' &&
    value !== 'unsupported-operation') throw new Error('invalid event');
  return value;
}

function parseAttemptResumed(
  value: Record<string, unknown>,
  taskId: string,
): AttemptResumedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'attempt', 'sourceAttemptId', 'sourceSessionId',
    'actionKey', 'correlationId', 'plannedContext',
  ]);
  return { type: 'AttemptResumed', version: 1, taskId,
    attempt: parseAttempt(object(value.attempt)), sourceAttemptId: identity(value.sourceAttemptId),
    sourceSessionId: identity(value.sourceSessionId), actionKey: identity(value.actionKey),
    correlationId: correlation(value.correlationId, identity(value.actionKey)),
    plannedContext: parseContext(object(value.plannedContext)) };
}

function parseSupersessionRequested(
  value: Record<string, unknown>,
  taskId: string,
): AttemptSupersessionRequestedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'actionKey', 'parentAttemptId', 'parentSessionId', 'reason',
  ]);
  return { type: 'AttemptSupersessionRequested', version: 1, taskId,
    actionKey: identity(value.actionKey), parentAttemptId: identity(value.parentAttemptId),
    parentSessionId: identity(value.parentSessionId), reason: supersessionReason(value.reason) };
}

function parseAttemptSuperseded(
  value: Record<string, unknown>,
  taskId: string,
): AttemptSupersededEvent {
  exactKeys(value, ['type', 'version', 'taskId', 'actionKey', 'attemptId', 'reason']);
  return { type: 'AttemptSuperseded', version: 1, taskId,
    actionKey: identity(value.actionKey), attemptId: identity(value.attemptId),
    reason: supersessionReason(value.reason) };
}

function supersessionReason(value: unknown): SupersessionReason {
  if (value !== 'native-resume' && value !== 'fork') throw new Error('invalid event');
  return value;
}

function parseRunCreated(value: Record<string, unknown>, taskId: string): RunCreatedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'idempotencyKey', 'correlationId', 'fingerprint', 'run',
  ]);
  const idempotencyKey = identity(value.idempotencyKey);
  return { type: 'RunCreated', version: 1, taskId,
    idempotencyKey,
    correlationId: correlation(value.correlationId, idempotencyKey),
    fingerprint: fingerprint(value.fingerprint),
    run: parseRun(object(value.run)) };
}

function parseAttemptForked(value: Record<string, unknown>, taskId: string): AttemptForkedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'attempt', 'parentAttemptId', 'parentSessionId',
    'forkKey', 'correlationId', 'plannedContext',
  ]);
  const plannedContext = value.plannedContext === undefined
    ? undefined
    : parseContext(object(value.plannedContext));
  const forkKey = identity(value.forkKey);
  return { type: 'AttemptForked', version: 1, taskId, attempt: parseAttempt(object(value.attempt)),
    parentAttemptId: identity(value.parentAttemptId),
    parentSessionId: identity(value.parentSessionId),
    forkKey, correlationId: correlation(value.correlationId, forkKey),
    ...(plannedContext ? { plannedContext } : {}) };
}

function parseContextAllocated(value: Record<string, unknown>, taskId: string): ContextAllocatedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'context', 'providerSession', 'launchOutcome', 'observedAt',
  ]);
  if (!Object.hasOwn(value, 'providerSession')) throw new Error('invalid event');
  const providerSession = value.providerSession === null
    ? null : parseProviderSession(object(value.providerSession));
  return { type: 'ContextAllocated', version: 1, taskId,
    context: parseContext(object(value.context)), providerSession,
    ...parseOptionalLaunchOutcome(value.launchOutcome),
    ...(value.observedAt === undefined ? {} : {
      observedAt: parseCanonicalUtcTimestamp(value.observedAt),
    }) };
}

function parseOptionalLaunchOutcome(
  value: unknown,
): { readonly launchOutcome?: 'succeeded' | 'failed' } {
  if (value === undefined) return {};
  if (value !== 'succeeded' && value !== 'failed') throw new Error('invalid event');
  return { launchOutcome: value };
}

function parseCancellation(value: Record<string, unknown>, taskId: string): CancellationRequestedEvent {
  exactKeys(value, [
    'type', 'version', 'taskId', 'idempotencyKey', 'correlationId', 'fingerprint', 'occurredAt',
  ]);
  const idempotencyKey = identity(value.idempotencyKey);
  return { type: 'CancellationRequested', version: 1, taskId,
    idempotencyKey,
    correlationId: correlation(value.correlationId, idempotencyKey),
    fingerprint: fingerprint(value.fingerprint), ...parseOptionalOccurrence(value) };
}

function parseOptionalOccurrence(
  value: Record<string, unknown>,
): { readonly occurredAt?: string } {
  if (value.occurredAt === undefined) return {};
  return { occurredAt: parseCanonicalUtcTimestamp(value.occurredAt) };
}

function correlation(value: unknown, legacyIdempotencyKey: string): string {
  return value === undefined ? legacyIdempotencyKey : identity(value);
}

function parseTask(value: Record<string, unknown>): TaskView {
  exactKeys(value, [
    'id', 'objective', 'project', 'repository', 'baseRef', 'provider', 'createdAt',
  ]);
  const provider = eventToken(value.provider);
  if (!TASK_PROVIDER_SET.has(provider)) throw new Error('invalid event');
  return { id: identity(value.id), objective: taskText(value.objective),
    project: taskText(value.project), repository: referenceText(value.repository),
    baseRef: referenceText(value.baseRef),
    provider: provider as TaskView['provider'],
    createdAt: parseCanonicalUtcTimestamp(value.createdAt) };
}

function parseRun(value: Record<string, unknown>): StoredRun {
  exactKeys(value, ['id', 'number']);
  return { id: identity(value.id), number: positiveInteger(value.number) };
}

function parseAttempt(value: Record<string, unknown>): StoredAttempt {
  exactKeys(value, ['id', 'number', 'state', 'exitCode']);
  const state = eventToken(value.state) as TaskExecutionState;
  if (!['starting', 'running', 'completed', 'failed', 'cancelling', 'cancelled', 'superseding', 'superseded'].includes(state)) throw new Error('invalid attempt');
  const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode);
  return { id: identity(value.id), number: positiveInteger(value.number), state,
    ...(exitCode === undefined ? {} : { exitCode }) };
}

function parseContext(value: Record<string, unknown>): StoredContext {
  exactKeys(value, ['id', 'worktreeId', 'branchName', 'baseCommit', 'processId', 'ptyId']);
  return { id: identity(value.id), worktreeId: identity(value.worktreeId),
    branchName: referenceText(value.branchName), baseCommit: referenceText(value.baseCommit),
    processId: identity(value.processId), ptyId: identity(value.ptyId) };
}

function parseProviderSession(value: Record<string, unknown>): StoredProviderSession {
  exactKeys(value, [
    'id', 'provider', 'nativeSessionId', 'taskId', 'attemptId', 'executionContextId',
    'capabilities', 'parentId', 'lineage',
  ]);
  const capabilities = object(value.capabilities);
  exactKeys(capabilities, ['resume', 'fork']);
  if (value.provider !== 'claude' || typeof capabilities.resume !== 'boolean' || typeof capabilities.fork !== 'boolean') throw new Error('invalid provider session');
  const parentId = value.parentId === null ? null : identity(value.parentId);
  const lineage = value.lineage === undefined
    ? (parentId === null ? 'new' : 'fork')
    : parseLineage(value.lineage);
  return { id: identity(value.id), provider: 'claude',
    nativeSessionId: identity(value.nativeSessionId), taskId: identity(value.taskId),
    attemptId: identity(value.attemptId), executionContextId: identity(value.executionContextId),
    capabilities: { resume: capabilities.resume, fork: capabilities.fork }, parentId, lineage };
}

function parseLineage(value: unknown): StoredProviderSession['lineage'] {
  if (value !== 'new' && value !== 'native-resume' && value !== 'fork') {
    throw new Error('invalid provider session');
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
  return value as Record<string, unknown>;
}

function identity(value: unknown): string {
  return boundedString(value, RUNTIME_IDENTIFIER_MAX_LENGTH);
}

function eventToken(value: unknown): string {
  return boundedString(value, DURABLE_EVENT_TOKEN_MAX_LENGTH);
}

function taskText(value: unknown): string {
  return boundedString(value, TASK_TEXT_MAX_LENGTH);
}

function referenceText(value: unknown): string {
  return boundedString(value, RUNTIME_REFERENCE_MAX_LENGTH);
}

function fingerprint(value: unknown): string {
  return boundedString(value, DURABLE_FINGERPRINT_MAX_LENGTH);
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error('invalid string');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid integer');
  return value as number;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('invalid integer');
  return value as number;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('invalid event');
}

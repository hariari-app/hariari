import type {
  ProviderSessionView,
  TaskExecutionState,
  TaskView,
} from '../shared/runtime/runtime-interface';
import type {
  ProviderActionDecision,
  ProviderActionRejection,
  ProviderSessionAction,
  ProviderSessionActionDecidedEvent,
  ProviderSessionActionAbortedEvent,
} from './provider-session-lifecycle';

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
  readonly fingerprint: string;
}

export interface RunCreatedEvent {
  readonly type: 'RunCreated';
  readonly version: 1;
  readonly taskId: string;
  readonly idempotencyKey: string;
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
  readonly plannedContext?: StoredContext;
}

interface TaskIdEvent {
  readonly version: 1;
  readonly taskId: string;
}

export interface AttemptStartedEvent extends TaskIdEvent { readonly type: 'AttemptStarted' }
export interface AttemptFailedEvent extends TaskIdEvent { readonly type: 'AttemptFailed' }
export interface AttemptCancelledEvent extends TaskIdEvent { readonly type: 'AttemptCancelled' }

export interface AttemptCompletedEvent extends TaskIdEvent {
  readonly type: 'AttemptCompleted';
  readonly exitCode: number;
}

export interface CancellationRequestedEvent extends TaskIdEvent {
  readonly type: 'CancellationRequested';
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

export type TaskEvent =
  | TaskCreatedEvent | RunCreatedEvent | AttemptCreatedEvent | ContextAllocatedEvent
  | AttemptStartedEvent | AttemptCompletedEvent | AttemptFailedEvent
  | CancellationRequestedEvent | AttemptCancelledEvent
  | AttemptForkedEvent
  | AttemptSupersessionRequestedEvent | AttemptSupersededEvent | AttemptResumedEvent
  | ProviderSessionActionDecidedEvent | ProviderSessionActionAbortedEvent;

export function parseTaskEvent(payload: Buffer): TaskEvent {
  const value = object(JSON.parse(payload.toString('utf8')));
  const type = string(value.type);
  if (value.version !== 1) throw new Error('invalid event');
  return type === 'TaskCreated' ? parseTaskCreated(value) : parseExecutionEvent(value, type);
}

function parseTaskCreated(value: Record<string, unknown>): TaskCreatedEvent {
  return {
    type: 'TaskCreated', version: 1, task: parseTask(object(value.task)),
    idempotencyKey: string(value.idempotencyKey), fingerprint: string(value.fingerprint),
  };
}

function parseExecutionEvent(value: Record<string, unknown>, type: string): TaskEvent {
  const taskId = string(value.taskId);
  if (type === 'RunCreated') return parseRunCreated(value, taskId);
  if (type === 'AttemptCreated') return { type, version: 1, taskId, attempt: parseAttempt(object(value.attempt)) };
  if (type === 'AttemptForked') return parseAttemptForked(value, taskId);
  if (type === 'AttemptResumed') return parseAttemptResumed(value, taskId);
  if (type === 'ProviderSessionActionDecided') return parseProviderActionDecided(value, taskId);
  if (type === 'ProviderSessionActionAborted') {
    if (value.reason !== 'parent-still-live') throw new Error('invalid event');
    return { type, version: 1, taskId,
      idempotencyKey: string(value.idempotencyKey), reason: value.reason };
  }
  if (type === 'AttemptSupersessionRequested') return parseSupersessionRequested(value, taskId);
  if (type === 'AttemptSuperseded') return parseAttemptSuperseded(value, taskId);
  if (type === 'ContextAllocated') return parseContextAllocated(value, taskId);
  if (type === 'AttemptStarted' || type === 'AttemptFailed' || type === 'AttemptCancelled') {
    return { type, version: 1, taskId };
  }
  if (type === 'AttemptCompleted') return { type, version: 1, taskId, exitCode: integer(value.exitCode) };
  if (type === 'CancellationRequested') return parseCancellation(value, taskId);
  throw new Error('invalid event');
}

function parseProviderActionDecided(
  value: Record<string, unknown>,
  taskId: string,
): ProviderSessionActionDecidedEvent {
  const outcome = value.outcome;
  if (outcome !== 'accepted' && outcome !== 'rejected') throw new Error('invalid event');
  const decision = optionalDecision(value.decision);
  const reason = optionalActionRejection(value.reason);
  if ((outcome === 'accepted') !== (decision !== null) ||
    (outcome === 'rejected') !== (reason !== null)) throw new Error('invalid event');
  return { type: 'ProviderSessionActionDecided', version: 1, taskId,
    action: providerAction(value.action), providerSessionId: string(value.providerSessionId),
    idempotencyKey: string(value.idempotencyKey), fingerprint: string(value.fingerprint),
    outcome, decision, reason };
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
  return { type: 'AttemptResumed', version: 1, taskId,
    attempt: parseAttempt(object(value.attempt)), sourceAttemptId: string(value.sourceAttemptId),
    sourceSessionId: string(value.sourceSessionId), actionKey: string(value.actionKey),
    plannedContext: parseContext(object(value.plannedContext)) };
}

function parseSupersessionRequested(
  value: Record<string, unknown>,
  taskId: string,
): AttemptSupersessionRequestedEvent {
  return { type: 'AttemptSupersessionRequested', version: 1, taskId,
    actionKey: string(value.actionKey), parentAttemptId: string(value.parentAttemptId),
    parentSessionId: string(value.parentSessionId), reason: supersessionReason(value.reason) };
}

function parseAttemptSuperseded(
  value: Record<string, unknown>,
  taskId: string,
): AttemptSupersededEvent {
  return { type: 'AttemptSuperseded', version: 1, taskId,
    actionKey: string(value.actionKey), attemptId: string(value.attemptId),
    reason: supersessionReason(value.reason) };
}

function supersessionReason(value: unknown): SupersessionReason {
  if (value !== 'native-resume' && value !== 'fork') throw new Error('invalid event');
  return value;
}

function parseRunCreated(value: Record<string, unknown>, taskId: string): RunCreatedEvent {
  return { type: 'RunCreated', version: 1, taskId,
    idempotencyKey: string(value.idempotencyKey), fingerprint: string(value.fingerprint),
    run: parseRun(object(value.run)) };
}

function parseAttemptForked(value: Record<string, unknown>, taskId: string): AttemptForkedEvent {
  const plannedContext = value.plannedContext === undefined
    ? undefined
    : parseContext(object(value.plannedContext));
  return { type: 'AttemptForked', version: 1, taskId, attempt: parseAttempt(object(value.attempt)),
    parentAttemptId: string(value.parentAttemptId), parentSessionId: string(value.parentSessionId),
    forkKey: string(value.forkKey), ...(plannedContext ? { plannedContext } : {}) };
}

function parseContextAllocated(value: Record<string, unknown>, taskId: string): ContextAllocatedEvent {
  const providerSession = value.providerSession === undefined || value.providerSession === null
    ? null : parseProviderSession(object(value.providerSession));
  return { type: 'ContextAllocated', version: 1, taskId,
    context: parseContext(object(value.context)), providerSession };
}

function parseCancellation(value: Record<string, unknown>, taskId: string): CancellationRequestedEvent {
  return { type: 'CancellationRequested', version: 1, taskId,
    idempotencyKey: string(value.idempotencyKey), fingerprint: string(value.fingerprint) };
}

function parseTask(value: Record<string, unknown>): TaskView {
  return { id: string(value.id), objective: string(value.objective), project: string(value.project),
    repository: string(value.repository), baseRef: string(value.baseRef),
    provider: string(value.provider) as TaskView['provider'], createdAt: string(value.createdAt) };
}

function parseRun(value: Record<string, unknown>): StoredRun {
  return { id: string(value.id), number: positiveInteger(value.number) };
}

function parseAttempt(value: Record<string, unknown>): StoredAttempt {
  const state = string(value.state) as TaskExecutionState;
  if (!['starting', 'running', 'completed', 'failed', 'cancelling', 'cancelled', 'superseding', 'superseded'].includes(state)) throw new Error('invalid attempt');
  const exitCode = value.exitCode === undefined ? undefined : integer(value.exitCode);
  return { id: string(value.id), number: positiveInteger(value.number), state,
    ...(exitCode === undefined ? {} : { exitCode }) };
}

function parseContext(value: Record<string, unknown>): StoredContext {
  return { id: string(value.id), worktreeId: string(value.worktreeId),
    branchName: string(value.branchName), baseCommit: string(value.baseCommit),
    processId: string(value.processId), ptyId: string(value.ptyId) };
}

function parseProviderSession(value: Record<string, unknown>): StoredProviderSession {
  const capabilities = object(value.capabilities);
  if (value.provider !== 'claude' || typeof capabilities.resume !== 'boolean' || typeof capabilities.fork !== 'boolean') throw new Error('invalid provider session');
  const parentId = value.parentId;
  if (parentId !== null && typeof parentId !== 'string') throw new Error('invalid provider session');
  const lineage = value.lineage === undefined
    ? (parentId === null ? 'new' : 'fork')
    : parseLineage(value.lineage);
  return { id: string(value.id), provider: 'claude', nativeSessionId: string(value.nativeSessionId),
    taskId: string(value.taskId), attemptId: string(value.attemptId),
    executionContextId: string(value.executionContextId),
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

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error('invalid string');
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

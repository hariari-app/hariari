import type { TaskExecutionState, TaskView } from '../shared/runtime/runtime-interface';
import type {
  AttemptForkedEvent,
  ClaudeForkRequestedEvent,
  ClaudeResumeRejectedEvent,
} from './claude-session-lifecycle';

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
  | ClaudeResumeRejectedEvent | ClaudeForkRequestedEvent | AttemptForkedEvent;

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
  if (type === 'ContextAllocated') return parseContextAllocated(value, taskId);
  if (type === 'AttemptStarted' || type === 'AttemptFailed' || type === 'AttemptCancelled') {
    return { type, version: 1, taskId };
  }
  if (type === 'AttemptCompleted') return { type, version: 1, taskId, exitCode: integer(value.exitCode) };
  if (type === 'ClaudeResumeRejected') return parseResumeRejected(value, taskId);
  if (type === 'ClaudeForkRequested') return parseForkRequested(value, taskId);
  if (type === 'CancellationRequested') return parseCancellation(value, taskId);
  throw new Error('invalid event');
}

function parseRunCreated(value: Record<string, unknown>, taskId: string): RunCreatedEvent {
  return { type: 'RunCreated', version: 1, taskId,
    idempotencyKey: string(value.idempotencyKey), fingerprint: string(value.fingerprint),
    run: parseRun(object(value.run)) };
}

function parseAttemptForked(value: Record<string, unknown>, taskId: string): AttemptForkedEvent {
  return { type: 'AttemptForked', version: 1, taskId, attempt: parseAttempt(object(value.attempt)),
    parentAttemptId: string(value.parentAttemptId), parentSessionId: string(value.parentSessionId),
    forkKey: string(value.forkKey) };
}

function parseContextAllocated(value: Record<string, unknown>, taskId: string): ContextAllocatedEvent {
  const providerSession = value.providerSession === undefined || value.providerSession === null
    ? null : parseProviderSession(object(value.providerSession));
  return { type: 'ContextAllocated', version: 1, taskId,
    context: parseContext(object(value.context)), providerSession };
}

function parseResumeRejected(value: Record<string, unknown>, taskId: string): ClaudeResumeRejectedEvent {
  const reason = string(value.reason);
  if (reason !== 'unsupported' && reason !== 'scope-mismatch' && reason !== 'not-current') throw new Error('invalid event');
  return { type: 'ClaudeResumeRejected', version: 1, taskId,
    providerSessionId: string(value.providerSessionId), idempotencyKey: string(value.idempotencyKey),
    fingerprint: string(value.fingerprint), reason };
}

function parseForkRequested(value: Record<string, unknown>, taskId: string): ClaudeForkRequestedEvent {
  return { type: 'ClaudeForkRequested', version: 1, taskId,
    providerSessionId: string(value.providerSessionId), idempotencyKey: string(value.idempotencyKey),
    fingerprint: string(value.fingerprint) };
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
  if (!['starting', 'running', 'completed', 'failed', 'cancelling', 'cancelled'].includes(state)) throw new Error('invalid attempt');
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
  return { id: string(value.id), provider: 'claude', nativeSessionId: string(value.nativeSessionId),
    taskId: string(value.taskId), attemptId: string(value.attemptId),
    executionContextId: string(value.executionContextId),
    capabilities: { resume: capabilities.resume, fork: capabilities.fork }, parentId };
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

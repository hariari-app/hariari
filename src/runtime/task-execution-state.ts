import type {
  TaskExecutionState,
  TaskExecutionView,
} from '../shared/runtime/runtime-interface';
import type {
  EventTimelineOperationChain,
  EventTimelineOperationIdentity,
} from '../shared/runtime/event-timeline-contract';
import type {
  AttemptForkedEvent,
  AttemptResumedEvent,
  CancellationRequestedEvent,
  RunCreatedEvent,
  StoredAttempt,
  StoredContext,
  StoredProviderSession,
  StoredRun,
  TaskEvent,
} from './task-events';
import type { ProviderSessionActionAbortedEvent } from './provider-session-lifecycle';
import { isTerminalExecutionState } from './task-execution-rules';
import { TaskStorageError } from './task-storage-error';
import {
  providerChildOperation,
  type AcceptedProviderActionIdentity,
} from './provider-action-identity';

export interface StoredExecution {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly currentOperationKey: string;
  readonly currentCorrelationId: string;
  readonly attemptOperations: readonly EventTimelineOperationIdentity[];
  readonly run: StoredRun;
  readonly attempt: StoredAttempt | null;
  readonly attempts: readonly StoredAttempt[];
  readonly context: StoredContext | null;
  readonly failedContext: StoredContext | null;
  readonly executionContexts: readonly StoredContext[];
  readonly providerSession: StoredProviderSession | null;
  readonly providerSessions: readonly StoredProviderSession[];
  readonly providerObservationAt: string | null;
  readonly acceptedProviderAction: AcceptedProviderActionIdentity | null;
  readonly supersession: {
    readonly actionKey: string;
    readonly reason: 'native-resume' | 'fork';
    readonly parentAttemptId: string;
    readonly parentSessionId: string;
  } | null;
  readonly plannedAction: {
    readonly kind: 'native-resume' | 'fork';
    readonly actionKey: string;
    readonly sourceAttemptId: string;
    readonly sourceSessionId: string;
    readonly plannedContext: StoredContext;
  } | null;
  readonly cancellation: {
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly fingerprint: string;
  } | null;
}

export interface ExecutionReservation {
  readonly execution: TaskExecutionView; readonly created: boolean;
  readonly providerRepair?: PlannedProviderRepair;
}

export interface PlannedProviderRepair {
  readonly kind: 'native-resume' | 'fork'; readonly parentContext: StoredContext;
  readonly parentSession: StoredProviderSession; readonly plannedContext: StoredContext;
}

export type ProviderActionRepair = {
  readonly execution: TaskExecutionView;
  readonly repair: PlannedProviderRepair | null;
};

export interface NativeResumeReservation extends PlannedProviderRepair {
  readonly execution: TaskExecutionView;
}

export type ProviderForkReservation = NativeResumeReservation;

export function executionFromRun(event: RunCreatedEvent): StoredExecution {
  return {
    taskId: event.taskId,
    idempotencyKey: event.idempotencyKey,
    fingerprint: event.fingerprint,
    currentOperationKey: event.idempotencyKey,
    currentCorrelationId: event.correlationId,
    attemptOperations: [],
    run: event.run,
    attempt: null,
    attempts: [],
    context: null,
    failedContext: null,
    executionContexts: [],
    providerSession: null,
    providerSessions: [],
    providerObservationAt: null,
    acceptedProviderAction: null,
    supersession: null,
    plannedAction: null,
    cancellation: null,
  };
}

export function resumeExecution(
  execution: StoredExecution,
  event: AttemptResumedEvent,
): StoredExecution {
  const operation = providerChildOperation(execution.acceptedProviderAction, event);
  if (
    !execution.attempt ||
    execution.attempt.id !== event.sourceAttemptId ||
    execution.attempt.state !== 'superseded' ||
    execution.providerSession?.id !== event.sourceSessionId
  ) {
    throw new TaskStorageError('internal');
  }
  return {
    ...execution,
    attempt: event.attempt,
    attempts: [...execution.attempts, event.attempt],
    context: null,
    failedContext: null,
    providerSession: null,
    providerObservationAt: null,
    acceptedProviderAction: null,
    cancellation: null,
    supersession: null,
    plannedAction: {
      kind: 'native-resume',
      actionKey: event.actionKey,
      sourceAttemptId: event.sourceAttemptId,
      sourceSessionId: event.sourceSessionId,
      plannedContext: event.plannedContext,
    },
    currentOperationKey: operation.idempotencyKey,
    currentCorrelationId: operation.correlationId,
    attemptOperations: [...execution.attemptOperations, operation],
  };
}

export function cancelExecution(
  execution: StoredExecution,
  event: CancellationRequestedEvent,
): StoredExecution {
  if (
    !execution.attempt ||
    execution.cancellation ||
    ['completed', 'failed', 'cancelled', 'superseded'].includes(execution.attempt.state)
  ) {
    throw new TaskStorageError('internal');
  }
  const attempt = { ...execution.attempt, state: 'cancelling' as const };
  return {
    ...execution,
    attempt,
    attempts: execution.attempts.map((stored) => stored.id === attempt.id ? attempt : stored),
    cancellation: {
      idempotencyKey: event.idempotencyKey,
      correlationId: event.correlationId,
      fingerprint: event.fingerprint,
    },
    currentOperationKey: event.idempotencyKey,
    currentCorrelationId: event.correlationId,
  };
}

export function abortProviderActionExecution(
  execution: StoredExecution,
  event: ProviderSessionActionAbortedEvent,
): StoredExecution {
  if (
    !execution.attempt ||
    execution.attempt.state !== 'superseding' ||
    !execution.supersession ||
    !execution.acceptedProviderAction ||
    execution.taskId !== event.taskId ||
    execution.supersession.actionKey !== event.idempotencyKey ||
    execution.acceptedProviderAction.actionKey !== event.idempotencyKey ||
    execution.supersession.parentAttemptId !== execution.acceptedProviderAction.sourceAttemptId ||
    execution.supersession.parentSessionId !== execution.acceptedProviderAction.sourceSessionId
  ) {
    throw new TaskStorageError('internal');
  }
  const attempt = { ...execution.attempt, state: 'running' as const };
  return {
    ...execution,
    attempt,
    attempts: execution.attempts.map((stored) => stored.id === attempt.id ? attempt : stored),
    supersession: null,
    acceptedProviderAction: null,
  };
}

export function plannedProviderRepair(
  execution: StoredExecution,
): PlannedProviderRepair | undefined {
  const planned = execution.plannedAction;
  if (!planned) {
    return undefined;
  }
  const parentSession = execution.providerSessions.find((session) =>
    session.id === planned.sourceSessionId && session.attemptId === planned.sourceAttemptId);
  const parentContext = parentSession && execution.executionContexts.find((context) =>
    context.id === parentSession.executionContextId);
  if (!parentSession || !parentContext) {
    throw new TaskStorageError('internal');
  }
  return {
    kind: planned.kind,
    parentContext,
    parentSession,
    plannedContext: planned.plannedContext,
  };
}

export function terminalExecution(
  execution: StoredExecution,
  event: Extract<
    TaskEvent,
    { type: 'AttemptCompleted' | 'AttemptFailed' | 'AttemptCancelled' }
  >,
): StoredExecution {
  if (!execution.attempt || isTerminalExecutionState(execution.attempt.state)) {
    throw new TaskStorageError('internal');
  }
  const state = terminalState(event);
  const attempt: StoredAttempt = {
    ...execution.attempt,
    state,
    ...(event.type === 'AttemptCompleted' ? { exitCode: event.exitCode } : {}),
  };
  return {
    ...execution,
    attempt,
    attempts: execution.attempts.map((stored) => stored.id === attempt.id ? attempt : stored),
    context: execution.context ?? execution.failedContext,
    failedContext: null,
  };
}

function terminalState(
  event: Extract<
    TaskEvent,
    { type: 'AttemptCompleted' | 'AttemptFailed' | 'AttemptCancelled' }
  >,
): Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled'> {
  if (event.type === 'AttemptCompleted') {
    return 'completed';
  }
  if (event.type === 'AttemptFailed') {
    return 'failed';
  }
  return 'cancelled';
}

export function forkExecution(
  execution: StoredExecution,
  event: AttemptForkedEvent,
): StoredExecution {
  const operation = providerChildOperation(execution.acceptedProviderAction, event);
  if (
    !execution.attempt ||
    !execution.context ||
    !execution.providerSession ||
    execution.attempt.id !== event.parentAttemptId ||
    execution.providerSession.id !== event.parentSessionId ||
    execution.attempt.number >= event.attempt.number
  ) {
    throw new TaskStorageError('internal');
  }
  const parent = event.plannedContext
    ? execution.attempt
    : { ...execution.attempt, state: 'superseded' as const };
  return {
    ...execution,
    attempt: event.attempt,
    attempts: [
      ...execution.attempts.map((attempt) => attempt.id === parent.id ? parent : attempt),
      event.attempt,
    ],
    context: null,
    failedContext: null,
    providerSession: null,
    providerObservationAt: null,
    acceptedProviderAction: null,
    cancellation: null,
    supersession: null,
    currentOperationKey: operation.idempotencyKey,
    currentCorrelationId: operation.correlationId,
    attemptOperations: [...execution.attemptOperations, operation],
    plannedAction: event.plannedContext
      ? {
          kind: 'fork',
          actionKey: event.forkKey,
          sourceAttemptId: event.parentAttemptId,
          sourceSessionId: event.parentSessionId,
          plannedContext: event.plannedContext,
        }
      : null,
  };
}

export function attemptOperation(
  execution: StoredExecution,
  attemptId: string,
  idempotencyKey: string,
  correlationId: string,
): EventTimelineOperationIdentity {
  return { taskId: execution.taskId, runId: execution.run.id, attemptId,
    idempotencyKey, correlationId };
}

export function eventTimelineOperationChain(
  execution: StoredExecution,
): EventTimelineOperationChain {
  const cancellation = execution.cancellation && execution.attempt
    ? attemptOperation(execution, execution.attempt.id,
        execution.cancellation.idempotencyKey, execution.cancellation.correlationId)
    : null;
  return { attempts: execution.attemptOperations, cancellation };
}

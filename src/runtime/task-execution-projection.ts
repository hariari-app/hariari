import type {
  TaskExecutionView,
  TaskView,
} from '../shared/runtime/runtime-interface';
import type {
  StoredContext,
  StoredProviderSession,
  TaskEvent,
} from './task-events';
import {
  abortProviderActionExecution,
  attemptOperation,
  cancelExecution,
  executionFromRun,
  forkExecution,
  resumeExecution,
  terminalExecution,
  type StoredExecution,
} from './task-execution-state';
import { isTerminalExecutionState } from './task-execution-rules';
import { TaskStorageError } from './task-storage-error';
import { acceptedProviderActionIdentity } from './provider-action-identity';

export type ExecutionProjectionEvent = Extract<
  TaskEvent,
  {
    type:
      | 'RunCreated'
      | 'AttemptCreated'
      | 'ContextAllocated'
      | 'AttemptStarted'
      | 'AttemptSupersessionRequested'
      | 'AttemptSuperseded'
      | 'AttemptResumed'
      | 'ProviderSessionActionAborted'
      | 'CancellationRequested'
      | 'AttemptCompleted'
      | 'AttemptFailed'
      | 'AttemptCancelled'
      | 'AttemptForked'
      | 'ProviderSessionActionDecided';
  }
>;

interface TaskExecutionProjectionDependencies {
  readonly taskExists: (taskId: string) => boolean;
}

export interface PrivateTaskExecutionView extends Omit<
  TaskExecutionView,
  'context' | 'executionContexts' | 'providerSession' | 'providerSessions'
> {
  readonly context: StoredContext | null;
  readonly executionContexts: readonly StoredContext[];
  readonly providerSession: StoredProviderSession | null;
  readonly providerSessions: readonly StoredProviderSession[];
}

/** Owns the replayed execution state, indexes, and transition invariants. */
export class TaskExecutionProjection {
  private readonly executions = new Map<string, StoredExecution>();
  private readonly executionKeys = new Map<string, StoredExecution>();
  private readonly runOwners = new Map<string, string>();
  private readonly attemptOwners = new Map<string, string>();
  private readonly contextOwners = new Map<string, string>();
  private readonly providerSessionOwners = new Map<string, string>();

  constructor(private readonly dependencies: TaskExecutionProjectionDependencies) {}

  apply(event: ExecutionProjectionEvent): void {
    switch (event.type) {
      case 'RunCreated':
        return this.applyRunCreated(event);
      case 'AttemptCreated':
        return this.applyAttemptCreated(event);
      case 'ContextAllocated':
        return this.applyContextAllocated(event);
      case 'AttemptStarted':
        this.applyAttemptStarted(event);
        return;
      case 'AttemptSupersessionRequested':
        this.applySupersessionRequested(event);
        return;
      case 'AttemptSuperseded':
        this.applyAttemptSuperseded(event);
        return;
      case 'AttemptResumed': {
        return this.applyAttemptResumed(event);
      }
      case 'ProviderSessionActionAborted': {
        const execution = this.require(event.taskId);
        this.replace(event.taskId, abortProviderActionExecution(execution));
        return;
      }
      case 'CancellationRequested': {
        const execution = this.require(event.taskId);
        this.replace(event.taskId, cancelExecution(execution, event));
        return;
      }
      case 'AttemptCompleted':
      case 'AttemptFailed':
      case 'AttemptCancelled': {
        const execution = this.require(event.taskId);
        this.replace(event.taskId, terminalExecution(execution, event));
        return;
      }
      case 'AttemptForked': {
        return this.applyAttemptForked(event);
      }
      case 'ProviderSessionActionDecided':
        this.applyProviderActionDecided(event);
        return;
    }
  }

  optional(taskId: string): StoredExecution | undefined {
    return this.executions.get(taskId);
  }

  require(taskId: string): StoredExecution {
    const execution = this.optional(taskId);
    if (!execution) {
      throw new TaskStorageError('internal');
    }
    return execution;
  }

  byKey(idempotencyKey: string): StoredExecution | undefined {
    return this.executionKeys.get(idempotencyKey);
  }

  view(task: TaskView): TaskExecutionView {
    return projectExecution(task, this.optional(task.id) ?? null);
  }

  privateView(task: TaskView): PrivateTaskExecutionView {
    return privateExecutionProjection(task, this.optional(task.id) ?? null);
  }

  recoveryWorktrees(): readonly { readonly taskId: string; readonly worktreeId: string }[] {
    return [...this.executions.values()].flatMap((execution) => {
      const worktreeIds = new Set(
        execution.executionContexts.map((context) => context.worktreeId),
      );
      return [...worktreeIds].map((worktreeId) => ({
        taskId: execution.taskId,
        worktreeId,
      }));
    });
  }

  private applyRunCreated(
    event: Extract<ExecutionProjectionEvent, { type: 'RunCreated' }>,
  ): void {
    if (!this.dependencies.taskExists(event.taskId) || this.executions.has(event.taskId) ||
      this.runOwners.has(event.run.id) || this.executionKeys.has(event.idempotencyKey)) {
      throw new TaskStorageError('internal');
    }
    const execution = executionFromRun(event);
    this.executions.set(event.taskId, execution);
    this.executionKeys.set(event.idempotencyKey, execution);
    this.runOwners.set(event.run.id, event.taskId);
  }

  private applyAttemptCreated(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptCreated' }>,
  ): void {
    const execution = this.require(event.taskId);
    if (execution.attempt || this.attemptOwners.has(event.attempt.id)) {
      throw new TaskStorageError('internal');
    }
    this.replace(event.taskId, {
      ...execution,
      attempt: event.attempt,
      attempts: [...execution.attempts, event.attempt],
      attemptOperations: [...execution.attemptOperations,
        attemptOperation(execution, event.attempt.id, execution.currentOperationKey,
          execution.currentCorrelationId)],
    });
    this.attemptOwners.set(event.attempt.id, event.taskId);
  }

  private applyAttemptResumed(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptResumed' }>,
  ): void {
    this.applyChildAttempt(event.taskId, event.attempt.id,
      (execution) => resumeExecution(execution, event));
  }

  private applyAttemptForked(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptForked' }>,
  ): void {
    this.applyChildAttempt(event.taskId, event.attempt.id,
      (execution) => forkExecution(execution, event));
  }

  private applyChildAttempt(
    taskId: string,
    attemptId: string,
    transition: (execution: StoredExecution) => StoredExecution,
  ): void {
    if (this.attemptOwners.has(attemptId)) throw new TaskStorageError('internal');
    const replacement = transition(this.require(taskId));
    this.replace(taskId, replacement);
    this.attemptOwners.set(attemptId, taskId);
  }

  private applyContextAllocated(
    event: Extract<ExecutionProjectionEvent, { type: 'ContextAllocated' }>,
  ): void {
    const execution = this.require(event.taskId);
    const successful = event.launchOutcome !== 'failed';
    if (
      !execution.attempt ||
      execution.context ||
      (execution.attempt.state !== 'starting' && execution.attempt.state !== 'cancelling')
    ) {
      throw new TaskStorageError('internal');
    }
    const session = event.providerSession;
    if (
      this.contextOwners.has(event.context.id) ||
      (!successful && (session !== null || event.observedAt !== undefined)) ||
      session &&
      (
        this.providerSessionOwners.has(session.id) ||
        session.taskId !== event.taskId ||
        session.executionContextId !== event.context.id ||
        session.attemptId !== execution.attempt.id
      )
    ) {
      throw new TaskStorageError('internal');
    }
    this.replace(event.taskId, {
      ...execution,
      context: successful ? event.context : execution.context,
      failedContext: successful ? null : event.context,
      executionContexts: [...execution.executionContexts, event.context],
      providerSession: successful ? session : execution.providerSession,
      providerObservationAt: successful ? event.observedAt ?? null : execution.providerObservationAt,
      providerSessions: successful && session
        ? [...execution.providerSessions, session]
        : execution.providerSessions,
      plannedAction: successful ? null : execution.plannedAction,
    });
    this.contextOwners.set(event.context.id, event.taskId);
    if (successful && session) this.providerSessionOwners.set(session.id, event.context.id);
  }

  private applyAttemptStarted(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptStarted' }>,
  ): void {
    const execution = this.require(event.taskId);
    if (!execution.attempt || !execution.context || execution.attempt.state !== 'starting') {
      throw new TaskStorageError('internal');
    }
    this.replaceAttempt(execution, { ...execution.attempt, state: 'running' });
  }

  private applyProviderActionDecided(
    event: Extract<ExecutionProjectionEvent, { type: 'ProviderSessionActionDecided' }>,
  ): void {
    if (event.outcome !== 'accepted' || event.decision === 'exact-reattach') return;
    const execution = this.require(event.taskId);
    const sources = execution.providerSessions.filter((session) =>
      session.id === event.providerSessionId);
    if (sources.length !== 1 || execution.acceptedProviderAction) {
      throw new TaskStorageError('internal');
    }
    const acceptedProviderAction = acceptedProviderActionIdentity(
      event, sources[0]!, execution.run.id,
    );
    this.replace(event.taskId, { ...execution, acceptedProviderAction });
  }

  private applySupersessionRequested(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptSupersessionRequested' }>,
  ): void {
    const execution = this.require(event.taskId);
    if (
      !execution.attempt ||
      !execution.providerSession ||
      execution.attempt.id !== event.parentAttemptId ||
      execution.providerSession.id !== event.parentSessionId ||
      isTerminalExecutionState(execution.attempt.state)
    ) {
      throw new TaskStorageError('internal');
    }
    this.replaceAttempt(execution, { ...execution.attempt, state: 'superseding' });
    const updated = this.require(event.taskId);
    this.replace(event.taskId, {
      ...updated,
      supersession: {
        actionKey: event.actionKey,
        reason: event.reason,
        parentAttemptId: event.parentAttemptId,
        parentSessionId: event.parentSessionId,
      },
    });
  }

  private applyAttemptSuperseded(
    event: Extract<ExecutionProjectionEvent, { type: 'AttemptSuperseded' }>,
  ): void {
    const execution = this.require(event.taskId);
    if (
      !execution.attempt ||
      execution.attempt.id !== event.attemptId ||
      execution.attempt.state !== 'superseding'
    ) {
      throw new TaskStorageError('internal');
    }
    this.replaceAttempt(execution, { ...execution.attempt, state: 'superseded' });
  }

  private replace(taskId: string, replacement: StoredExecution): void {
    const current = this.require(taskId);
    if (this.executionKeys.get(current.idempotencyKey) !== current) {
      throw new TaskStorageError('internal');
    }
    this.executions.set(replacement.taskId, replacement);
    this.executionKeys.set(replacement.idempotencyKey, replacement);
  }

  private replaceAttempt(
    execution: StoredExecution,
    attempt: StoredExecution['attempt'],
  ): void {
    if (!attempt) {
      throw new TaskStorageError('internal');
    }
    this.replace(execution.taskId, {
      ...execution,
      attempt,
      attempts: execution.attempts.map((stored) =>
        stored.id === attempt.id ? attempt : stored),
    });
  }
}

export function projectExecution(
  task: TaskView,
  execution: StoredExecution | null,
): TaskExecutionView {
  const state = execution?.attempt?.state ?? (execution ? 'starting' : 'ready');
  return {
    task: { ...task, executionState: state },
    run: execution ? { ...execution.run } : null,
    attempt: execution?.attempt ? { ...execution.attempt } : null,
    attempts: execution?.attempts.map((attempt) => ({ ...attempt })) ?? [],
    context: execution?.context ? publicContext(execution.context) : null,
    executionContexts: execution?.executionContexts.map(publicContext) ?? [],
    providerSession: execution?.providerSession
      ? publicProviderSession(execution.providerSession)
      : null,
    providerSessions: execution?.providerSessions.map(publicProviderSession) ?? [],
  };
}

export function privateExecutionProjection(
  task: TaskView,
  execution: StoredExecution | null,
): PrivateTaskExecutionView {
  return {
    ...projectExecution(task, execution),
    context: execution?.context ? { ...execution.context } : null,
    executionContexts: execution?.executionContexts.map((context) => ({
      ...context,
    })) ?? [],
    providerSession: execution?.providerSession
      ? {
          ...execution.providerSession,
          capabilities: { ...execution.providerSession.capabilities },
        }
      : null,
    providerSessions: execution?.providerSessions.map((session) => ({
      ...session,
      capabilities: { ...session.capabilities },
    })) ?? [],
  };
}

function publicContext(context: StoredContext): NonNullable<TaskExecutionView['context']> {
  return {
    id: context.id,
    worktreeId: context.worktreeId,
    branchName: context.branchName,
    baseCommit: context.baseCommit,
  };
}

function publicProviderSession(
  session: StoredProviderSession,
): NonNullable<TaskExecutionView['providerSession']> {
  return {
    id: session.id,
    provider: session.provider,
    attemptId: session.attemptId,
    executionContextId: session.executionContextId,
    capabilities: { ...session.capabilities },
    parentId: session.parentId,
    lineage: session.lineage,
  };
}

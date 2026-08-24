import type {
  TaskExecutionView,
  TaskView,
} from '../shared/runtime/runtime-interface';
import type {
  StoredContext,
  StoredProviderSession,
} from './task-events';
import type { StoredExecution } from './task-module';

export interface PrivateTaskExecutionView extends Omit<
  TaskExecutionView,
  'context' | 'executionContexts' | 'providerSession' | 'providerSessions'
> {
  readonly context: StoredContext | null;
  readonly executionContexts: readonly StoredContext[];
  readonly providerSession: StoredProviderSession | null;
  readonly providerSessions: readonly StoredProviderSession[];
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
    executionContexts: execution?.executionContexts.map((context) => ({ ...context })) ?? [],
    providerSession: execution?.providerSession
      ? { ...execution.providerSession, capabilities: { ...execution.providerSession.capabilities } }
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

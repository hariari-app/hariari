import type {
  CreateTaskRequest,
  TaskExecutionState,
} from '../shared/runtime/runtime-interface';
import type {
  StoredAttempt,
  StoredContext,
  StoredProviderSession,
} from './task-events';

interface ResumeParentExecution {
  readonly attempt: StoredAttempt | null;
  readonly context: StoredContext | null;
  readonly providerSession: StoredProviderSession | null;
}

export function resumeParent(
  execution: ResumeParentExecution,
  providerSessionId: string,
): {
  readonly attempt: StoredAttempt;
  readonly context: StoredContext;
  readonly session: StoredProviderSession;
} | null {
  if (!execution.attempt || !execution.context || !execution.providerSession ||
    execution.providerSession.id !== providerSessionId ||
    !['running', 'superseding', 'superseded'].includes(execution.attempt.state)) return null;
  return {
    attempt: execution.attempt,
    context: execution.context,
    session: execution.providerSession,
  };
}

export function canonicalTaskFingerprint(request: CreateTaskRequest): string {
  return JSON.stringify([
    request.objective,
    request.project,
    request.repository,
    request.baseRef,
    request.provider,
  ]);
}

export function canonicalExecutionFingerprint(taskId: string): string {
  return JSON.stringify([taskId]);
}

export function isTerminal(state: TaskExecutionState | undefined): boolean {
  return state === 'completed' || state === 'failed' ||
    state === 'cancelled' || state === 'superseded';
}

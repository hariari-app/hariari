import type { TaskExecutionState } from '../shared/runtime/runtime-interface';
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

export function resumeParentExecution(
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

export function isTerminalExecutionState(state: TaskExecutionState | undefined): boolean {
  return state === 'completed' || state === 'failed' ||
    state === 'cancelled' || state === 'superseded';
}

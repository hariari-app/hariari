import { describe, expect, it } from 'vitest';
import { TaskExecutionProjection } from '../../src/runtime/task-execution-projection';

const TASK_ID = 'task-authority';
const SESSION_ID = 'session-authority';

describe('provider action projection authority', () => {
  it('rejects foreign exact reattach before changing projection identity', () => {
    const projection = runningProjection();
    const before = projection.optional(TASK_ID);
    expect(() => projection.validateProviderActionDecision({
      type: 'ProviderSessionActionDecided', version: 1, taskId: TASK_ID,
      action: 'resume', providerSessionId: 'foreign-session', idempotencyKey: 'resume-key',
      correlationId: 'resume-correlation',
      fingerprint: JSON.stringify(['resume', TASK_ID, 'foreign-session']),
      outcome: 'accepted', decision: 'exact-reattach', reason: null,
    })).toThrow();
    expect(projection.optional(TASK_ID)).toBe(before);
  });

  it('rejects a wrong-key abort before changing a superseding projection', () => {
    const projection = runningProjection();
    const decision = {
      type: 'ProviderSessionActionDecided' as const, version: 1 as const, taskId: TASK_ID,
      action: 'fork' as const, providerSessionId: SESSION_ID, idempotencyKey: 'fork-key',
      correlationId: 'fork-correlation', fingerprint: JSON.stringify(['fork', TASK_ID, SESSION_ID]),
      outcome: 'accepted' as const, decision: 'fork' as const, reason: null,
    };
    projection.validateProviderActionDecision(decision);
    projection.apply(decision);
    projection.apply({
      type: 'AttemptSupersessionRequested', version: 1, taskId: TASK_ID,
      actionKey: 'fork-key', parentAttemptId: 'attempt-authority',
      parentSessionId: SESSION_ID, reason: 'fork',
    });
    const before = projection.optional(TASK_ID);
    expect(() => projection.validateProviderActionAbort({
      type: 'ProviderSessionActionAborted', version: 1, taskId: TASK_ID,
      idempotencyKey: 'wrong-key', reason: 'parent-still-live',
    })).toThrow();
    expect(projection.optional(TASK_ID)).toBe(before);
  });
});

function runningProjection(): TaskExecutionProjection {
  const projection = new TaskExecutionProjection({ taskExists: () => true });
  projection.apply({
    type: 'RunCreated', version: 1, taskId: TASK_ID, idempotencyKey: 'start-key',
    correlationId: 'start-correlation', fingerprint: JSON.stringify(['start', TASK_ID]),
    run: { id: 'run-authority', number: 1 },
  });
  projection.apply({
    type: 'AttemptCreated', version: 1, taskId: TASK_ID,
    attempt: { id: 'attempt-authority', number: 1, state: 'starting' },
  });
  const context = {
    id: 'context-authority', worktreeId: 'worktree-authority', branchName: 'branch-authority',
    baseCommit: 'base-authority', processId: 'process-authority', ptyId: 'pty-authority',
  };
  projection.apply({
    type: 'ContextAllocated', version: 1, taskId: TASK_ID, context,
    providerSession: {
      id: SESSION_ID, provider: 'claude', nativeSessionId: 'native-authority', taskId: TASK_ID,
      attemptId: 'attempt-authority', executionContextId: context.id,
      capabilities: { resume: true, fork: true }, parentId: null, lineage: 'new',
    }, launchOutcome: 'succeeded', observedAt: '2026-08-25T10:00:00.000Z',
  });
  projection.apply({
    type: 'AttemptStarted', version: 1, taskId: TASK_ID,
    occurredAt: '2026-08-25T10:00:00.000Z',
  });
  return projection;
}

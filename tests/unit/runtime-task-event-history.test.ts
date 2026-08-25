import { describe, expect, it } from 'vitest';
import { TaskEventHistory } from '../../src/runtime/task-event-history';
import type { TaskEvent } from '../../src/runtime/task-events';
import {
  allowlistProviderObservation,
  normalizedEvent,
} from '../../src/shared/runtime/event-timeline-contract';

const NOW = '2026-08-25T10:00:00.000Z';
const task = {
  id: 'task-1',
  objective: 'Audit durable event duplicates.',
  project: 'Hariari',
  repository: 'repository',
  baseRef: 'main',
  provider: 'claude' as const,
  createdAt: NOW,
};
const run = { id: 'run-1', number: 1 };
const attempt = { id: 'attempt-1', number: 1, state: 'starting' as const };
const context = {
  id: 'context-1',
  worktreeId: 'worktree-1',
  branchName: 'branch-1',
  baseCommit: 'base-1',
  processId: 'process-1',
  ptyId: 'pty-1',
};
const providerSession = {
  id: 'session-1',
  provider: 'claude' as const,
  nativeSessionId: 'native-1',
  taskId: task.id,
  attemptId: attempt.id,
  executionContextId: context.id,
  capabilities: { resume: true, fork: true },
  parentId: null,
  lineage: 'new' as const,
};
const observation = allowlistProviderObservation({
  taskId: task.id,
  providerSessionId: providerSession.id,
  idempotencyKey: 'start-key',
  observedAt: NOW,
  evidence: { provider: 'claude', kind: 'provider-session-observed', sessionState: 'active' },
});
const normalized = normalizedEvent({
  taskId: task.id,
  runId: null,
  attemptId: null,
  providerSessionId: null,
  kind: 'task-created',
  correlationId: 'create-correlation',
  idempotencyKey: 'create-key',
  sequence: 1,
  occurrenceAt: NOW,
  observedAt: NOW,
  causationId: null,
});

describe('durable Task event duplicate validation', () => {
  it('rejects exact duplicates for every durable event kind in memory', () => {
    const types = DURABLE_EVENTS.map((event) => event.type);
    expect(new Set(types).size).toBe(types.length);
    for (const event of DURABLE_EVENTS) {
      const history = new TaskEventHistory();
      history.accept(event, attempt.id);
      expect(() => history.accept(event, attempt.id)).toThrow('duplicate durable Task event');
    }
  });

  it('keeps identical legacy attempt phase payloads distinct across attempts', () => {
    const history = new TaskEventHistory();
    const event = { type: 'AttemptStarted', version: 1, taskId: task.id } as const;
    history.accept(event, 'attempt-1');
    expect(() => history.accept(event, 'attempt-2')).not.toThrow();
  });
});

const DURABLE_EVENTS: readonly TaskEvent[] = [
  {
    type: 'TaskCreated',
    version: 1,
    task,
    idempotencyKey: 'create-key',
    correlationId: 'create-correlation',
    fingerprint: 'create-fingerprint',
  },
  {
    type: 'RunCreated',
    version: 1,
    taskId: task.id,
    idempotencyKey: 'start-key',
    correlationId: 'start-correlation',
    fingerprint: 'start-fingerprint',
    run,
  },
  { type: 'AttemptCreated', version: 1, taskId: task.id, attempt },
  { type: 'ContextAllocated', version: 1, taskId: task.id, context, providerSession },
  {
    type: 'RawProviderObservationRecorded',
    version: 1,
    taskId: task.id,
    providerSessionId: providerSession.id,
    idempotencyKey: 'start-key',
    observation,
  },
  { type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: task.id, event: normalized },
  { type: 'AttemptStarted', version: 1, taskId: task.id },
  { type: 'AttemptCompleted', version: 1, taskId: task.id, exitCode: 0 },
  { type: 'AttemptFailed', version: 1, taskId: task.id },
  {
    type: 'CancellationRequested',
    version: 1,
    taskId: task.id,
    idempotencyKey: 'cancel-key',
    correlationId: 'cancel-correlation',
    fingerprint: 'cancel-fingerprint',
  },
  { type: 'AttemptCancelled', version: 1, taskId: task.id },
  {
    type: 'AttemptSupersessionRequested',
    version: 1,
    taskId: task.id,
    actionKey: 'resume-key',
    parentAttemptId: attempt.id,
    parentSessionId: providerSession.id,
    reason: 'native-resume',
  },
  {
    type: 'AttemptSuperseded',
    version: 1,
    taskId: task.id,
    actionKey: 'resume-key',
    attemptId: attempt.id,
    reason: 'native-resume',
  },
  {
    type: 'AttemptResumed',
    version: 1,
    taskId: task.id,
    attempt: { id: 'attempt-2', number: 2, state: 'starting' },
    sourceAttemptId: attempt.id,
    sourceSessionId: providerSession.id,
    actionKey: 'resume-key',
    correlationId: 'resume-correlation',
    plannedContext: { ...context, id: 'context-2' },
  },
  {
    type: 'AttemptForked',
    version: 1,
    taskId: task.id,
    attempt: { id: 'attempt-3', number: 3, state: 'starting' },
    parentAttemptId: attempt.id,
    parentSessionId: providerSession.id,
    forkKey: 'fork-key',
    correlationId: 'fork-correlation',
  },
  {
    type: 'ProviderSessionActionDecided',
    version: 1,
    taskId: task.id,
    action: 'resume',
    providerSessionId: providerSession.id,
    idempotencyKey: 'resume-key',
    correlationId: 'resume-correlation',
    fingerprint: 'resume-fingerprint',
    outcome: 'accepted',
    decision: 'native-resume',
    reason: null,
  },
  {
    type: 'ProviderSessionActionAborted',
    version: 1,
    taskId: task.id,
    idempotencyKey: 'fork-key',
    reason: 'parent-still-live',
  },
  {
    type: 'TaskReconciled',
    version: 1,
    taskId: task.id,
    idempotencyKey: 'reconcile-key',
    fingerprint: 'reconcile-fingerprint',
    recovery: {
      id: 'recovery-1',
      taskId: task.id,
      desiredState: 'running',
      status: 'ready',
      decision: 'resume',
      resources: [],
      attention: null,
    },
  },
  {
    type: 'TaskRecoveryDecided',
    version: 1,
    taskId: task.id,
    idempotencyKey: 'recover-key',
    fingerprint: 'recover-fingerprint',
    result: {
      id: 'decision-1',
      taskId: task.id,
      recoveryId: 'recovery-1',
      decision: 'resume',
      status: 'decided',
      attention: null,
    },
  },
];

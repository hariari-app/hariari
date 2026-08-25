import { describe, expect, it } from 'vitest';
import { parseTaskEvent, type TaskEvent } from '../../src/runtime/task-events';
import {
  allowlistProviderObservation,
  normalizedEvent,
} from '../../src/shared/runtime/event-timeline-contract';

const TIME = '2026-08-25T10:00:00.000Z';
const task = {
  id: 'task-1', objective: 'Validate every durable variant.', project: 'Hariari',
  repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude' as const,
  createdAt: TIME,
};
const run = { id: 'run-1', number: 1 };
const attempt = { id: 'attempt-1', number: 1, state: 'starting' as const };
const context = {
  id: 'context-1', worktreeId: 'worktree-1', branchName: 'task-1',
  baseCommit: 'base-1', processId: 'process-1', ptyId: 'pty-1',
};
const session = {
  id: 'session-1', provider: 'claude' as const, nativeSessionId: 'native-1',
  taskId: task.id, attemptId: attempt.id, executionContextId: context.id,
  capabilities: { resume: true, fork: true }, parentId: null, lineage: 'new' as const,
};
const recovery = {
  id: 'recovery-1', taskId: task.id, desiredState: 'running' as const,
  status: 'ready' as const, decision: 'resume' as const,
  resources: [{ kind: 'process' as const, classification: 'healthy' as const }],
  attention: null,
};

describe('durable Task event version-1 contract', () => {
  it('rejects unknown top-level authority fields on every event variant', () => {
    const events = durableEventCatalog();
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(ALL_EVENT_TYPES));
    for (const event of events) {
      expect(parse(event)).toEqual(event);
      expect(() => parse({ ...event, futureAuthority: true })).toThrow('invalid event');
    }
  });

  it.each(nestedEventForgeries())('rejects unknown authority in nested $name', ({ event }) => {
    expect(() => parse(event)).toThrow();
  });

  it('accepts only the documented legacy omissions', () => {
    const events = durableEventCatalog();
    const created = without(events[0]!, 'correlationId');
    const runCreated = without(events[1]!, 'correlationId');
    const allocated = without(without(events[3]!, 'launchOutcome'), 'observedAt');
    const legacySession = without(allocated.providerSession as object, 'lineage');
    const forked = without(without(events[11]!, 'correlationId'), 'plannedContext');
    const started = without(events[6]!, 'occurredAt');
    expect(() => [created, runCreated, { ...allocated, providerSession: legacySession },
      forked, started].map(parse)).not.toThrow();
  });

  registerStrictParserTests();
});

function registerStrictParserTests(): void {
  it('rejects every undocumented required-field omission', () => {
    for (const event of durableEventCatalog()) {
      for (const key of Object.keys(event)) {
        if (legacyOptionalFields(event.type).includes(key)) continue;
        expect(() => parse(without(event, key)), `${event.type}.${key}`).toThrow();
      }
    }
  });

  it('rejects Task providers outside the canonical provider domain', () => {
    const created = durableEventCatalog()[0]!;
    expect(() => parse({ ...created, task: { ...task, provider: 'attacker-provider' } }))
      .toThrow();
  });

  it('rejects unsupported versions for every durable variant', () => {
    for (const event of durableEventCatalog()) {
      expect(() => parse({ ...event, version: 2 }), event.type).toThrow();
    }
  });

  it.each(invalidDomainForgeries())('rejects constrained domain forgery: $name', ({ event }) => {
    expect(() => parse(event)).toThrow();
  });
}

function legacyOptionalFields(type: TaskEvent['type']): readonly string[] {
  const fields: string[] = [];
  if (type === 'TaskCreated' || type === 'RunCreated' || type === 'AttemptForked' ||
    type === 'AttemptResumed' || type === 'ProviderSessionActionDecided' ||
    type === 'CancellationRequested') {
    fields.push('correlationId');
  }
  if (type === 'AttemptForked') fields.push('plannedContext');
  if (type === 'ContextAllocated') fields.push('launchOutcome', 'observedAt');
  if (type === 'AttemptStarted' || type === 'AttemptCompleted' || type === 'AttemptFailed' ||
    type === 'CancellationRequested' || type === 'AttemptCancelled') fields.push('occurredAt');
  return fields;
}

function durableEventCatalog(): readonly TaskEvent[] {
  const raw = providerObservation();
  const normalized = taskCreatedTimelineEvent();
  return [
    { type: 'TaskCreated', version: 1, task, idempotencyKey: 'create-key',
      correlationId: 'create-correlation', fingerprint: 'create-fingerprint' },
    { type: 'RunCreated', version: 1, taskId: task.id, idempotencyKey: 'start-key',
      correlationId: 'start-correlation', fingerprint: 'start-fingerprint', run },
    { type: 'AttemptCreated', version: 1, taskId: task.id, attempt },
    { type: 'ContextAllocated', version: 1, taskId: task.id, context,
      providerSession: session, launchOutcome: 'succeeded', observedAt: TIME },
    { type: 'RawProviderObservationRecorded', version: 1, taskId: task.id,
      providerSessionId: session.id, idempotencyKey: 'start-key', observation: raw },
    { type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: task.id,
      event: normalized },
    { type: 'AttemptStarted', version: 1, taskId: task.id, occurredAt: TIME },
    { type: 'AttemptCompleted', version: 1, taskId: task.id, exitCode: 0, occurredAt: TIME },
    { type: 'AttemptFailed', version: 1, taskId: task.id, occurredAt: TIME },
    { type: 'CancellationRequested', version: 1, taskId: task.id,
      idempotencyKey: 'cancel-key', correlationId: 'cancel-correlation',
      fingerprint: 'cancel-fingerprint', occurredAt: TIME },
    { type: 'AttemptCancelled', version: 1, taskId: task.id, occurredAt: TIME },
    { type: 'AttemptForked', version: 1, taskId: task.id, attempt,
      parentAttemptId: 'parent-attempt', parentSessionId: 'parent-session',
      forkKey: 'fork-key', correlationId: 'fork-correlation', plannedContext: context },
    { type: 'AttemptSupersessionRequested', version: 1, taskId: task.id,
      actionKey: 'action-key', parentAttemptId: 'parent-attempt',
      parentSessionId: 'parent-session', reason: 'fork' },
    { type: 'AttemptSuperseded', version: 1, taskId: task.id,
      actionKey: 'action-key', attemptId: 'parent-attempt', reason: 'fork' },
    { type: 'AttemptResumed', version: 1, taskId: task.id, attempt,
      sourceAttemptId: 'parent-attempt', sourceSessionId: 'parent-session',
      actionKey: 'resume-key', correlationId: 'resume-correlation', plannedContext: context },
    { type: 'ProviderSessionActionDecided', version: 1, taskId: task.id,
      action: 'resume', providerSessionId: session.id, idempotencyKey: 'resume-key',
      correlationId: 'resume-correlation', fingerprint: 'resume-fingerprint',
      outcome: 'accepted', decision: 'native-resume', reason: null },
    { type: 'ProviderSessionActionAborted', version: 1, taskId: task.id,
      idempotencyKey: 'resume-key', reason: 'parent-still-live' },
    { type: 'TaskReconciled', version: 1, taskId: task.id,
      idempotencyKey: 'reconcile-key', fingerprint: 'reconcile-fingerprint', recovery },
    { type: 'TaskRecoveryDecided', version: 1, taskId: task.id,
      idempotencyKey: 'recover-key', fingerprint: 'recover-fingerprint',
      result: { id: 'decision-1', taskId: task.id, recoveryId: recovery.id,
        decision: 'resume', status: 'decided', attention: null } },
  ];
}

function providerObservation() {
  const raw = allowlistProviderObservation({
    taskId: task.id, providerSessionId: session.id, idempotencyKey: 'start-key',
    observedAt: TIME,
    evidence: { provider: 'claude', kind: 'provider-session-observed', sessionState: 'active' },
  });
  return raw;
}

function taskCreatedTimelineEvent() {
  return normalizedEvent({
    taskId: task.id, runId: null, attemptId: null, providerSessionId: null,
    kind: 'task-created', correlationId: 'create-correlation', idempotencyKey: 'create-key',
    sequence: 1, occurrenceAt: TIME, observedAt: TIME, causationId: null,
  });
}

function nestedEventForgeries() {
  const events = durableEventCatalog();
  const byType = (type: TaskEvent['type']) => events.find((event) => event.type === type)!;
  const created = byType('TaskCreated') as Extract<TaskEvent, { type: 'TaskCreated' }>;
  const runCreated = byType('RunCreated') as Extract<TaskEvent, { type: 'RunCreated' }>;
  const attemptCreated = byType('AttemptCreated') as Extract<TaskEvent, { type: 'AttemptCreated' }>;
  const allocated = byType('ContextAllocated') as Extract<TaskEvent, { type: 'ContextAllocated' }>;
  const reconciled = byType('TaskReconciled') as Extract<TaskEvent, { type: 'TaskReconciled' }>;
  return [
    { name: 'Task', event: { ...created, task: { ...created.task, futureAuthority: true } } },
    { name: 'Run', event: { ...runCreated, run: { ...runCreated.run, futureAuthority: true } } },
    { name: 'Attempt', event: { ...attemptCreated,
      attempt: { ...attemptCreated.attempt, futureAuthority: true } } },
    { name: 'Context', event: { ...allocated,
      context: { ...allocated.context, futureAuthority: true } } },
    { name: 'ProviderSession', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, futureAuthority: true } } },
    { name: 'ProviderSession capabilities', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, capabilities: {
        ...allocated.providerSession!.capabilities, futureAuthority: true,
      } } } },
    { name: 'recovery', event: { ...reconciled,
      recovery: { ...reconciled.recovery, futureAuthority: true } } },
    { name: 'recovery resource', event: { ...reconciled, recovery: {
      ...reconciled.recovery,
      resources: [{ ...reconciled.recovery.resources[0]!, futureAuthority: true }],
    } } },
  ];
}

function invalidDomainForgeries() {
  const events = durableEventCatalog();
  const byType = (type: TaskEvent['type']) => events.find((event) => event.type === type)!;
  const created = byType('TaskCreated') as Extract<TaskEvent, { type: 'TaskCreated' }>;
  const attempted = byType('AttemptCreated') as Extract<TaskEvent, { type: 'AttemptCreated' }>;
  const allocated = byType('ContextAllocated') as Extract<TaskEvent, { type: 'ContextAllocated' }>;
  const decided = byType('ProviderSessionActionDecided') as Extract<
    TaskEvent, { type: 'ProviderSessionActionDecided' }
  >;
  const supersession = byType('AttemptSupersessionRequested');
  return [
    { name: 'Task provider', event: { ...created, task: { ...created.task, provider: 'other' } } },
    { name: 'Attempt state', event: { ...attempted,
      attempt: { ...attempted.attempt, state: 'unknown' } } },
    { name: 'launch outcome', event: { ...allocated, launchOutcome: 'unknown' } },
    { name: 'provider session provider', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, provider: 'other' } } },
    { name: 'provider capability', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, capabilities: { resume: 'yes', fork: true } } } },
    { name: 'provider parent', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, parentId: 42 } } },
    { name: 'provider lineage', event: { ...allocated,
      providerSession: { ...allocated.providerSession!, lineage: 'other' } } },
    { name: 'provider action', event: { ...decided, action: 'other' } },
    { name: 'provider action decision pair', event: { ...decided,
      action: 'fork', decision: 'exact-reattach' } },
    { name: 'provider action outcome', event: { ...decided, outcome: 'other' } },
    { name: 'provider action reason', event: { ...decided,
      outcome: 'rejected', decision: null, reason: 'other' } },
    { name: 'supersession reason', event: { ...supersession, reason: 'other' } },
  ];
}

function parse(event: object): TaskEvent {
  return parseTaskEvent(Buffer.from(JSON.stringify(event)));
}

function without<T extends object>(value: T, key: string): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

const ALL_EVENT_TYPES: readonly TaskEvent['type'][] = [
  'TaskCreated', 'RunCreated', 'AttemptCreated', 'ContextAllocated',
  'RawProviderObservationRecorded', 'NormalizedRuntimeEventRecorded',
  'AttemptStarted', 'AttemptCompleted', 'AttemptFailed', 'CancellationRequested',
  'AttemptCancelled', 'AttemptForked', 'AttemptSupersessionRequested',
  'AttemptSuperseded', 'AttemptResumed', 'ProviderSessionActionDecided',
  'ProviderSessionActionAborted', 'TaskReconciled', 'TaskRecoveryDecided',
];

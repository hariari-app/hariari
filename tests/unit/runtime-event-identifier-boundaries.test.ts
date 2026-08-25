import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTaskEvent } from '../../src/runtime/task-events';
import { parseTaskTimelineView } from '../../src/runtime/protocol-validation';
import {
  allowlistProviderObservation,
  normalizedEvent,
  parseNormalizedRuntimeEvent,
  parseRawProviderObservation,
  timelineEntry,
} from '../../src/shared/runtime/event-timeline-contract';
import { RUNTIME_IDENTIFIER_MAX_LENGTH } from '../../src/shared/runtime/runtime-interface';
import { compactDerivedRuntimeIdentifier } from '../../src/shared/runtime/runtime-identifier';

const TIME = '2026-08-25T10:00:00.000Z';

describe('Runtime event identity boundaries', registerBoundaryTests);

function registerBoundaryTests(): void {
  registerDurableIdentityTests();
  registerTimelineIdentityTests();
  registerNonIdentityTests();
}

function registerDurableIdentityTests(): void {
  it.each(durableIdentityCases())('accepts 128 and rejects 129 for durable $name', (testCase) => {
    expect(() => parse(testCase.event(identity(128)))).not.toThrow();
    expect(() => parse(testCase.event(identity(129)))).toThrow();
  });

  it.each(['taskId', 'providerSessionId', 'idempotencyKey'] as const)(
    'bounds durable raw observation %s identity and its derived event ID',
    (field) => {
      const accepted = rawObservation({ [field]: identity(128) });
      expect(accepted.observation.id.length).toBeLessThanOrEqual(RUNTIME_IDENTIFIER_MAX_LENGTH);
      expect(() => parse(accepted)).not.toThrow();
      expect(() => rawObservation({ [field]: identity(129) })).toThrow();
    },
  );
}

function registerTimelineIdentityTests(): void {
  it.each([
    'taskId', 'runId', 'attemptId', 'providerSessionId', 'correlationId',
    'causationId', 'idempotencyKey',
  ] as const)('bounds durable normalized %s identity and its derived event ID', (field) => {
    const accepted = normalizedRecord({ [field]: identity(128) });
    expect(accepted.event.id.length).toBeLessThanOrEqual(RUNTIME_IDENTIFIER_MAX_LENGTH);
    expect(() => parse(accepted)).not.toThrow();
    expect(() => normalizedRecord({ [field]: identity(129) })).toThrow();
  });

  it('bounds raw, normalized, and timeline-entry event identities', () => {
    const raw = rawObservation({}).observation;
    const normalized = normalizedRecord({}).event;
    expect(() => parseRawProviderObservation({ ...raw, id: identity(128) })).not.toThrow();
    expect(() => parseRawProviderObservation({ ...raw, id: identity(129) })).toThrow();
    expect(() => parseNormalizedRuntimeEvent({ ...normalized, id: identity(128) })).not.toThrow();
    expect(() => parseNormalizedRuntimeEvent({ ...normalized, id: identity(129) })).toThrow();
  });

  it('accepts a 128-character Task identity in a complete public timeline and rejects 129', () => {
    expect(() => parseTaskTimelineView(publicTimeline(identity(128)))).not.toThrow();
    expect(() => parseTaskTimelineView(publicTimeline(identity(129)))).toThrow();
  });
}

function registerNonIdentityTests(): void {
  it('retains the separate 512-character durable descriptive-text domains', () => {
    const text = identity(512);
    const created = taskCreated('task');
    expect(() => parse({ ...created, task: { ...created.task, objective: text,
      repository: text, baseRef: text }, fingerprint: text })).not.toThrow();
    expect(() => parse({ ...created,
      task: { ...created.task, objective: identity(513) } })).toThrow();
    expect(() => parse(contextAllocated({ id: 'context', branchName: text,
      baseCommit: text }))).not.toThrow();
    expect(() => parse(contextAllocated({ id: 'context', baseCommit: identity(513) }))).toThrow();
  });

  it('retains the separate 4096-character durable fingerprint domain', () => {
    const created = taskCreated('task');
    expect(() => parse({ ...created, fingerprint: identity(4096) })).not.toThrow();
    expect(() => parse({ ...created, fingerprint: identity(4097) })).toThrow();
  });

  it('compacts derived identities with the standard SHA-256 digest', () => {
    const source = identity(129);
    const expected = createHash('sha256').update(source).digest('hex');
    expect(compactDerivedRuntimeIdentifier(source)).toBe(`runtime-id:sha256:${expected}`);
  });
}

function durableIdentityCases() {
  return [
    { name: 'Task ID', event: (value: string) => taskCreated(value) },
    { name: 'create idempotency key', event: (value: string) =>
      taskCreated('task', { idempotencyKey: value, correlationId: value }) },
    { name: 'run ID', event: (value: string) => runCreated({ run: { id: value, number: 1 } }) },
    { name: 'attempt ID', event: (value: string) => attemptCreated(value) },
    { name: 'context ID', event: (value: string) => contextAllocated({ id: value }) },
    { name: 'worktree ID', event: (value: string) =>
      contextAllocated({ id: 'context', worktreeId: value }) },
    { name: 'process and PTY IDs', event: (value: string) =>
      contextAllocated({ id: 'context', processId: value, ptyId: value }) },
    { name: 'provider-session IDs', event: (value: string) =>
      contextAllocated({ id: 'context' }, providerSession(value)) },
    { name: 'provider-session parent ID', event: (value: string) =>
      contextAllocated({ id: 'context' }, { ...providerSession('session'), parentId: value }) },
    { name: 'provider action key and correlation', event: (value: string) => ({
      type: 'ProviderSessionActionDecided', version: 1, taskId: 'task', action: 'resume',
      providerSessionId: 'missing-session', idempotencyKey: value, correlationId: value,
      fingerprint: JSON.stringify(['resume', 'task', 'missing-session']),
      outcome: 'rejected', decision: null, reason: 'not-found',
    }) },
  ];
}

function taskCreated(taskId: string, changes: Record<string, unknown> = {}) {
  return {
    type: 'TaskCreated', version: 1,
    task: { id: taskId, objective: 'Objective', project: 'Hariari',
      repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude', createdAt: TIME },
    idempotencyKey: 'create-key', correlationId: 'create-correlation',
    fingerprint: 'create-fingerprint', ...changes,
  };
}

function runCreated(changes: Record<string, unknown> = {}) {
  return { type: 'RunCreated', version: 1, taskId: 'task', idempotencyKey: 'start-key',
    correlationId: 'start-correlation', fingerprint: 'start-fingerprint',
    run: { id: 'run', number: 1 }, ...changes };
}

function attemptCreated(id: string) {
  return { type: 'AttemptCreated', version: 1, taskId: 'task',
    attempt: { id, number: 1, state: 'starting' } };
}

function contextAllocated(
  changes: Record<string, unknown>,
  session: Record<string, unknown> | null = null,
) {
  return { type: 'ContextAllocated', version: 1, taskId: 'task', context: {
    id: 'context', worktreeId: 'worktree', branchName: 'branch', baseCommit: 'commit',
    processId: 'process', ptyId: 'pty', ...changes,
  }, providerSession: session, launchOutcome: 'succeeded', observedAt: TIME };
}

function providerSession(value: string) {
  return { id: value, provider: 'claude', nativeSessionId: value, taskId: value,
    attemptId: value, executionContextId: value, capabilities: { resume: true, fork: true },
    parentId: null, lineage: 'new' };
}

function rawObservation(changes: Partial<RawIdentity>) {
  const input = { taskId: 'task', providerSessionId: 'session', idempotencyKey: 'key',
    ...changes };
  const observation = allowlistProviderObservation({ ...input, observedAt: TIME,
    evidence: { provider: 'claude', kind: 'provider-session-observed', sessionState: 'active' } });
  return { type: 'RawProviderObservationRecorded', version: 1, ...input, observation };
}

function normalizedRecord(changes: Partial<NormalizedIdentity>) {
  const input = { taskId: 'task', runId: 'run', attemptId: 'attempt',
    providerSessionId: 'session', correlationId: 'correlation', causationId: 'cause',
    idempotencyKey: 'key', ...changes };
  const event = normalizedEvent({ ...input, kind: 'provider-session-observed', sequence: 1,
    occurrenceAt: TIME, observedAt: TIME });
  return { type: 'NormalizedRuntimeEventRecorded', version: 1, taskId: input.taskId, event };
}

function publicTimeline(taskId: string) {
  const event = normalizedEvent({ taskId, runId: null, attemptId: null,
    providerSessionId: null, kind: 'task-created', correlationId: 'correlation',
    causationId: null, idempotencyKey: 'key', sequence: 1,
    occurrenceAt: TIME, observedAt: TIME });
  return { taskId, status: { task: { id: taskId, objective: 'Objective', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude', createdAt: TIME,
    executionState: 'ready' }, run: null, attempt: null, attempts: [], context: null,
    executionContexts: [], providerSession: null, providerSessions: [] }, rawObservations: [],
    normalizedEvents: [event], timeline: [timelineEntry(event)] };
}

function parse(event: object) {
  return parseTaskEvent(Buffer.from(JSON.stringify(event)));
}

function identity(length: number): string {
  return 'x'.repeat(length);
}

interface RawIdentity {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
}

interface NormalizedIdentity extends RawIdentity {
  readonly runId: string;
  readonly attemptId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

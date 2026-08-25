import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createStartedTask,
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
  type RuntimeSubject,
} from './runtime-task-test-harness';

describe('durable provider action replay authority', () => {
  registerRuntimeTaskTestCleanup();

  it.each(['nonexistent-session', 'wrong-fingerprint', 'action-mismatch'] as const)(
    'rejects checksum-valid exact reattach corruption: %s',
    rejectsExactReattachCorruption,
  );
  it('rejects exact reattach authority owned by another Task', rejectsForeignTaskSession);
  it('rejects conflicting same-key exact reattach correlation', rejectsConflictingCorrelation);
  it('rejects a provider action key reused across Tasks', rejectsCrossTaskActionKey);
  it('rejects an abort not bound to the pending accepted action', rejectsWrongKeyAbort);
});

async function rejectsExactReattachCorruption(
  corruption: 'nonexistent-session' | 'wrong-fingerprint' | 'action-mismatch',
): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaude(runtime, `exact-${corruption}`);
  await runtime.resumeProviderSession({
    taskId: started.task.id, providerSessionId: started.execution.providerSession!.id,
    idempotencyKey: `exact-${corruption}-resume`,
  });
  const records = readTaskEvents(subject.runtimeDirectory);
  const decision = records.find((event) => event.type === 'ProviderSessionActionDecided')!;
  await runtime.disconnect();
  const forged = records.map((event) => event !== decision ? event
    : forgeExactDecision(event, corruption));
  await assertStableInvalidReplay(subject, forged);
}

function forgeExactDecision(
  decision: Record<string, unknown>,
  corruption: 'nonexistent-session' | 'wrong-fingerprint' | 'action-mismatch',
): Record<string, unknown> {
  if (corruption === 'nonexistent-session') {
    return { ...decision, providerSessionId: 'nonexistent-session',
      fingerprint: JSON.stringify(['resume', decision.taskId, 'nonexistent-session']) };
  }
  if (corruption === 'action-mismatch') {
    return { ...decision, action: 'fork',
      fingerprint: JSON.stringify(['fork', decision.taskId, decision.providerSessionId]) };
  }
  return { ...decision, fingerprint: 'forged-fingerprint' };
}

async function rejectsForeignTaskSession(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const first = await startClaude(runtime, 'foreign-session-first');
  const second = await startClaude(runtime, 'foreign-session-second');
  await exactReattach(runtime, first.task.id, first.execution.providerSession!.id, 'foreign-key');
  const records = readTaskEvents(subject.runtimeDirectory);
  const decision = records.find((event) => event.type === 'ProviderSessionActionDecided')!;
  const foreignSessionId = second.execution.providerSession!.id;
  await runtime.disconnect();
  const forged = records.map((event) => event !== decision ? event : {
    ...event, providerSessionId: foreignSessionId,
    fingerprint: JSON.stringify(['resume', first.task.id, foreignSessionId]),
  });
  await assertStableInvalidReplay(subject, forged);
}

async function rejectsConflictingCorrelation(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaude(runtime, 'conflicting-correlation');
  await exactReattach(runtime, started.task.id, started.execution.providerSession!.id,
    'conflicting-correlation-key');
  const records = readTaskEvents(subject.runtimeDirectory);
  const decision = records.find((event) => event.type === 'ProviderSessionActionDecided')!;
  await runtime.disconnect();
  await assertStableInvalidReplay(subject, [
    ...records, { ...decision, correlationId: 'forged-retry-correlation' },
  ]);
}

async function rejectsCrossTaskActionKey(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter();
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const first = await startClaude(runtime, 'cross-key-first');
  const second = await startClaude(runtime, 'cross-key-second');
  await exactReattach(runtime, first.task.id, first.execution.providerSession!.id, 'shared-key');
  await exactReattach(runtime, second.task.id, second.execution.providerSession!.id, 'second-key');
  const records = readTaskEvents(subject.runtimeDirectory);
  const decisions = records.filter((event) => event.type === 'ProviderSessionActionDecided');
  await runtime.disconnect();
  const forged = records.map((event) => event !== decisions[1] ? event : {
    ...event, idempotencyKey: 'shared-key', correlationId: decisions[0]!.correlationId,
  });
  await assertStableInvalidReplay(subject, forged);
}

async function rejectsWrongKeyAbort(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopError: new Error('parent remains live') });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const started = await startClaude(runtime, 'wrong-abort');
  await expect(runtime.forkProviderSession({
    taskId: started.task.id, providerSessionId: started.execution.providerSession!.id,
    idempotencyKey: 'authoritative-fork-key',
  })).rejects.toMatchObject({ code: 'internal' });
  const projection = await runtime.getTaskExecution(started.task.id);
  const records = readTaskEvents(subject.runtimeDirectory);
  const abort = records.find((event) => event.type === 'ProviderSessionActionAborted')!;
  expect(projection).toMatchObject({ attempt: { state: 'running' } });
  await runtime.disconnect();
  const forged = records.map((event) => event !== abort ? event
    : { ...event, idempotencyKey: 'forged-unrelated-key' });
  await assertStableInvalidReplay(subject, forged);
}

function exactReattach(
  runtime: RuntimeClientSession,
  taskId: string,
  providerSessionId: string,
  idempotencyKey: string,
) {
  return runtime.resumeProviderSession({ taskId, providerSessionId, idempotencyKey });
}

function startClaude(runtime: RuntimeClientSession, key: string) {
  return createStartedTask(runtime, {
    objective: `Validate ${key}.`, project: 'Hariari', repository: 'fake-local-checkout',
    baseRef: 'HEAD', provider: 'claude', idempotencyKey: `${key}-create`,
  }, `${key}-start`);
}

async function assertStableInvalidReplay(
  subject: RuntimeSubject,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  rewriteTaskEvents(subject.runtimeDirectory, events);
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  const bytes = fs.readFileSync(eventPath);
  await expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
  expect(fs.readFileSync(eventPath)).toEqual(bytes);
  await expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
  expect(fs.readFileSync(eventPath)).toEqual(bytes);
}

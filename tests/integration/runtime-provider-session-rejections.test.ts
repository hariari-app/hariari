import { describe, expect, it } from 'vitest';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  appendLegacyTaskEvent,
  createSubject,
  registerRuntimeTaskTestCleanup,
  type RuntimeSubject,
} from './runtime-task-test-harness';

describe('authenticated provider-session semantic rejections', () => {
  registerRuntimeTaskTestCleanup();
  it('durably rejects unknown fork targets and preserves key conflicts', rejectsUnknownFork);
  it('durably rejects a noncurrent parent fork', rejectsNoncurrentFork);
  it('durably rejects a terminal current fork', rejectsTerminalFork);
  it('durably rejects an unsupported fork', rejectsUnsupportedFork);
  it('durably rejects a second action while the parent is superseding', rejectsSupersedingFork);
  it('maps a legacy Claude rejection into provider-neutral idempotent replay', replaysLegacyRejection);
});

async function rejectsUnknownFork(): Promise<void> {
  const { subject, taskId, sessionId } = await startedSubject();
  const runtime = await subject.connect();
  const request = { taskId, providerSessionId: 'unknown-session', idempotencyKey: 'unknown-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('not-found', false));
  await expect(runtime.forkProviderSession({ ...request, providerSessionId: sessionId }))
    .rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await runtime.disconnect();
  await assertRestartedRejection(subject, request, 'not-found');
}

async function rejectsNoncurrentFork(): Promise<void> {
  const { subject, taskId, sessionId } = await startedSubject();
  const runtime = await subject.connect();
  await runtime.forkProviderSession({ taskId, providerSessionId: sessionId,
    idempotencyKey: 'first-fork' });
  const request = { taskId, providerSessionId: sessionId, idempotencyKey: 'stale-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
  await assertRestartedRejection(subject, request, 'task-not-ready');
}

async function rejectsTerminalFork(): Promise<void> {
  const { subject, taskId, sessionId } = await startedSubject();
  const runtime = await subject.connect();
  await runtime.cancelTask({ taskId, idempotencyKey: 'terminal-cancel' });
  const request = { taskId, providerSessionId: sessionId, idempotencyKey: 'terminal-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
  await assertRestartedRejection(subject, request, 'task-not-ready');
}

async function rejectsUnsupportedFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({
    claudeCapabilities: { resume: true, fork: false },
  });
  const { subject, taskId, sessionId } = await startedSubject(adapter);
  const runtime = await subject.connect();
  const request = { taskId, providerSessionId: sessionId, idempotencyKey: 'unsupported-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await runtime.disconnect();
  await assertRestartedRejection(subject, request, 'unsupported-operation');
}

async function rejectsSupersedingFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ stopError: new Error('stop failed') });
  const { subject, taskId, sessionId } = await startedSubject(adapter);
  const runtime = await subject.connect();
  adapter.forget(taskId);
  await expect(runtime.forkProviderSession({ taskId, providerSessionId: sessionId,
    idempotencyKey: 'ambiguous-fork' })).rejects.toEqual(new RuntimePortError('internal', true));
  await expect(runtime.resumeProviderSession({ taskId, providerSessionId: sessionId,
    idempotencyKey: 'ambiguous-fork' }))
    .rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  const request = { taskId, providerSessionId: sessionId, idempotencyKey: 'superseding-fork' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('task-not-ready', false));
  await runtime.disconnect();
  await assertRestartedRejection(subject, request, 'task-not-ready');
}

async function replaysLegacyRejection(): Promise<void> {
  const { subject, taskId, sessionId } = await startedSubject();
  await appendLegacyTaskEvent(subject.runtimeDirectory, {
    type: 'ClaudeResumeRejected', version: 1, taskId,
    providerSessionId: sessionId, idempotencyKey: 'legacy-rejection',
    fingerprint: 'legacy-scope-fingerprint', reason: 'unsupported',
  });
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.resumeProviderSession({ taskId, providerSessionId: sessionId,
    idempotencyKey: 'legacy-rejection' }))
    .rejects.toEqual(new RuntimePortError('unsupported-operation', false));
  await restarted.disconnect();
}

async function startedSubject(adapter = new FakeClaudeCodeExecutionAdapter()): Promise<{
  readonly subject: RuntimeSubject; readonly taskId: string; readonly sessionId: string;
}> {
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Reject an invalid provider action.',
    project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude',
    idempotencyKey: 'provider-rejection-create' });
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: `start-${task.id}` });
  await runtime.disconnect();
  return { subject, taskId: task.id, sessionId: started.providerSession!.id };
}

async function assertRestartedRejection(
  subject: RuntimeSubject,
  request: { readonly taskId: string; readonly providerSessionId: string;
    readonly idempotencyKey: string },
  code: 'not-found' | 'task-not-ready' | 'unsupported-operation',
): Promise<void> {
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError(code, false));
  await restarted.disconnect();
}

import { describe, expect, it } from 'vitest';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import { GenericCliExecutionError } from '../../src/runtime/generic-cli-execution-adapter';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createSubject,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

describe('authenticated provider-session fork failure recovery', () => {
  registerRuntimeTaskTestCleanup();
  it('keeps the parent superseded and replays a failed child without relaunch', replaysFailedFork);
});

async function replaysFailedFork(): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({
    startError: (request) => request.attempt.number === 2
      ? new GenericCliExecutionError('process-start-failed') : undefined,
  });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const task = await runtime.createTask({ objective: 'Fail one fork child.',
    project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider: 'claude',
    idempotencyKey: 'fork-failure-create' });
  const parent = await runtime.startTask({ taskId: task.id, idempotencyKey: 'fork-failure-start' });
  const request = { taskId: task.id, providerSessionId: parent.providerSession!.id,
    idempotencyKey: 'fork-child-failure' };
  await expect(runtime.forkProviderSession(request))
    .rejects.toEqual(new RuntimePortError('process-start-failed', true));
  const failed = await runtime.getTaskExecution(task.id);
  expect(failed).toMatchObject({ attempt: { number: 2, state: 'failed' },
    attempts: [{ id: parent.attempt?.id, state: 'superseded' },
      { number: 2, state: 'failed' }] });
  expect(adapter.hasRunning(task.id)).toBe(false);
  await expect(runtime.forkProviderSession(request)).resolves.toEqual(failed);
  await runtime.disconnect(); await subject.restart(); const restarted = await subject.connect();
  await expect(restarted.forkProviderSession(request)).resolves.toEqual(failed);
  expect(adapter.startCount(task.id)).toBe(2);
  await restarted.disconnect();
}

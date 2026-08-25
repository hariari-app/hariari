import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  RuntimePortError,
  type RuntimeClientSession,
} from '../../src/main/runtime/runtime-ports';
import { RUNTIME_IDENTIFIER_MAX_LENGTH } from '../../src/shared/runtime/runtime-interface';
import {
  FakeClaudeCodeExecutionAdapter,
} from './runtime-test-fakes';
import {
  createSubject,
  registerRuntimeTaskTestCleanup,
  type RuntimeSubject,
} from './runtime-task-test-harness';

const MAXIMUM_KEY = 'x'.repeat(RUNTIME_IDENTIFIER_MAX_LENGTH);
const OVERLONG_KEY = `${MAXIMUM_KEY}x`;

interface PreparedMutation {
  readonly effectCount: () => number;
  readonly expected: Record<string, unknown>;
  readonly invoke: (runtime: RuntimeClientSession, key: string) => Promise<unknown>;
}

interface MutationBoundary {
  readonly name: string;
  readonly prepare: (
    runtime: RuntimeClientSession,
    adapter: FakeClaudeCodeExecutionAdapter,
  ) => Promise<PreparedMutation>;
}

const MUTATION_BOUNDARIES: readonly MutationBoundary[] = [
  { name: 'create', prepare: prepareCreate },
  { name: 'start', prepare: prepareStart },
  { name: 'cancel', prepare: prepareCancel },
  { name: 'provider resume', prepare: prepareResume },
  { name: 'provider fork', prepare: prepareFork },
  { name: 'reconcile', prepare: prepareReconcile },
  { name: 'recover', prepare: prepareRecover },
];

registerRuntimeTaskTestCleanup();

it.each(MUTATION_BOUNDARIES)(
  'enforces the shared idempotency identity boundary before $name append or execution',
  verifiesMutationBoundary,
);

it('enforces the shared idempotency identity boundary before shutdown', async () => {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  const health = await runtime.queryHealth();

  await expect(runtime.shutdown(shutdownRequest(health.instanceId, OVERLONG_KEY)))
    .rejects.toEqual(new RuntimePortError('invalid-request', false));
  await expect(runtime.queryHealth()).resolves.toMatchObject({ instanceId: health.instanceId });
  await runtime.disconnect();
  await subject.restart();
  const restarted = await subject.connect();
  const restartedHealth = await restarted.queryHealth();
  await expect(restarted.shutdown(shutdownRequest(restartedHealth.instanceId, MAXIMUM_KEY)))
    .resolves.toEqual({ state: 'stopped', instanceId: restartedHealth.instanceId });
});

async function verifiesMutationBoundary(boundary: MutationBoundary): Promise<void> {
  const adapter = new FakeClaudeCodeExecutionAdapter({ autoExitOnStop: false });
  const subject = await createSubject(() => adapter);
  const runtime = await subject.connect();
  const prepared = await boundary.prepare(runtime, adapter);
  const before = eventBytes(subject);
  const effectsBefore = prepared.effectCount();

  await expect(prepared.invoke(runtime, OVERLONG_KEY))
    .rejects.toEqual(new RuntimePortError('invalid-request', false));
  expect(eventBytes(subject)).toEqual(before);
  expect(prepared.effectCount()).toBe(effectsBefore);
  await expect(runtime.queryHealth()).resolves.toMatchObject({ status: 'ready' });

  const restarted = await restart(subject, runtime);
  await expect(prepared.invoke(restarted, MAXIMUM_KEY)).resolves.toMatchObject(prepared.expected);
  expect(eventBytes(subject)).not.toEqual(before);
  await restarted.disconnect();
}

async function prepareCreate(): Promise<PreparedMutation> {
  return {
    effectCount: () => 0,
    expected: { objective: 'Validate the public request identity boundary.' },
    invoke: (runtime, idempotencyKey) => runtime.createTask(taskRequest(idempotencyKey)),
  };
}

async function prepareStart(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const task = await createClaudeTask(runtime, 'start');
  return {
    effectCount: () => adapter.startCount(task.id),
    expected: { task: { id: task.id, executionState: 'running' } },
    invoke: (client, idempotencyKey) => client.startTask({ taskId: task.id, idempotencyKey }),
  };
}

async function prepareCancel(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const task = await createClaudeTask(runtime, 'cancel');
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'cancel-start' });
  return {
    effectCount: () => adapter.stopCount(task.id),
    expected: { task: { id: task.id, executionState: 'cancelled' } },
    invoke: (client, idempotencyKey) => completeStop(
      adapter,
      task.id,
      idempotencyKey,
      client.cancelTask({ taskId: task.id, idempotencyKey }),
    ),
  };
}

async function prepareResume(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const { taskId, providerSessionId } = await startedClaude(runtime, 'resume');
  return providerMutation(adapter, taskId, providerSessionId, 'resume');
}

async function prepareFork(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const { taskId, providerSessionId } = await startedClaude(runtime, 'fork');
  return providerMutation(adapter, taskId, providerSessionId, 'fork');
}

function providerMutation(
  adapter: FakeClaudeCodeExecutionAdapter,
  taskId: string,
  providerSessionId: string,
  action: 'resume' | 'fork',
): PreparedMutation {
  const request = (idempotencyKey: string) => ({
    taskId, providerSessionId, idempotencyKey,
  });
  return {
    effectCount: () => adapter.startCount(taskId) + adapter.stopCount(taskId),
    expected: { task: { id: taskId, executionState: 'running' } },
    invoke: action === 'resume'
      ? (runtime, key) => runtime.resumeProviderSession(request(key))
      : (runtime, key) => completeStop(
          adapter,
          taskId,
          key,
          runtime.forkProviderSession(request(key)),
        ),
  };
}

async function prepareReconcile(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const { taskId } = await startedClaude(runtime, 'reconcile');
  return {
    effectCount: () => adapter.recoveryObservationCount(taskId),
    expected: { taskId },
    invoke: (client, idempotencyKey) => client.reconcileTask({ taskId, idempotencyKey }),
  };
}

async function prepareRecover(
  runtime: RuntimeClientSession,
  adapter: FakeClaudeCodeExecutionAdapter,
): Promise<PreparedMutation> {
  const { taskId } = await startedClaude(runtime, 'recover');
  const recovery = await runtime.reconcileTask({ taskId, idempotencyKey: 'recover-reconcile' });
  return {
    effectCount: () => adapter.recoveryObservationCount(taskId),
    expected: { taskId },
    invoke: (client, idempotencyKey) => client.recoverTask({
      taskId, recoveryId: recovery.id, idempotencyKey,
    }),
  };
}

async function startedClaude(runtime: RuntimeClientSession, name: string) {
  const task = await createClaudeTask(runtime, name);
  const started = await runtime.startTask({ taskId: task.id, idempotencyKey: `${name}-start` });
  return { taskId: task.id, providerSessionId: started.providerSession!.id };
}

function createClaudeTask(runtime: RuntimeClientSession, name: string) {
  return runtime.createTask(taskRequest(`${name}-create`));
}

function taskRequest(idempotencyKey: string) {
  return {
    objective: 'Validate the public request identity boundary.',
    project: 'Hariari',
    repository: 'fake-local-checkout',
    baseRef: 'HEAD',
    provider: 'claude' as const,
    idempotencyKey,
  };
}

function shutdownRequest(instanceId: string, idempotencyKey: string) {
  return { expectedInstanceId: instanceId, reason: 'test' as const, idempotencyKey };
}

function eventBytes(subject: RuntimeSubject): Buffer {
  const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
  return fs.existsSync(eventPath) ? fs.readFileSync(eventPath) : Buffer.alloc(0);
}

async function restart(
  subject: RuntimeSubject,
  runtime: RuntimeClientSession,
): Promise<RuntimeClientSession> {
  await runtime.disconnect();
  await subject.restart();
  return subject.connect();
}

async function completeStop<T>(
  adapter: FakeClaudeCodeExecutionAdapter,
  taskId: string,
  key: string,
  result: Promise<T>,
): Promise<T> {
  if (key.length <= RUNTIME_IDENTIFIER_MAX_LENGTH) {
    await adapter.waitForStop(taskId);
    adapter.exit(taskId, 23);
  }
  return result;
}

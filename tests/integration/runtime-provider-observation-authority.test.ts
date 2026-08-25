import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
} from './runtime-task-test-harness';

describe('authenticated provider observation authority', () => {
  registerRuntimeTaskTestCleanup();

  it.each([
    { name: 'null', observation: null },
    { name: 'invalid', observation: { provider: 'claude', sessionState: 'active' } },
  ])('rejects a $name observation before durable provider/start authority', async ({ name, observation }) => {
    let clock = Date.parse('2026-08-25T10:00:00.000Z');
    const adapter = new FakeClaudeCodeExecutionAdapter({ providerObservation: () => observation });
    const subject = await createSubject(() => adapter, () => clock);
    const runtime = await subject.connect();
    const task = await runtime.createTask({
      objective: 'Reject unauthenticated provider evidence.', project: 'Hariari',
      repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
      idempotencyKey: `invalid-observation-${name}-create`,
    });
    const request = { taskId: task.id, idempotencyKey: `invalid-observation-${name}-start` };

    await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
    const failedBytes = fs.readFileSync(eventPath);
    expect(readTaskEvents(subject.runtimeDirectory).map((event) => event.type)).toEqual([
      'TaskCreated', 'NormalizedRuntimeEventRecorded', 'RunCreated', 'AttemptCreated',
    ]);
    await expect(runtime.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    expect(fs.readFileSync(eventPath)).toEqual(failedBytes);

    await runtime.disconnect();
    clock = Date.parse('2026-08-25T11:00:00.000Z');
    await subject.restart();
    await subject.restart();
    expect(fs.readFileSync(eventPath)).toEqual(failedBytes);
    const restarted = await subject.connect();
    await expect(restarted.startTask(request)).rejects.toEqual(new RuntimePortError('internal', true));
    expect(fs.readFileSync(eventPath)).toEqual(failedBytes);
    expect(adapter.startCount(task.id)).toBe(3);
    await restarted.disconnect();
  });
});

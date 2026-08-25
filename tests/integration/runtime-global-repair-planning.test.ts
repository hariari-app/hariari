import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStorageError } from '../../src/runtime/task-storage-error';
import { FakeClaudeCodeExecutionAdapter } from './runtime-test-fakes';
import {
  createStartedTask,
  createSubject,
  readTaskEvents,
  registerRuntimeTaskTestCleanup,
  rewriteTaskEvents,
} from './runtime-task-test-harness';

describe('global Runtime event-history repair planning', () => {
  registerRuntimeTaskTestCleanup();

  it('validates every Task before appending an earlier Task repair', async () => {
    const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
    const runtime = await subject.connect();
    const first = await runtime.createTask(taskRequest('a-repairable'));
    const second = await createStartedTask(runtime, taskRequest('b-corrupt'), 'b-start');
    const records = corruptLaterTask(readTaskEvents(subject.runtimeDirectory),
      first.id, second.task.id);
    await runtime.disconnect();
    await subject.stop();
    rewriteTaskEvents(subject.runtimeDirectory, records);
    const eventPath = path.join(subject.runtimeDirectory, 'tasks', 'events.log');
    const bytes = fs.readFileSync(eventPath);

    await expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
    expect(fs.readFileSync(eventPath)).toEqual(bytes);
    await expect(subject.restart()).rejects.toEqual(new TaskStorageError('event-history-invalid'));
    expect(fs.readFileSync(eventPath)).toEqual(bytes);
  });
});

function corruptLaterTask(
  events: readonly Record<string, unknown>[],
  repairableTaskId: string,
  corruptTaskId: string,
): readonly Record<string, unknown>[] {
  const contextIndex = events.findIndex((event) =>
    event.type === 'ContextAllocated' && event.taskId === corruptTaskId);
  if (contextIndex < 0) throw new Error('missing later Task context');
  return events.slice(0, contextIndex + 1).flatMap((event) => {
    const normalized = event.event as { readonly kind?: unknown } | undefined;
    if (event.type === 'NormalizedRuntimeEventRecorded' &&
      event.taskId === repairableTaskId && normalized?.kind === 'task-created') return [];
    if (event.type !== 'ContextAllocated' || event.taskId !== corruptTaskId) return [event];
    const { launchOutcome: _legacyAmbiguity, ...ambiguous } = event;
    return [ambiguous];
  });
}

function taskRequest(idempotencyKey: string) {
  return {
    objective: `Validate ${idempotencyKey}.`, project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude' as const,
    idempotencyKey,
  };
}

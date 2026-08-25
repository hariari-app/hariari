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
  type RuntimeSubject,
} from './runtime-task-test-harness';

describe('durable v1 parser authority on restart', () => {
  registerRuntimeTaskTestCleanup();

  it.each(['missing-provider-session', 'invalid-task-provider'] as const)(
    'stably rejects checksum-valid %s records without durable mutation',
    rejectsParserCorruption,
  );
});

async function rejectsParserCorruption(
  corruption: 'missing-provider-session' | 'invalid-task-provider',
): Promise<void> {
  const subject = await createSubject(() => new FakeClaudeCodeExecutionAdapter());
  const runtime = await subject.connect();
  await createStartedTask(runtime, {
    objective: 'Reject loose durable parsing.', project: 'Hariari',
    repository: 'fake-local-checkout', baseRef: 'HEAD', provider: 'claude',
    idempotencyKey: `${corruption}-create`,
  }, `${corruption}-start`);
  const records = readTaskEvents(subject.runtimeDirectory).map((event) => {
    if (corruption === 'invalid-task-provider' && event.type === 'TaskCreated') {
      return { ...event, task: { ...(event.task as object), provider: 'attacker-provider' } };
    }
    if (corruption === 'missing-provider-session' && event.type === 'ContextAllocated') {
      const { providerSession: _required, ...withoutProviderSession } = event;
      return withoutProviderSession;
    }
    return event;
  });
  await runtime.disconnect();
  await assertStableInvalidReplay(subject, records);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskEventStore } from '../../src/runtime/task-event-store';
import type { TaskEvent } from '../../src/runtime/task-events';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('validates canonical events before append and exposes only the validated event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-task-event-store-'));
  roots.push(root);
  const eventPath = path.join(root, 'tasks', 'events.log');
  const applied: TaskEvent[] = [];
  const store = eventStore(root);
  await store.start((event) => applied.push(event), () => []);

  await expect(store.appendVisible(
    taskCreated('x'.repeat(129)),
    (event) => applied.push(event),
    () => [],
  )).rejects.toThrow();
  expect(readEventBytes(eventPath)).toHaveLength(0);
  expect(applied).toEqual([]);

  const valid = taskCreated('valid-create-key');
  await store.appendVisible(valid, (event) => applied.push(event), () => []);
  expect(applied).toEqual([valid]);
  expect(applied[0]).not.toBe(valid);
  const durable = readEventBytes(eventPath);
  expect(durable.length).toBeGreaterThan(0);

  const replayed: TaskEvent[] = [];
  await eventStore(root).start((event) => replayed.push(event), () => []);
  expect(replayed).toEqual([valid]);
  expect(readEventBytes(eventPath)).toEqual(durable);
});

function eventStore(root: string): TaskEventStore {
  return new TaskEventStore(root, () => 'projection-temporary');
}

function readEventBytes(eventPath: string): Buffer {
  return fs.existsSync(eventPath) ? fs.readFileSync(eventPath) : Buffer.alloc(0);
}

function taskCreated(idempotencyKey: string): TaskEvent {
  return {
    type: 'TaskCreated',
    version: 1,
    task: {
      id: 'task-1',
      objective: 'Validate before append.',
      project: 'Hariari',
      repository: 'hariari-app/hariari',
      baseRef: 'main',
      provider: 'codex',
      createdAt: '2026-08-25T10:00:00.000Z',
    },
    idempotencyKey,
    correlationId: 'create-correlation',
    fingerprint: 'create-fingerprint',
  };
}

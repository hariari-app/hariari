import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CreateTaskRequest, TaskView } from '../shared/runtime/runtime-interface';

const EVENT_FILE = 'events.log';
const PROJECTION_FILE = 'projection.json';
const EVENT_HEADER_BYTES = 36;
const MAX_EVENT_BYTES = 16 * 1024;

export class TaskStorageError extends Error {
  constructor(readonly code: 'idempotency-conflict' | 'internal') {
    super(`Task storage failed: ${code}`);
    this.name = 'TaskStorageError';
  }
}

interface TaskCreatedEvent {
  readonly type: 'TaskCreated';
  readonly version: 1;
  readonly task: TaskView;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/** Runtime-owned Task state. Event history is authoritative; projection is disposable. */
export class TaskModule {
  private readonly directory: string;
  private readonly eventPath: string;
  private readonly projectionPath: string;
  private readonly tasks = new Map<string, TaskView>();
  private readonly fingerprints = new Map<string, string>();
  private mutation: Promise<void> = Promise.resolve();
  private poisoned = false;

  constructor(
    runtimeDirectory: string,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {
    this.directory = path.join(runtimeDirectory, 'tasks');
    this.eventPath = path.join(this.directory, EVENT_FILE);
    this.projectionPath = path.join(this.directory, PROJECTION_FILE);
  }

  async start(): Promise<void> {
    try {
      await ensurePrivateDirectory(this.directory);
      await verifyProtectedFile(this.eventPath);
      await verifyProtectedFile(this.projectionPath);
      await this.replay();
      await this.writeProjection();
    } catch (error) {
      if (error instanceof TaskStorageError) throw error;
      throw new TaskStorageError('internal');
    }
  }

  create(request: CreateTaskRequest): Promise<TaskView> {
    return this.enqueue(async () => {
      if (this.poisoned) throw new TaskStorageError('internal');
      const fingerprint = canonicalFingerprint(request);
      const existing = this.tasks.get(request.idempotencyKey);
      if (existing) {
        if (this.fingerprints.get(request.idempotencyKey) === fingerprint) return existing;
        throw new TaskStorageError('idempotency-conflict');
      }
      const task: TaskView = {
        id: this.randomId(),
        objective: request.objective,
        project: request.project,
        repository: request.repository,
        baseRef: request.baseRef,
        provider: request.provider,
        createdAt: new Date(this.now()).toISOString(),
      };
      const event: TaskCreatedEvent = {
        type: 'TaskCreated',
        version: 1,
        task,
        idempotencyKey: request.idempotencyKey,
        fingerprint,
      };
      await this.append(event);
      this.tasks.set(request.idempotencyKey, task);
      this.fingerprints.set(request.idempotencyKey, fingerprint);
      await this.writeProjection();
      return task;
    });
  }

  list(): readonly TaskView[] {
    return [...this.tasks.values()];
  }

  private async replay(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(this.eventPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }
    let offset = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < EVENT_HEADER_BYTES) {
        await fs.promises.truncate(this.eventPath, offset);
        break;
      }
      const length = bytes.readUInt32BE(offset);
      if (
        length === 0 ||
        length > MAX_EVENT_BYTES ||
        offset + EVENT_HEADER_BYTES + length > bytes.length
      ) {
        if (offset + EVENT_HEADER_BYTES + length > bytes.length) {
          await fs.promises.truncate(this.eventPath, offset);
          break;
        }
        throw new TaskStorageError('internal');
      }
      const checksum = bytes.subarray(offset + 4, offset + EVENT_HEADER_BYTES);
      const payload = bytes.subarray(
        offset + EVENT_HEADER_BYTES,
        offset + EVENT_HEADER_BYTES + length,
      );
      if (!createHash('sha256').update(payload).digest().equals(checksum)) {
        throw new TaskStorageError('internal');
      }
      this.apply(parseEvent(payload));
      offset += EVENT_HEADER_BYTES + length;
    }
  }

  private apply(event: TaskCreatedEvent): void {
    const key = event.idempotencyKey;
    const existing = this.tasks.get(key);
    if (
      existing &&
      (existing.id !== event.task.id || this.fingerprints.get(key) !== event.fingerprint)
    ) {
      throw new TaskStorageError('internal');
    }
    this.tasks.set(key, event.task);
    this.fingerprints.set(key, event.fingerprint);
  }

  private async append(event: TaskCreatedEvent): Promise<void> {
    await verifyProtectedFile(this.eventPath);
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    if (payload.length > MAX_EVENT_BYTES) throw new TaskStorageError('internal');
    const header = Buffer.alloc(EVENT_HEADER_BYTES);
    header.writeUInt32BE(payload.length, 0);
    createHash('sha256').update(payload).digest().copy(header, 4);
    const frame = Buffer.concat([header, payload]);
    const handle = await fs.promises.open(this.eventPath, 'a', 0o600);
    try {
      const startOffset = (await handle.stat()).size;
      let offset = 0;
      try {
        while (offset < frame.length) {
          const { bytesWritten } = await handle.write(frame.subarray(offset));
          if (bytesWritten === 0) throw new TaskStorageError('internal');
          offset += bytesWritten;
        }
        await handle.sync();
      } catch (error) {
        if (offset < frame.length) {
          await this.repairIncompleteAppend(handle, startOffset);
        } else {
          this.poisoned = true;
        }
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  private async repairIncompleteAppend(
    handle: fs.promises.FileHandle,
    offset: number,
  ): Promise<void> {
    try {
      await handle.truncate(offset);
      await handle.sync();
    } catch {
      this.poisoned = true;
      throw new TaskStorageError('internal');
    }
  }

  private async writeProjection(): Promise<void> {
    const temporaryPath = `${this.projectionPath}.${this.randomId()}.tmp`;
    const contents = JSON.stringify({ version: 1, tasks: this.list() });
    const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporaryPath, this.projectionPath);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function canonicalFingerprint(request: CreateTaskRequest): string {
  return JSON.stringify([
    request.objective,
    request.project,
    request.repository,
    request.baseRef,
    request.provider,
  ]);
}

function parseEvent(payload: Buffer): TaskCreatedEvent {
  try {
    const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    const task = value.task as Record<string, unknown>;
    if (
      value.type !== 'TaskCreated' ||
      value.version !== 1 ||
      typeof value.fingerprint !== 'string' ||
      !task ||
      typeof task !== 'object' ||
      typeof value.idempotencyKey !== 'string' ||
      typeof task.id !== 'string' ||
      typeof task.objective !== 'string' ||
      typeof task.project !== 'string' ||
      typeof task.repository !== 'string' ||
      typeof task.baseRef !== 'string' ||
      typeof task.provider !== 'string' ||
      typeof task.createdAt !== 'string'
    )
      throw new Error('invalid event');
    return {
      type: 'TaskCreated',
      version: 1,
      fingerprint: value.fingerprint,
      idempotencyKey: value.idempotencyKey,
      task: task as unknown as TaskView,
    };
  } catch {
    throw new TaskStorageError('internal');
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TaskStorageError('internal');
  if (
    process.platform !== 'win32' &&
    ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
  ) {
    throw new TaskStorageError('internal');
  }
}

async function verifyProtectedFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TaskStorageError('internal');
    if (
      process.platform !== 'win32' &&
      ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
    ) {
      throw new TaskStorageError('internal');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw error;
  }
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskView } from '../shared/runtime/runtime-interface';
import { parseTaskEvent, type TaskEvent } from './task-events';

const EVENT_FILE = 'events.log';
const PROJECTION_FILE = 'projection.json';
const EVENT_HEADER_BYTES = 36;
const MAX_EVENT_BYTES = 16 * 1024;

export class TaskEventStoreError extends Error {}

/** Durable framed Task event log with append-before-apply ordering and projection repair. */
export class TaskEventStore {
  private readonly directory: string;
  private readonly eventPath: string;
  private readonly projectionPath: string;
  private poisoned = false;

  constructor(
    runtimeDirectory: string,
    private readonly randomId: () => string,
  ) {
    this.directory = path.join(runtimeDirectory, 'tasks');
    this.eventPath = path.join(this.directory, EVENT_FILE);
    this.projectionPath = path.join(this.directory, PROJECTION_FILE);
  }

  async start(apply: (event: TaskEvent) => void, tasks: () => readonly TaskView[]): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await verifyProtectedFile(this.eventPath);
    await verifyProtectedFile(this.projectionPath);
    await this.replay(apply);
    await this.writeProjection(tasks());
  }

  async appendVisible(
    event: TaskEvent,
    apply: (event: TaskEvent) => void,
    tasks: () => readonly TaskView[],
  ): Promise<void> {
    this.throwIfPoisoned();
    const validated = await this.append(event);
    apply(validated);
    await this.writeProjection(tasks());
  }

  throwIfPoisoned(): void {
    if (this.poisoned) throw new TaskEventStoreError();
  }

  private async replay(apply: (event: TaskEvent) => void): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(this.eventPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }
    let offset = 0;
    while (offset < bytes.length) offset = await this.replayFrame(bytes, offset, apply);
  }

  private async replayFrame(
    bytes: Buffer,
    offset: number,
    apply: (event: TaskEvent) => void,
  ): Promise<number> {
    if (bytes.length - offset < EVENT_HEADER_BYTES) return this.truncateReplay(offset);
    const length = bytes.readUInt32BE(offset);
    const end = offset + EVENT_HEADER_BYTES + length;
    if (length === 0 || length > MAX_EVENT_BYTES || end > bytes.length) {
      if (end > bytes.length) return this.truncateReplay(offset);
      throw new TaskEventStoreError();
    }
    const checksum = bytes.subarray(offset + 4, offset + EVENT_HEADER_BYTES);
    const payload = bytes.subarray(offset + EVENT_HEADER_BYTES, end);
    if (!createHash('sha256').update(payload).digest().equals(checksum)) {
      throw new TaskEventStoreError();
    }
    apply(parseTaskEvent(payload));
    return end;
  }

  private async truncateReplay(offset: number): Promise<number> {
    await fs.promises.truncate(this.eventPath, offset);
    return Number.MAX_SAFE_INTEGER;
  }

  private async append(event: TaskEvent): Promise<TaskEvent> {
    await verifyProtectedFile(this.eventPath);
    const payload = Buffer.from(JSON.stringify(event), 'utf8');
    const validated = parseTaskEvent(payload);
    if (payload.length > MAX_EVENT_BYTES) throw new TaskEventStoreError();
    const frame = framed(payload);
    const handle = await fs.promises.open(this.eventPath, 'a', 0o600);
    try {
      await this.writeFrame(handle, frame);
    } finally {
      await handle.close();
    }
    return validated;
  }

  private async writeFrame(handle: fs.promises.FileHandle, frame: Buffer): Promise<void> {
    const startOffset = (await handle.stat()).size;
    let offset = 0;
    try {
      while (offset < frame.length) {
        const { bytesWritten } = await handle.write(frame.subarray(offset));
        if (bytesWritten === 0) throw new TaskEventStoreError();
        offset += bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      if (offset < frame.length) await this.repairIncompleteAppend(handle, startOffset);
      else this.poisoned = true;
      throw error;
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
      throw new TaskEventStoreError();
    }
  }

  private async writeProjection(tasks: readonly TaskView[]): Promise<void> {
    const temporaryPath = `${this.projectionPath}.${this.randomId()}.tmp`;
    const handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 2, tasks }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporaryPath, this.projectionPath);
  }
}

function framed(payload: Buffer): Buffer {
  const header = Buffer.alloc(EVENT_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  createHash('sha256').update(payload).digest().copy(header, 4);
  return Buffer.concat([header, payload]);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TaskEventStoreError();
  if (process.platform !== 'win32' &&
    ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())) {
    throw new TaskEventStoreError();
  }
}

async function verifyProtectedFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TaskEventStoreError();
    if (process.platform !== 'win32' &&
      ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())) {
      throw new TaskEventStoreError();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw error;
  }
}

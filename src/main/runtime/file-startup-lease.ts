import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeStartupLease, RuntimeStartupLeasePort } from './runtime-ports';

const OWNER_FILE = 'owner.json';
const OWNER_SCHEMA_VERSION = 1;

interface StartupLeaseOwner {
  readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
  readonly processId: number;
  readonly leaseId: string;
  readonly deadlineAt: number;
}

export interface FileRuntimeStartupLeaseOptions {
  readonly processId?: number;
  readonly randomId?: () => string;
  readonly isProcessAlive?: (processId: number) => boolean;
}

export class FileRuntimeStartupLeasePort implements RuntimeStartupLeasePort {
  private readonly leasePath: string;
  private readonly processId: number;
  private readonly createId: () => string;
  private readonly isProcessAlive: (processId: number) => boolean;

  constructor(
    private readonly runtimeDirectory: string,
    options: FileRuntimeStartupLeaseOptions = {},
  ) {
    this.leasePath = path.join(runtimeDirectory, 'startup.lock');
    this.processId = options.processId ?? process.pid;
    this.createId = options.randomId ?? randomUUID;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
  }

  async acquire(deadlineAt: number): Promise<RuntimeStartupLease | null> {
    await this.ensurePrivateRuntimeDirectory();
    const owner = this.createOwner(deadlineAt);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidatePath = await this.createCandidate(owner);
      try {
        await fs.promises.rename(candidatePath, this.leasePath);
        return this.createLease(owner);
      } catch (error) {
        await removeLeaseDirectory(candidatePath);
        if (!isExistingPathError(error)) throw error;
      }
      const current = await readOwner(this.leasePath);
      if (!current || this.isProcessAlive(current.processId)) return null;
      if (!(await this.retireStaleOwner(current))) return null;
    }
    return null;
  }

  private createOwner(deadlineAt: number): StartupLeaseOwner {
    const leaseId = this.createId();
    if (!Number.isFinite(deadlineAt) || !isSafeLeaseId(leaseId)) {
      throw new Error('Invalid startup lease identity');
    }
    return {
      schemaVersion: OWNER_SCHEMA_VERSION,
      processId: this.processId,
      leaseId,
      deadlineAt,
    };
  }

  private async ensurePrivateRuntimeDirectory(): Promise<void> {
    await fs.promises.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const directory = await fs.promises.lstat(this.runtimeDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Invalid lease root');
    }
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
      throw new Error('Invalid lease root');
    }
  }

  private async createCandidate(owner: StartupLeaseOwner): Promise<string> {
    const candidatePath = `${this.leasePath}.candidate.${owner.leaseId}`;
    await fs.promises.mkdir(candidatePath, { mode: 0o700 });
    try {
      await fs.promises.writeFile(path.join(candidatePath, OWNER_FILE), JSON.stringify(owner), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return candidatePath;
    } catch (error) {
      await removeLeaseDirectory(candidatePath);
      throw error;
    }
  }

  private createLease(owner: StartupLeaseOwner): RuntimeStartupLease {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        const current = await readOwner(this.leasePath);
        if (current?.leaseId === owner.leaseId) {
          await removeLeaseDirectory(this.leasePath);
        }
      },
    };
  }

  private async retireStaleOwner(expected: StartupLeaseOwner): Promise<boolean> {
    const stalePath = `${this.leasePath}.stale.${expected.leaseId}`;
    try {
      await fs.promises.rename(this.leasePath, stalePath);
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    }
    const moved = await readOwner(stalePath);
    if (moved?.leaseId !== expected.leaseId || this.isProcessAlive(moved.processId)) {
      await fs.promises.rename(stalePath, this.leasePath).catch(() => undefined);
      return false;
    }
    await removeLeaseDirectory(stalePath);
    return true;
  }
}

async function readOwner(leasePath: string): Promise<StartupLeaseOwner | null> {
  try {
    const directory = await fs.promises.lstat(leasePath);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    const ownerPath = path.join(leasePath, OWNER_FILE);
    const ownerStats = await fs.promises.lstat(ownerPath);
    if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) return null;
    const value = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')) as unknown;
    return isStartupLeaseOwner(value) ? value : null;
  } catch {
    return null;
  }
}

function isStartupLeaseOwner(value: unknown): value is StartupLeaseOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<StartupLeaseOwner>;
  return (
    owner.schemaVersion === OWNER_SCHEMA_VERSION &&
    Number.isSafeInteger(owner.processId) &&
    (owner.processId ?? 0) > 0 &&
    typeof owner.leaseId === 'string' &&
    isSafeLeaseId(owner.leaseId) &&
    Number.isFinite(owner.deadlineAt)
  );
}

function isSafeLeaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH';
  }
}

function isExistingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

async function removeLeaseDirectory(directory: string): Promise<void> {
  await fs.promises.unlink(path.join(directory, OWNER_FILE)).catch(() => undefined);
  await fs.promises.rmdir(directory).catch(() => undefined);
}

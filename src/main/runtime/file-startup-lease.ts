import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeStartupLease, RuntimeStartupLeasePort } from './runtime-ports';

const OWNER_FILE = 'owner.json';
const HEARTBEAT_FILE = 'heartbeat.json';
const OWNER_SCHEMA_VERSION = 2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 5_000;
const MIN_STALE_HEARTBEATS = 3;

interface StartupLeaseOwner {
  readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
  readonly processId: number;
  readonly leaseId: string;
  readonly deadlineAt: number;
}

interface StartupLeaseHeartbeat {
  readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
  readonly leaseId: string;
}

interface StartupLeaseSnapshot {
  readonly owner: StartupLeaseOwner;
  readonly heartbeatAt: number;
}

export interface FileRuntimeStartupLeaseOptions {
  readonly processId?: number;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly setHeartbeatInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  readonly clearHeartbeatInterval?: (timer: NodeJS.Timeout) => void;
}

export class FileRuntimeStartupLeasePort implements RuntimeStartupLeasePort {
  private readonly leasePath: string;
  private readonly processId: number;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly scheduleHeartbeat: NonNullable<
    FileRuntimeStartupLeaseOptions['setHeartbeatInterval']
  >;
  private readonly cancelHeartbeat: NonNullable<
    FileRuntimeStartupLeaseOptions['clearHeartbeatInterval']
  >;

  constructor(
    private readonly runtimeDirectory: string,
    options: FileRuntimeStartupLeaseOptions = {},
  ) {
    this.leasePath = path.join(runtimeDirectory, 'startup.lock');
    this.processId = options.processId ?? process.pid;
    this.createId = options.randomId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.scheduleHeartbeat = options.setHeartbeatInterval ?? setInterval;
    this.cancelHeartbeat = options.clearHeartbeatInterval ?? clearInterval;
    if (!validHeartbeatBounds(this.heartbeatIntervalMs, this.staleAfterMs)) {
      throw new Error('Invalid startup lease heartbeat bounds');
    }
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
      const current = await readLease(this.leasePath);
      if (!current || !this.isStale(current)) return null;
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
    if (!isProtectedDirectory(directory)) throw new Error('Invalid lease root');
  }

  private async createCandidate(owner: StartupLeaseOwner): Promise<string> {
    const candidatePath = `${this.leasePath}.candidate.${owner.leaseId}`;
    await fs.promises.mkdir(candidatePath, { mode: 0o700 });
    try {
      await writeProtectedJson(path.join(candidatePath, OWNER_FILE), owner);
      await writeProtectedJson(path.join(candidatePath, HEARTBEAT_FILE), {
        schemaVersion: OWNER_SCHEMA_VERSION,
        leaseId: owner.leaseId,
      });
      const heartbeatAt = new Date(this.now());
      await fs.promises.utimes(path.join(candidatePath, HEARTBEAT_FILE), heartbeatAt, heartbeatAt);
      return candidatePath;
    } catch (error) {
      await removeLeaseDirectory(candidatePath);
      throw error;
    }
  }

  private createLease(owner: StartupLeaseOwner): RuntimeStartupLease {
    let released = false;
    let refreshInFlight: Promise<boolean> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const stopHeartbeat = (): void => {
      if (!timer) return;
      this.cancelHeartbeat(timer);
      timer = null;
    };
    const renew = async (): Promise<boolean> => {
      if (released) return false;
      const refresh = refreshInFlight ?? this.refreshHeartbeat(owner);
      refreshInFlight = refresh;
      const owned = await refresh.catch(() => false);
      if (refreshInFlight === refresh) refreshInFlight = null;
      if (!owned) stopHeartbeat();
      return !released && owned;
    };
    timer = this.scheduleHeartbeat(() => void renew(), this.heartbeatIntervalMs);
    timer.unref();
    return {
      renew,
      release: async () => {
        if (released) return;
        released = true;
        stopHeartbeat();
        await refreshInFlight?.catch(() => undefined);
        await this.releaseOwnedLease(owner);
      },
    };
  }

  private async refreshHeartbeat(owner: StartupLeaseOwner): Promise<boolean> {
    const current = await readLease(this.leasePath);
    if (current?.owner.leaseId !== owner.leaseId) return false;
    return touchOwnedHeartbeat(this.leasePath, owner.leaseId, this.now());
  }

  private isStale(snapshot: StartupLeaseSnapshot): boolean {
    const heartbeatExpiresAt = snapshot.heartbeatAt + this.staleAfterMs;
    return this.now() > Math.max(snapshot.owner.deadlineAt, heartbeatExpiresAt);
  }

  private async retireStaleOwner(expected: StartupLeaseSnapshot): Promise<boolean> {
    const stalePath = `${this.leasePath}.stale.${expected.owner.leaseId}`;
    try {
      await fs.promises.rename(this.leasePath, stalePath);
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    }
    const moved = await readLease(stalePath);
    if (moved?.owner.leaseId !== expected.owner.leaseId || !this.isStale(moved)) {
      await restoreLeaseDirectory(stalePath, this.leasePath);
      return false;
    }
    await removeLeaseDirectory(stalePath);
    return true;
  }

  private async releaseOwnedLease(owner: StartupLeaseOwner): Promise<void> {
    const current = await readLease(this.leasePath);
    if (current?.owner.leaseId !== owner.leaseId) return;
    const releasePath = `${this.leasePath}.release.${owner.leaseId}`;
    try {
      await fs.promises.rename(this.leasePath, releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }
    const moved = await readLease(releasePath);
    if (moved?.owner.leaseId !== owner.leaseId) {
      await restoreLeaseDirectory(releasePath, this.leasePath);
      return;
    }
    await removeLeaseDirectory(releasePath);
  }
}

async function readLease(leasePath: string): Promise<StartupLeaseSnapshot | null> {
  try {
    const directory = await fs.promises.lstat(leasePath);
    if (!isProtectedDirectory(directory)) return null;
    const owner = await readProtectedJson(path.join(leasePath, OWNER_FILE));
    const heartbeat = await readProtectedJson(path.join(leasePath, HEARTBEAT_FILE));
    if (!owner || !heartbeat || !isStartupLeaseOwner(owner.value)) return null;
    if (!isStartupLeaseHeartbeat(heartbeat.value, owner.value.leaseId)) return null;
    return { owner: owner.value, heartbeatAt: heartbeat.stats.mtimeMs };
  } catch {
    return null;
  }
}

interface ProtectedJson {
  readonly value: unknown;
  readonly stats: fs.Stats;
}

async function readProtectedJson(filePath: string): Promise<ProtectedJson | null> {
  const stats = await fs.promises.lstat(filePath);
  if (!isProtectedFile(stats)) return null;
  const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
  return { value, stats };
}

async function writeProtectedJson(filePath: string, value: object): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function touchOwnedHeartbeat(
  leasePath: string,
  leaseId: string,
  now: number,
): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const heartbeatPath = path.join(leasePath, HEARTBEAT_FILE);
    const pathStats = await fs.promises.lstat(heartbeatPath);
    if (!isProtectedFile(pathStats)) return false;
    handle = await fs.promises.open(heartbeatPath, 'r+');
    const handleStats = await handle.stat();
    if (!sameFile(pathStats, handleStats)) return false;
    const heartbeat = JSON.parse(await handle.readFile('utf8')) as unknown;
    if (!isStartupLeaseHeartbeat(heartbeat, leaseId)) return false;
    const heartbeatAt = new Date(now);
    await handle.utimes(heartbeatAt, heartbeatAt);
    const currentStats = await fs.promises.lstat(heartbeatPath);
    return sameFile(handleStats, currentStats);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
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

function isStartupLeaseHeartbeat(value: unknown, leaseId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const heartbeat = value as Partial<StartupLeaseHeartbeat>;
  return heartbeat.schemaVersion === OWNER_SCHEMA_VERSION && heartbeat.leaseId === leaseId;
}

function validHeartbeatBounds(intervalMs: number, staleAfterMs: number): boolean {
  return (
    Number.isSafeInteger(intervalMs) &&
    intervalMs > 0 &&
    Number.isSafeInteger(staleAfterMs) &&
    staleAfterMs >= intervalMs * MIN_STALE_HEARTBEATS
  );
}

function isSafeLeaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isProtectedDirectory(stats: fs.Stats): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    (process.platform === 'win32' || (stats.mode & 0o077) === 0)
  );
}

function isProtectedFile(stats: fs.Stats): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    (process.platform === 'win32' || (stats.mode & 0o077) === 0)
  );
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isExistingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

async function restoreLeaseDirectory(source: string, destination: string): Promise<void> {
  await fs.promises.rename(source, destination).catch(() => undefined);
}

async function removeLeaseDirectory(directory: string): Promise<void> {
  await fs.promises.unlink(path.join(directory, HEARTBEAT_FILE)).catch(() => undefined);
  await fs.promises.unlink(path.join(directory, OWNER_FILE)).catch(() => undefined);
  await fs.promises.rmdir(directory).catch(() => undefined);
}

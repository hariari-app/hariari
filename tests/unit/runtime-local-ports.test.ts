import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { resolveRuntimeEndpoint } from '../../src/runtime/endpoint';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

const directories: string[] = [];

describe('local Runtime ports', () => {
  afterEach(cleanDirectories);
  it('creates one protected random token and reads it without exposing it', createsProtectedToken);
  it('rejects a symlink token with a stable secret-free error', rejectsSymlinkToken);
  it('derives stable per-user Unix sockets and Windows named pipes', derivesStableEndpoints);
  it('does not steal a live startup lease after its startup deadline', preservesLiveLease);
  it('recovers a startup lease after its owner crashes', recoversCrashedLease);
  it('recovers a stale startup lease after its PID is reused', recoversReusedPidLease);
  it('unrefs and clears the lease heartbeat timer on release', cleansHeartbeatTimer);
});

async function createsProtectedToken(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-token-');
  const runtimeDirectory = path.join(root, 'runtime');
  let generated = 0;
  const store = new ProtectedRuntimeTokenStore(runtimeDirectory, () => {
    generated += 1;
    return new Uint8Array(32).fill(73);
  });
  const [first, second] = await Promise.all([store.ensure(), store.ensure()]);
  expect(first).toEqual(second);
  expect(first).toHaveLength(32);
  expect(generated).toBeGreaterThanOrEqual(1);
  await expect(store.read()).resolves.toEqual(first);
  if (process.platform !== 'win32') {
    expect(fs.statSync(runtimeDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(runtimeDirectory, 'auth-token')).mode & 0o777).toBe(0o600);
  }
}

async function rejectsSymlinkToken(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-symlink-');
  const runtimeDirectory = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  const target = path.join(root, 'target');
  fs.writeFileSync(target, Buffer.alloc(32).toString('base64url'));
  fs.symlinkSync(target, path.join(runtimeDirectory, 'auth-token'));
  const store = new ProtectedRuntimeTokenStore(runtimeDirectory);
  await expect(store.read()).rejects.toThrow('Runtime credential is unavailable');
  await store.read().catch((error: unknown) => {
    expect(JSON.stringify(error)).not.toContain(fs.readFileSync(target, 'utf8'));
  });
}

function derivesStableEndpoints(): void {
  const firstUnix = resolveRuntimeEndpoint('/home/alice/.hariari/runtime', {
    platform: 'linux',
    temporaryDirectory: '/tmp',
    userId: '1000',
  });
  const secondUnix = resolveRuntimeEndpoint('/home/bob/.hariari/runtime', {
    platform: 'darwin',
    temporaryDirectory: '/tmp',
    userId: '501',
  });
  const windows = resolveRuntimeEndpoint('C:\\Users\\Alice\\.hariari\\runtime', {
    platform: 'win32',
    temporaryDirectory: 'C:\\Temp',
    userId: 'alice',
  });
  expect(firstUnix.kind).toBe('unix');
  expect(firstUnix.address).toMatch(/^\/tmp\/hariari-1000-[a-f0-9]{16}\/r-v1\.sock$/);
  expect(firstUnix.address.length).toBeLessThan(100);
  expect(secondUnix.address).not.toBe(firstUnix.address);
  expect(windows.kind).toBe('windows-pipe');
  expect(windows.address).toMatch(/^\\\\\.\\pipe\\hariari-runtime-[a-f0-9]{16}-v1$/);
}

async function preservesLiveLease(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-lease-');
  let now = Date.now();
  let pulseHeartbeat = (): void => undefined;
  const owner = new FileRuntimeStartupLeasePort(root, {
    processId: 101,
    randomId: () => 'lease-live-owner',
    now: () => now,
    heartbeatIntervalMs: 1_000,
    staleAfterMs: 5_000,
    setHeartbeatInterval: (callback) => {
      pulseHeartbeat = callback;
      return setInterval(() => undefined, 2_147_483_647);
    },
  });
  const contender = leasePort(root, 202, 'lease-live-contender', () => now);
  const first = await owner.acquire(now - 1);
  expect(first).not.toBeNull();

  now += 5_001;
  pulseHeartbeat();
  await waitForHeartbeat(root, now);
  now += 4_999;
  await expect(contender.acquire(now - 1)).resolves.toBeNull();
  await first?.release();
}

async function recoversCrashedLease(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-stale-lease-');
  let now = Date.now();
  const owner = leasePort(root, 101, 'lease-crashed', () => now);
  const successor = leasePort(root, 202, 'lease-successor', () => now);
  const abandonedLease = await owner.acquire(now + 1_000);
  now += 5_001;
  const recoveredLease = await successor.acquire(now + 1_000);
  expect(recoveredLease).not.toBeNull();
  await abandonedLease?.release();
  await expect(
    leasePort(root, 303, 'lease-third-owner', () => now).acquire(now + 1_000),
  ).resolves.toBeNull();
  await recoveredLease?.release();
}

async function recoversReusedPidLease(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-reused-pid-');
  let now = Date.now();
  const abandonedOwner = leasePort(root, process.pid, 'lease-before-pid-reuse', () => now);
  const abandonedLease = await abandonedOwner.acquire(now + 1_000);

  now += 5_001;
  const reusedProcess = leasePort(root, process.pid, 'lease-after-pid-reuse', () => now);
  const recoveredLease = await reusedProcess.acquire(now + 1_000);

  expect(recoveredLease).not.toBeNull();
  await abandonedLease?.release();
  await expect(reusedProcess.acquire(now + 1_000)).resolves.toBeNull();
  await recoveredLease?.release();
}

async function cleansHeartbeatTimer(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-lease-timer-');
  let timer: NodeJS.Timeout | null = null;
  let clearCount = 0;
  const port = new FileRuntimeStartupLeasePort(root, {
    randomId: () => 'lease-with-clean-timer',
    setHeartbeatInterval: () => {
      timer = setInterval(() => undefined, 2_147_483_647);
      return timer;
    },
    clearHeartbeatInterval: (activeTimer) => {
      clearCount += 1;
      clearInterval(activeTimer);
    },
  });

  const lease = await port.acquire(Date.now() + 1_000);
  const activeTimer = timer as NodeJS.Timeout | null;
  expect(activeTimer?.hasRef()).toBe(false);
  await lease?.release();
  await lease?.release();

  expect(clearCount).toBe(1);
}

function leasePort(
  directory: string,
  processId: number,
  leaseId: string,
  now: () => number,
): FileRuntimeStartupLeasePort {
  return new FileRuntimeStartupLeasePort(directory, {
    processId,
    randomId: () => leaseId,
    now,
    heartbeatIntervalMs: 1_000,
    staleAfterMs: 5_000,
    setHeartbeatInterval: () => setInterval(() => undefined, 2_147_483_647),
  });
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function waitForHeartbeat(directory: string, expectedTime: number): Promise<void> {
  const heartbeatPath = path.join(directory, 'startup.lock', 'heartbeat.json');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.statSync(heartbeatPath).mtimeMs >= expectedTime - 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('heartbeat did not advance');
}

function cleanDirectories(): void {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

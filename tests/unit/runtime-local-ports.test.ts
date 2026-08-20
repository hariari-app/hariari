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
  const liveProcesses = new Set([101, 202]);
  const owner = leasePort(root, 101, liveProcesses);
  const contender = leasePort(root, 202, liveProcesses);
  const first = await owner.acquire(Date.now() - 1);
  expect(first).not.toBeNull();
  await expect(contender.acquire(Date.now() - 1)).resolves.toBeNull();
  await first?.release();
}

async function recoversCrashedLease(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-stale-lease-');
  const liveProcesses = new Set([101, 202, 303]);
  const owner = leasePort(root, 101, liveProcesses);
  const successor = leasePort(root, 202, liveProcesses);
  const abandonedLease = await owner.acquire(Date.now() + 1_000);
  liveProcesses.delete(101);
  const recoveredLease = await successor.acquire(Date.now() + 1_000);
  expect(recoveredLease).not.toBeNull();
  await abandonedLease?.release();
  await expect(
    leasePort(root, 303, liveProcesses).acquire(Date.now() + 1_000),
  ).resolves.toBeNull();
  await recoveredLease?.release();
}

function leasePort(
  directory: string,
  processId: number,
  liveProcesses: ReadonlySet<number>,
): FileRuntimeStartupLeasePort {
  return new FileRuntimeStartupLeasePort(directory, {
    processId,
    randomId: () => `lease-${processId}`,
    isProcessAlive: (candidate) => liveProcesses.has(candidate),
  });
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(root);
  return root;
}

function cleanDirectories(): void {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

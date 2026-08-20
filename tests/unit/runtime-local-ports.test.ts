import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { resolveRuntimeEndpoint } from '../../src/runtime/endpoint';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

describe('local Runtime ports', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates one protected random token and reads it without exposing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-token-'));
    directories.push(root);
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
  });

  it('rejects a symlink token with a stable secret-free error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-symlink-'));
    directories.push(root);
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
  });

  it('derives stable per-user Unix sockets and Windows named pipes', () => {
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
  });

  it('serializes startup with an exclusive conservative lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-lease-'));
    directories.push(root);
    const leasePort = new FileRuntimeStartupLeasePort(root);

    const first = await leasePort.acquire(Date.now() + 1_000);
    expect(first).not.toBeNull();
    await expect(leasePort.acquire(Date.now() + 1_000)).resolves.toBeNull();
    await first?.release();
    await expect(leasePort.acquire(Date.now() + 1_000)).resolves.not.toBeNull();
  });
});

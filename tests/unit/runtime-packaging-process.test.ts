import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetachedRuntimeProcessAdapter } from '../../src/main/runtime/detached-runtime-process';

describe('detached Runtime process adapter', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('launches a validated SEA with only non-secret runtime arguments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime process-ö-'));
    roots.push(root);
    const executablePath = path.join(root, 'installed app', 'hariari-runtime');
    const runtimeDirectory = path.join(root, 'home 用户', '.hariari', 'runtime');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    fs.writeFileSync(executablePath, 'runtime', { mode: 0o755 });
    const unref = vi.fn();
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: SpawnOptions;
    }> = [];
    const spawn = vi.fn((executable: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ executable, args, options });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 1234, unref });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const secret = 'seeded-secret-must-not-leak';
    const adapter = new DetachedRuntimeProcessAdapter({
      runtimeVersion: '0.6.8',
      platform: 'linux',
      environment: {
        PATH: '/should/not/be/required',
        LANG: 'en_GB.UTF-8',
        HARIARI_RUNTIME_TOKEN: secret,
      },
      spawn,
    });

    await adapter.start({
      artifact: { executablePath, entryPath: executablePath, buildId: 'build-19' },
      endpoint: {
        kind: 'unix',
        address: path.join(root, 'runtime.sock'),
        runtimeDirectory,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: executablePath,
      args: [
        '--runtime-dir',
        runtimeDirectory,
        '--runtime-version',
        '0.6.8',
        '--build-id',
        'build-19',
      ],
      options: {
        cwd: runtimeDirectory,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain(secret);
    expect(calls[0].options.env).toEqual({ LANG: 'en_GB.UTF-8' });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('rejects a symlink or non-executable path before spawn', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-invalid-'));
    roots.push(root);
    const target = path.join(root, 'target');
    const symlink = path.join(root, 'runtime');
    fs.writeFileSync(target, 'runtime', { mode: 0o644 });
    fs.symlinkSync(target, symlink);
    const spawn = vi.fn();
    const adapter = new DetachedRuntimeProcessAdapter({
      runtimeVersion: '0.6.8',
      platform: process.platform,
      spawn,
    });

    await expect(
      adapter.start({
        artifact: { executablePath: symlink, entryPath: symlink, buildId: 'build-19' },
        endpoint: { kind: 'unix', address: '/tmp/runtime.sock', runtimeDirectory: root },
      }),
    ).rejects.toMatchObject({ code: 'start-failed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves case-insensitive Windows system variables without inheriting PATH', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-windows-env-'));
    roots.push(root);
    const executablePath = path.join(root, 'hariari-runtime.exe');
    fs.writeFileSync(executablePath, 'runtime');
    let environment: NodeJS.ProcessEnv | undefined;
    const spawn = vi.fn((_executable: string, _args: readonly string[], options: SpawnOptions) => {
      environment = options.env;
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 1234, unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const adapter = new DetachedRuntimeProcessAdapter({
      runtimeVersion: '0.6.8',
      platform: 'win32',
      environment: { SystemRoot: 'C:\\Windows', Path: 'C:\\untrusted' },
      spawn,
    });

    await adapter.start({
      artifact: { executablePath, entryPath: executablePath, buildId: 'build-19' },
      endpoint: {
        kind: 'windows-pipe',
        address: '\\\\.\\pipe\\hariari-test',
        runtimeDirectory: root,
      },
    });

    expect(environment).toEqual({ SystemRoot: 'C:\\Windows' });
  });
});

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetachedRuntimeProcessAdapter } from '../../src/main/runtime/detached-runtime-process';

interface SpawnCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const roots: string[] = [];

describe('detached Runtime process adapter', () => {
  afterEach(cleanRoots);
  it('launches a validated SEA with only non-secret runtime arguments', launchesSecurely);
  it.each<NodeJS.Platform>(['linux', 'darwin', 'win32'])(
    'retains an unresolved launch until its child exits on %s',
    retainsLaunchUntilExit,
  );
  it('terminates and settles an owned launch without exposing a process handle', terminatesLaunch);
  it('rejects a symlink or non-executable path before spawn', rejectsInvalidArtifact);
  it(
    'preserves case-insensitive Windows system variables without inheriting PATH',
    filtersWindowsEnvironment,
  );
});

async function terminatesLaunch(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-terminated-launch-');
  const executablePath = path.join(root, 'runtime');
  const runtimeDirectory = path.join(root, 'state');
  createExecutable(executablePath, runtimeDirectory);
  const children: ChildProcess[] = [];
  const adapter = new DetachedRuntimeProcessAdapter({
    runtimeVersion: '0.6.8',
    platform: 'linux',
    spawn: () => {
      const child = spawnedChild(vi.fn());
      children.push(child);
      return child;
    },
  });
  const launch = await adapter.start({
    artifact: { executablePath, buildId: 'build-19' },
    endpoint: { kind: 'unix', address: path.join(root, 'runtime.sock'), runtimeDirectory },
  });

  const child = children[0];
  if (!child) throw new Error('expected child');
  const termination = launch.terminate();
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit('exit', null, 'SIGTERM');
  await termination;
  await expect(launch.settled()).resolves.toBeUndefined();
}

async function retainsLaunchUntilExit(platform: NodeJS.Platform): Promise<void> {
  const root = temporaryRoot(`hariari-runtime-retained-${platform}-`);
  const executablePath = path.join(root, platform === 'win32' ? 'runtime.exe' : 'runtime');
  const runtimeDirectory = path.join(root, 'state');
  createExecutable(executablePath, runtimeDirectory);
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = spawnedChild(vi.fn());
    children.push(child);
    return child;
  });
  const adapter = new DetachedRuntimeProcessAdapter({
    runtimeVersion: '0.6.8',
    platform,
    spawn,
  });
  const request = {
    artifact: { executablePath, buildId: 'build-19' },
    endpoint: {
      kind: platform === 'win32' ? ('windows-pipe' as const) : ('unix' as const),
      address: platform === 'win32' ? '\\\\.\\pipe\\hariari-test' : path.join(root, 'runtime.sock'),
      runtimeDirectory,
    },
  };

  await adapter.start(request);
  await adapter.start(request);
  expect(spawn).toHaveBeenCalledOnce();
  children[0]?.emit('exit', 1, null);
  await adapter.start(request);
  expect(spawn).toHaveBeenCalledTimes(2);
}

async function launchesSecurely(): Promise<void> {
  const root = temporaryRoot('hariari-runtime process-ö-');
  const executablePath = path.join(root, 'installed app', 'hariari-runtime');
  const runtimeDirectory = path.join(root, 'home 用户', '.hariari', 'runtime');
  createExecutable(executablePath, runtimeDirectory);
  const unref = vi.fn();
  const calls: SpawnCall[] = [];
  const secret = 'seeded-secret-must-not-leak';
  const adapter = new DetachedRuntimeProcessAdapter({
    runtimeVersion: '0.6.8',
    platform: 'linux',
    environment: {
      PATH: '/should/not/be/required',
      LANG: 'en_GB.UTF-8',
      HARIARI_RUNTIME_TOKEN: secret,
    },
    spawn: recordingSpawn(calls, unref),
  });
  await adapter.start({
    artifact: { executablePath, buildId: 'build-19' },
    endpoint: { kind: 'unix', address: path.join(root, 'runtime.sock'), runtimeDirectory },
  });
  assertSecureSpawn(calls, executablePath, runtimeDirectory, secret);
  expect(unref).toHaveBeenCalledOnce();
}

function assertSecureSpawn(
  calls: readonly SpawnCall[],
  executablePath: string,
  runtimeDirectory: string,
  secret: string,
): void {
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
}

async function rejectsInvalidArtifact(): Promise<void> {
  if (process.platform === 'win32') return;
  const root = temporaryRoot('hariari-runtime-invalid-');
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
      artifact: { executablePath: symlink, buildId: 'build-19' },
      endpoint: { kind: 'unix', address: '/tmp/runtime.sock', runtimeDirectory: root },
    }),
  ).rejects.toMatchObject({ code: 'start-failed' });
  expect(spawn).not.toHaveBeenCalled();
}

async function filtersWindowsEnvironment(): Promise<void> {
  const root = temporaryRoot('hariari-runtime-windows-env-');
  const executablePath = path.join(root, 'hariari-runtime.exe');
  fs.writeFileSync(executablePath, 'runtime');
  let environment: NodeJS.ProcessEnv | undefined;
  const spawn = vi.fn((_executable: string, _args: readonly string[], options: SpawnOptions) => {
    environment = options.env;
    return spawnedChild(vi.fn());
  });
  const adapter = new DetachedRuntimeProcessAdapter({
    runtimeVersion: '0.6.8',
    platform: 'win32',
    environment: { SystemRoot: 'C:\\Windows', Path: 'C:\\untrusted' },
    spawn,
  });
  await adapter.start({
    artifact: { executablePath, buildId: 'build-19' },
    endpoint: {
      kind: 'windows-pipe',
      address: '\\\\.\\pipe\\hariari-test',
      runtimeDirectory: root,
    },
  });
  expect(environment).toEqual({ SystemRoot: 'C:\\Windows' });
}

function recordingSpawn(calls: SpawnCall[], unref: () => void) {
  return (executable: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ executable, args, options });
    return spawnedChild(unref);
  };
}

function spawnedChild(unref: () => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const kill = vi.fn(() => true);
  Object.assign(child, { pid: 1234, exitCode: null, signalCode: null, kill, unref });
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createExecutable(executablePath: string, runtimeDirectory: string): void {
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(executablePath, 'runtime', { mode: 0o755 });
}

function cleanRoots(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

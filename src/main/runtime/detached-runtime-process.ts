import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  RuntimePortError,
  type RuntimeProcessPort,
  type RuntimeProcessStartRequest,
} from './runtime-ports';

const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const POSIX_ENVIRONMENT_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'] as const;
const WINDOWS_ENVIRONMENT_KEYS = [
  'COMSPEC',
  'LANG',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
] as const;

type RuntimeSpawn = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface DetachedRuntimeProcessOptions {
  readonly runtimeVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: RuntimeSpawn;
}

export class DetachedRuntimeProcessAdapter implements RuntimeProcessPort {
  private readonly platform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawn: RuntimeSpawn;
  private retainedChild: ChildProcess | null = null;
  private startInFlight: Promise<void> | null = null;

  constructor(private readonly options: DetachedRuntimeProcessOptions) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.spawn = options.spawn ?? nodeSpawn;
  }

  start(request: RuntimeProcessStartRequest): Promise<void> {
    if (this.retainedChild) return Promise.resolve();
    if (this.startInFlight) return this.startInFlight;
    const attempt = this.spawnRuntime(request).finally(() => {
      if (this.startInFlight === attempt) this.startInFlight = null;
    });
    this.startInFlight = attempt;
    return attempt;
  }

  private async spawnRuntime(request: RuntimeProcessStartRequest): Promise<void> {
    try {
      await validateLaunchRequest(request, this.options.runtimeVersion, this.platform);
      if (this.retainedChild) return;
      const args = [
        '--runtime-dir',
        request.endpoint.runtimeDirectory,
        '--runtime-version',
        this.options.runtimeVersion,
        '--build-id',
        request.artifact.buildId,
      ];
      const child = this.spawn(request.artifact.executablePath, args, {
        cwd: request.endpoint.runtimeDirectory,
        detached: true,
        env: selectEnvironment(this.environment, this.platform),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      let exited = false;
      const recordExit = (): void => {
        exited = true;
        if (this.retainedChild === child) this.retainedChild = null;
      };
      child.once('exit', recordExit);
      await waitForSpawn(child).catch((error) => {
        child.removeListener('exit', recordExit);
        throw error;
      });
      if (!exited) this.retainedChild = child;
      child.unref();
    } catch {
      throw new RuntimePortError('start-failed');
    }
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = (): void => {
      child.removeListener('error', failed);
      resolve();
    };
    const failed = (error: Error): void => {
      child.removeListener('spawn', spawned);
      reject(error);
    };
    child.once('spawn', spawned);
    child.once('error', failed);
  });
}

async function validateLaunchRequest(
  request: RuntimeProcessStartRequest,
  runtimeVersion: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (
    !path.isAbsolute(request.artifact.executablePath) ||
    !path.isAbsolute(request.endpoint.runtimeDirectory) ||
    !SAFE_VALUE_PATTERN.test(runtimeVersion) ||
    !SAFE_VALUE_PATTERN.test(request.artifact.buildId)
  ) {
    throw new Error('Invalid Runtime launch request');
  }
  for (const value of [
    request.artifact.executablePath,
    request.endpoint.runtimeDirectory,
    runtimeVersion,
    request.artifact.buildId,
  ]) {
    if (value.includes('\0')) throw new Error('Invalid Runtime launch request');
  }
  const executable = await fs.promises.lstat(request.artifact.executablePath);
  if (!executable.isFile() || executable.isSymbolicLink()) {
    throw new Error('Invalid Runtime executable');
  }
  if (platform !== 'win32' && (executable.mode & 0o111) === 0) {
    throw new Error('Runtime executable is not executable');
  }
  const runtimeDirectory = await fs.promises.lstat(request.endpoint.runtimeDirectory);
  if (!runtimeDirectory.isDirectory() || runtimeDirectory.isSymbolicLink()) {
    throw new Error('Invalid Runtime directory');
  }
}

function selectEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    const allowed = new Set<string>(WINDOWS_ENVIRONMENT_KEYS);
    for (const [key, value] of Object.entries(environment)) {
      if (allowed.has(key.toUpperCase()) && value !== undefined && !value.includes('\0')) {
        selected[key] = value;
      }
    }
    return selected;
  }
  for (const key of POSIX_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined && !value.includes('\0')) selected[key] = value;
  }
  return selected;
}

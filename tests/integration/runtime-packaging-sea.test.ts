import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { LocalRuntimeEndpointPort } from '../../src/main/runtime/local-endpoint-port';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import type {
  RuntimeProcessPort,
  RuntimeStartupLeasePort,
} from '../../src/main/runtime/runtime-ports';
import { DetachedRuntimeProcessAdapter } from '../../src/main/runtime/detached-runtime-process';
import { PackagedRuntimeArtifactPort } from '../../src/main/runtime/packaged-runtime-artifact';
import type {
  RuntimeConnectionState,
  RuntimeInterface,
} from '../../src/shared/runtime/runtime-interface';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

const roots: string[] = [];
const children: ChildProcess[] = [];

describe('host Node SEA Runtime artifact', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanSeaFixtures();
  });
  it(
    'launches, handshakes, checks health, reconnects, and shuts down after resources disappear',
    verifiesPackagedSeaLifecycle,
    20_000,
  );
  it('runs the real worktree and PTY tracer from the packaged SEA', runsPackagedTaskTracer, 20_000);
  it('waits for child exit and retries a busy fixture removal', cleansSeaFixturesAfterChildExit);
});

async function cleansSeaFixturesAfterChildExit(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari SEA cleanup-'));
  roots.push(root);
  const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  await waitForChildSpawn(child);
  const remove = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(busyRemovalError());

  await cleanSeaFixtures();

  expect(child.exitCode === null && child.signalCode === null).toBe(false);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(root)).toBe(false);
}

async function verifiesPackagedSeaLifecycle(): Promise<void> {
  const fixture = createSeaFixture();
  await preflightPackagedArtifact(fixture.artifacts);
  const first = fixture.createInterface();
  const connected = await first.connectOrStart();
  assertConnected(connected, 'initial connection');
  expect(connected).toMatchObject({
    state: 'connected',
    health: { runtimeVersion: fixture.runtimeVersion, status: 'ready', protocolVersion: 1 },
  });
  await first.disconnect();
  fs.rmSync(path.join(fixture.resourcesPath, 'runtime'), { recursive: true, force: true });
  const second = fixture.createInterface();
  const reconnected = await second.connectOrStart();
  assertConnected(reconnected, 'reconnection');
  expect(reconnected).toMatchObject({
    state: 'connected',
    health: { instanceId: connected.health.instanceId },
  });
  expect(fixture.launches.value).toBe(1);
  await shutdownPackagedRuntime(second, reconnected);
}

async function runsPackagedTaskTracer(): Promise<void> {
  const fixture = createSeaFixture();
  const runtime = fixture.createInterface();
  const connected = await runtime.connectOrStart();
  assertConnected(connected, 'task tracer startup');
  const repository = createDisposableGitRepository();
  const task = await runtime.createTask({
    objective: 'Run packaged Generic CLI tracer.',
    project: 'Hariari',
    repository: repository.path,
    baseRef: 'HEAD',
    provider: 'shell',
    idempotencyKey: 'packaged-tracer-create',
  });
  const output: string[] = [];
  const unsubscribe = await runtime.subscribeTaskOutput(task.id, (event) => {
    if (event.kind === 'data') output.push(event.data);
  });
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'packaged-tracer-start' });
  await waitForTaskCompletion(runtime, task.id);
  const completed = await runtime.getTaskExecution(task.id);
  unsubscribe();

  expect(completed).toMatchObject({
    task: { executionState: 'completed' },
    attempt: { state: 'completed', exitCode: 0 },
    context: { baseCommit: repository.baseCommit },
  });
  expect(output.join('')).toContain('hariari-runtime-tracer');
  await shutdownPackagedRuntime(runtime, connected);
}

function createDisposableGitRepository(): { readonly path: string; readonly baseCommit: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-packaged-runtime-task-'));
  roots.push(root);
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runtime@example.test'], {
    cwd: repository,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: repository, stdio: 'pipe' });
  fs.writeFileSync(path.join(repository, 'README.md'), '# Packaged Runtime\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial packaged fixture'], { cwd: repository, stdio: 'pipe' });
  return {
    path: repository,
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  };
}

async function waitForTaskCompletion(runtime: RuntimeInterface, taskId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const execution = await runtime.getTaskExecution(taskId);
    if (execution.attempt?.state === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('packaged task tracer did not complete');
}

async function preflightPackagedArtifact(artifacts: PackagedRuntimeArtifactPort): Promise<void> {
  try {
    await artifacts.resolve();
  } catch (error) {
    throw new Error(`Packaged Runtime artifact preflight failed: ${formatErrorCauseChain(error)}`);
  }
}

function formatErrorCauseChain(error: unknown): string {
  const chain: Array<{
    readonly name: string;
    readonly message: string;
    readonly code: string | null;
  }> = [];
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    chain.push({
      name: current.name,
      message: current.message,
      code: readErrorCode(current),
    });
    current = current.cause;
  }
  if (current !== undefined) {
    chain.push({
      name: current instanceof Error ? current.name : 'NonErrorCause',
      message: current instanceof Error ? 'Cyclic cause omitted' : 'Non-Error cause omitted',
      code: current instanceof Error ? readErrorCode(current) : null,
    });
  }
  return JSON.stringify(chain);
}

function readErrorCode(error: Error): string | null {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

function assertConnected(
  state: RuntimeConnectionState,
  phase: string,
): asserts state is Extract<RuntimeConnectionState, { readonly state: 'connected' }> {
  if (state.state === 'connected') return;
  throw new Error(`Packaged Runtime ${phase} failed: ${JSON.stringify(state)}`);
}

async function shutdownPackagedRuntime(
  runtime: RuntimeInterface,
  state: Awaited<ReturnType<RuntimeInterface['connectOrStart']>>,
): Promise<void> {
  if (state.state !== 'connected') throw new Error('expected Runtime reconnection');
  await expect(
    runtime.shutdown({
      idempotencyKey: 'packaged-sea-shutdown',
      expectedInstanceId: state.health.instanceId,
      reason: 'test',
    }),
  ).resolves.toEqual({
    state: 'stopped',
    instanceId: state.health.instanceId,
  });
}

interface SeaFixture {
  readonly resourcesPath: string;
  readonly runtimeVersion: string;
  readonly launches: { value: number };
  readonly artifacts: PackagedRuntimeArtifactPort;
  readonly createInterface: () => RuntimeInterface;
}

function createSeaFixture(): SeaFixture {
  const sourceResources = resolveSourceResources();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari SEA smoke 日本語-'));
  roots.push(root);
  const resourcesPath = path.join(root, 'packaged resources');
  fs.cpSync(path.join(sourceResources, 'runtime'), path.join(resourcesPath, 'runtime'), {
    recursive: true,
  });
  const runtimeDirectory = path.join(root, 'home with spaces', '.hariari', 'runtime');
  const runtimeVersion = readManifest(resourcesPath).runtimeVersion;
  const transport = new NodeLocalRuntimeTransport();
  const endpoints = new LocalRuntimeEndpointPort(runtimeDirectory);
  const tokens = new ProtectedRuntimeTokenStore(runtimeDirectory);
  const artifacts = new PackagedRuntimeArtifactPort({
    resourcesPath,
    runtimeDirectory,
    expectedRuntimeVersion: runtimeVersion,
  });
  const launches = { value: 0 };
  const processes = createProcessPort(runtimeVersion, launches);
  const leases = new FileRuntimeStartupLeasePort(runtimeDirectory);
  const createInterface = (): RuntimeInterface =>
    createSeaRuntimeInterface({
      transport,
      endpoints,
      tokens,
      processes,
      leases,
      artifacts,
      runtimeVersion,
    });
  return { resourcesPath, runtimeVersion, launches, artifacts, createInterface };
}

function createProcessPort(
  runtimeVersion: string,
  launches: { value: number },
): RuntimeProcessPort {
  const detached = new DetachedRuntimeProcessAdapter({
    runtimeVersion,
    spawn: (executable, args, options) => {
      const child = nodeSpawn(executable, args, options);
      children.push(child);
      return child;
    },
  });
  return {
    start: async (request) => {
      launches.value += 1;
      return detached.start(request);
    },
  };
}

interface SeaRuntimeOptions {
  readonly transport: NodeLocalRuntimeTransport;
  readonly endpoints: LocalRuntimeEndpointPort;
  readonly tokens: ProtectedRuntimeTokenStore;
  readonly processes: RuntimeProcessPort;
  readonly leases: RuntimeStartupLeasePort;
  readonly artifacts: PackagedRuntimeArtifactPort;
  readonly runtimeVersion: string;
}

function createSeaRuntimeInterface(options: SeaRuntimeOptions): RuntimeInterface {
  return createRuntimeConnector({
    clients: new NodeRuntimeClient({
      transport: options.transport,
      randomId: randomUUID,
      randomNonce: () => randomBytes(32).toString('base64url'),
    }),
    endpoints: options.endpoints,
    tokens: options.tokens,
    processes: options.processes,
    leases: options.leases,
    artifacts: options.artifacts,
    clientIdentity: { name: 'hariari-desktop', version: options.runtimeVersion },
    supportedProtocolRange: { min: 1, max: 1 },
    connectDeadlineMs: 2_000,
    startupDeadlineMs: 8_000,
    reconnectDelayMs: 50,
    healthPollIntervalMs: 10_000,
    schedule: (milliseconds, task) => {
      const timer = setTimeout(task, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    now: Date.now,
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

function resolveSourceResources(): string {
  const configured = process.env.HARIARI_RUNTIME_PACKAGED_RESOURCES;
  const resourcesPath = configured
    ? path.resolve(configured)
    : path.resolve('out', 'runtime-artifacts');
  const manifestPath = path.join(
    resourcesPath,
    'runtime',
    `${process.platform}-${process.arch}`,
    'runtime-manifest.json',
  );
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Runtime SEA manifest is unavailable at ${manifestPath}`);
  }
  return resourcesPath;
}

function readManifest(resourcesPath: string): { readonly runtimeVersion: string } {
  const manifestPath = path.join(
    resourcesPath,
    'runtime',
    `${process.platform}-${process.arch}`,
    'runtime-manifest.json',
  );
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { readonly runtimeVersion: string };
}

async function cleanSeaFixtures(): Promise<void> {
  await Promise.all(children.map(stopFixtureChild));
  children.length = 0;
  await Promise.all(roots.map(removeFixtureRoot));
  roots.length = 0;
}

async function stopFixtureChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForChildExit(child);
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      child.removeListener('exit', done);
      child.removeListener('error', done);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

async function removeFixtureRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isBusyRemoval(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function isBusyRemoval(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function busyRemovalError(): NodeJS.ErrnoException {
  return Object.assign(new Error('fixture is busy'), { code: 'EBUSY' });
}

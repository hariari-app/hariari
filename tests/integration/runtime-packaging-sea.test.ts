import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import type { RuntimeInterface } from '../../src/shared/runtime/runtime-interface';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

const roots: string[] = [];
const children: ChildProcess[] = [];

describe('host Node SEA Runtime artifact', () => {
  afterEach(cleanSeaFixtures);
  it(
    'launches, handshakes, checks health, reconnects, and shuts down after resources disappear',
    verifiesPackagedSeaLifecycle,
    20_000,
  );
});

async function verifiesPackagedSeaLifecycle(): Promise<void> {
  const fixture = createSeaFixture();
  const first = fixture.createInterface();
  const connected = await first.connectOrStart();
  expect(connected).toMatchObject({
    state: 'connected',
    health: { runtimeVersion: fixture.runtimeVersion, status: 'ready', protocolVersion: 1 },
  });
  if (connected.state !== 'connected') throw new Error('expected Runtime connection');
  await first.disconnect();
  fs.rmSync(path.join(fixture.resourcesPath, 'runtime'), { recursive: true, force: true });
  const second = fixture.createInterface();
  const reconnected = await second.connectOrStart();
  expect(reconnected).toMatchObject({
    state: 'connected',
    health: { instanceId: connected.health.instanceId },
  });
  expect(fixture.launches.value).toBe(1);
  await shutdownPackagedRuntime(second, reconnected);
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
  return { resourcesPath, runtimeVersion, launches, createInterface };
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

function cleanSeaFixtures(): void {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

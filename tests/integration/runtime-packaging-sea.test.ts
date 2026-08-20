import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeInterface } from '../../src/shared/runtime/runtime-interface';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { LocalRuntimeEndpointPort } from '../../src/main/runtime/local-endpoint-port';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import type { RuntimeProcessPort } from '../../src/main/runtime/runtime-ports';
import { DetachedRuntimeProcessAdapter } from '../../src/main/runtime/detached-runtime-process';
import { PackagedRuntimeArtifactPort } from '../../src/main/runtime/packaged-runtime-artifact';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

describe('host Node SEA Runtime artifact', () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('launches, handshakes, checks health, reconnects, and shuts down after resources disappear', async () => {
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
    const detached = new DetachedRuntimeProcessAdapter({
      runtimeVersion,
      spawn: (executable, args, options) => {
        const child = nodeSpawn(executable, args, options);
        children.push(child);
        return child;
      },
    });
    let launchCount = 0;
    const processes: RuntimeProcessPort = {
      start: async (request) => {
        launchCount += 1;
        await detached.start(request);
      },
    };
    const createInterface = (): RuntimeInterface =>
      createRuntimeConnector({
        clients: new NodeRuntimeClient({
          transport,
          randomId: randomUUID,
          randomNonce: () => randomBytes(32).toString('base64url'),
        }),
        endpoints,
        tokens,
        processes,
        leases: new FileRuntimeStartupLeasePort(runtimeDirectory),
        artifacts,
        clientIdentity: { name: 'hariari-desktop', version: runtimeVersion },
        supportedProtocolRange: { min: 1, max: 1 },
        connectDeadlineMs: 2_000,
        startupDeadlineMs: 8_000,
        reconnectDelayMs: 50,
        now: Date.now,
        delay: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      });

    const first = createInterface();
    const connected = await first.connectOrStart();
    expect(connected).toMatchObject({
      state: 'connected',
      health: { runtimeVersion, status: 'ready', protocolVersion: 1 },
    });
    if (connected.state !== 'connected') throw new Error('expected Runtime connection');
    await first.disconnect();

    fs.rmSync(path.join(resourcesPath, 'runtime'), { recursive: true, force: true });
    const second = createInterface();
    const reconnected = await second.connectOrStart();
    expect(reconnected).toMatchObject({
      state: 'connected',
      health: { instanceId: connected.health.instanceId },
    });
    expect(launchCount).toBe(1);
    if (reconnected.state !== 'connected') throw new Error('expected Runtime reconnection');

    await expect(
      second.shutdown({
        idempotencyKey: 'packaged-sea-shutdown',
        expectedInstanceId: reconnected.health.instanceId,
        reason: 'test',
      }),
    ).resolves.toEqual({
      state: 'stopped',
      instanceId: reconnected.health.instanceId,
    });
  }, 20_000);
});

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

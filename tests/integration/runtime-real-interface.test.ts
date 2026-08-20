import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { LocalRuntimeEndpointPort } from '../../src/main/runtime/local-endpoint-port';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import type { RuntimeArtifactPort, RuntimeProcessPort } from '../../src/main/runtime/runtime-ports';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

describe('real local Runtime Interface vertical', () => {
  const directories: string[] = [];
  const servers: RuntimeServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts, reconnects, queries health, disconnects, and shuts down through the public seam', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-vertical-'));
    directories.push(root);
    const runtimeDirectory = path.join(root, 'state');
    const tokens = new ProtectedRuntimeTokenStore(runtimeDirectory, () =>
      new Uint8Array(32).fill(91),
    );
    const endpoints = new LocalRuntimeEndpointPort(runtimeDirectory, {
      temporaryDirectory: root,
      userId: 'test-user',
    });
    const endpoint = await endpoints.resolve();
    const transport = new NodeLocalRuntimeTransport();
    let launchCount = 0;
    let id = 0;
    const randomId = (): string => `vertical-${++id}`;
    const artifacts: RuntimeArtifactPort = {
      resolve: async () => ({
        executablePath: '/packaged/Hariari',
        entryPath: '/packaged/runtime.js',
        buildId: 'build-19',
      }),
    };
    const processes: RuntimeProcessPort = {
      start: async (request) => {
        launchCount += 1;
        expect(JSON.stringify(request)).not.toContain(
          Buffer.from(new Uint8Array(32).fill(91)).toString('base64url'),
        );
        const token = await tokens.read();
        if (!token) throw new Error('test token missing');
        const server = new RuntimeServer({
          transport,
          endpoint,
          token,
          supportedProtocolRange: { min: 1, max: 2 },
          runtimeVersion: '0.6.8',
          buildId: 'build-19',
          now: () => Date.parse('2026-08-20T10:00:00.000Z'),
          randomId,
          randomNonce: randomId,
          handshakeDeadlineMs: 500,
          requestDeadlineMs: 500,
        });
        servers.push(server);
        await server.start();
      },
    };
    const dependencies = {
      clients: new NodeRuntimeClient({ transport, randomId, randomNonce: randomId }),
      endpoints,
      tokens,
      processes,
      leases: new FileRuntimeStartupLeasePort(runtimeDirectory),
      artifacts,
      clientIdentity: { name: 'hariari-desktop' as const, version: '0.6.8' },
      supportedProtocolRange: { min: 1, max: 2 },
      connectDeadlineMs: 500,
      startupDeadlineMs: 2_000,
      reconnectDelayMs: 25,
      now: Date.now,
      delay: async (milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    };
    const first = createRuntimeConnector(dependencies);

    const connected = await first.connectOrStart();
    expect(connected).toMatchObject({
      state: 'connected',
      health: {
        instanceId: servers[0].identity.instanceId,
        buildId: 'build-19',
        startedAt: '2026-08-20T10:00:00.000Z',
        protocolVersion: 2,
      },
    });
    await first.disconnect();

    const second = createRuntimeConnector(dependencies);
    const reconnected = await second.connectOrStart();
    expect(reconnected).toMatchObject({
      state: 'connected',
      health: { instanceId: servers[0].identity.instanceId },
    });
    expect(launchCount).toBe(1);
    if (reconnected.state !== 'connected') throw new Error('expected connected Runtime');
    await expect(
      second.shutdown({
        idempotencyKey: 'vertical-shutdown',
        expectedInstanceId: reconnected.health.instanceId,
        reason: 'test',
      }),
    ).resolves.toEqual({
      state: 'stopped',
      instanceId: reconnected.health.instanceId,
    });
  });
});

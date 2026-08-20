import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import { NodeLocalRuntimeTransport } from '../../src/runtime/local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  createClientProof,
  type RuntimeAuthenticateFrame,
} from '../../src/runtime/protocol';
import { parseChallengeFrame } from '../../src/runtime/protocol-validation';
import { RuntimeServer } from '../../src/runtime/runtime-server';

const TOKEN = new Uint8Array(32).fill(42);
const NOW = Date.parse('2026-08-20T10:00:00.000Z');

describe('background Runtime server', () => {
  const directories: string[] = [];
  const servers: RuntimeServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('authenticates, negotiates the highest mutual version, and preserves identity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-server-'));
    directories.push(directory);
    const endpoint = {
      kind: 'unix' as const,
      address: path.join(directory, 'runtime.sock'),
      runtimeDirectory: directory,
    };
    let id = 0;
    const randomId = (): string => `id-${++id}`;
    const transport = new NodeLocalRuntimeTransport();
    const server = new RuntimeServer({
      transport,
      endpoint,
      token: TOKEN,
      supportedProtocolRange: { min: 2, max: 4 },
      runtimeVersion: '0.6.8',
      buildId: 'build-19',
      now: () => NOW,
      randomId,
      randomNonce: randomId,
      handshakeDeadlineMs: 500,
      requestDeadlineMs: 500,
    });
    servers.push(server);
    await server.start();
    const client = new NodeRuntimeClient({ transport, randomId, randomNonce: randomId });

    const first = await client.connect(endpoint, TOKEN, {
      clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
      supportedProtocolRange: { min: 1, max: 3 },
      deadlineMs: 500,
    });
    expect(first.kind).toBe('connected');
    if (first.kind !== 'connected') throw new Error('expected connection');
    const firstHealth = await first.session.queryHealth(500);
    expect(firstHealth).toMatchObject({
      status: 'ready',
      instanceId: server.identity.instanceId,
      buildId: 'build-19',
      protocolVersion: 3,
      startedAt: '2026-08-20T10:00:00.000Z',
    });
    await first.session.disconnect();

    const second = await client.connect(endpoint, TOKEN, {
      clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
      supportedProtocolRange: { min: 3, max: 4 },
      deadlineMs: 500,
    });
    expect(second.kind).toBe('connected');
    if (second.kind !== 'connected') throw new Error('expected reconnection');
    await expect(second.session.queryHealth(500)).resolves.toMatchObject({
      instanceId: firstHealth.instanceId,
      buildId: firstHealth.buildId,
      startedAt: firstHealth.startedAt,
      protocolVersion: 4,
    });
    await expect(
      second.session.shutdown(
        {
          idempotencyKey: 'shutdown-real-server',
          expectedInstanceId: firstHealth.instanceId,
          reason: 'test',
        },
        500,
      ),
    ).resolves.toEqual({ state: 'stopped', instanceId: firstHealth.instanceId });
    await server.stop();
    await expect(
      client.connect(endpoint, TOKEN, {
        clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
        supportedProtocolRange: { min: 1, max: 4 },
        deadlineMs: 50,
      }),
    ).rejects.toEqual(new RuntimePortError('endpoint-unavailable'));
  });

  it('reports incompatible only after authenticated disjoint ranges', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-version-'));
    directories.push(directory);
    const endpoint = {
      kind: 'unix' as const,
      address: path.join(directory, 'runtime.sock'),
      runtimeDirectory: directory,
    };
    let id = 0;
    const randomId = (): string => `version-${++id}`;
    const transport = new NodeLocalRuntimeTransport();
    const server = new RuntimeServer({
      transport,
      endpoint,
      token: TOKEN,
      supportedProtocolRange: { min: 5, max: 7 },
      runtimeVersion: '0.7.0',
      buildId: 'future-build',
      now: () => NOW,
      randomId,
      randomNonce: randomId,
      handshakeDeadlineMs: 500,
      requestDeadlineMs: 500,
    });
    servers.push(server);
    await server.start();
    const client = new NodeRuntimeClient({ transport, randomId, randomNonce: randomId });

    await expect(
      client.connect(endpoint, TOKEN, {
        clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
        supportedProtocolRange: { min: 1, max: 3 },
        deadlineMs: 500,
      }),
    ).resolves.toEqual({
      kind: 'incompatible',
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: '0.7.0',
      buildId: 'future-build',
    });

    const secretText = Buffer.from(TOKEN).toString('base64url');
    await expect(
      client.connect(endpoint, new Uint8Array(32).fill(99), {
        clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
        supportedProtocolRange: { min: 1, max: 3 },
        deadlineMs: 500,
      }),
    ).rejects.toEqual(new RuntimePortError('authentication-rejected'));
    await client
      .connect(endpoint, new Uint8Array(32).fill(99), {
        clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
        supportedProtocolRange: { min: 1, max: 3 },
        deadlineMs: 500,
      })
      .catch((error: unknown) => expect(JSON.stringify(error)).not.toContain(secretText));
  });

  it('expires challenges and rejects their replay without version disclosure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-replay-'));
    directories.push(directory);
    const endpoint = {
      kind: 'unix' as const,
      address: path.join(directory, 'runtime.sock'),
      runtimeDirectory: directory,
    };
    let now = NOW;
    let id = 0;
    const randomId = (): string => `replay-${++id}`;
    const transport = new NodeLocalRuntimeTransport();
    const server = new RuntimeServer({
      transport,
      endpoint,
      token: TOKEN,
      supportedProtocolRange: { min: 1, max: 1 },
      runtimeVersion: 'secret-version',
      buildId: 'secret-build',
      now: () => now,
      randomId,
      randomNonce: randomId,
      handshakeDeadlineMs: 50,
      requestDeadlineMs: 500,
    });
    servers.push(server);
    await server.start();
    const connection = await transport.connect(endpoint, 500);
    const challenge = parseChallengeFrame(await connection.readFrame(500));
    const withoutProof: Omit<RuntimeAuthenticateFrame, 'proof'> = {
      kind: 'runtime.authenticate',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: challenge.challengeId,
      requestId: 'replay-request',
      clientNonce: 'replay-client-nonce',
      client: { name: 'hariari-desktop', version: '0.6.8' },
      protocolRange: { min: 1, max: 1 },
    };
    now += 51;
    await connection.writeFrame(
      { ...withoutProof, proof: createClientProof(TOKEN, challenge, withoutProof) },
      500,
    );

    const rejected = await connection.readFrame(500);
    expect(rejected).toEqual({
      kind: 'runtime.unauthorized',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    });
    expect(JSON.stringify(rejected)).not.toContain('secret-version');
    expect(JSON.stringify(rejected)).not.toContain('secret-build');
  });
});

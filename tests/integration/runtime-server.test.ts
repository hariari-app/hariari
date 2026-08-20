import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { RuntimePortError, type RuntimeEndpoint } from '../../src/main/runtime/runtime-ports';
import type { RuntimeProtocolRange } from '../../src/shared/runtime/runtime-interface';
import {
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeLocalTransport,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  createClientProof,
  type RuntimeAuthenticateFrame,
} from '../../src/runtime/protocol';
import { parseChallengeFrame } from '../../src/runtime/protocol-validation';
import { RuntimeServer } from '../../src/runtime/runtime-server';

const TOKEN = new Uint8Array(32).fill(42);
const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const directories: string[] = [];
const servers: RuntimeServer[] = [];

describe('background Runtime server', () => {
  afterEach(cleanRuntimeFixtures);
  it(
    'authenticates, negotiates the highest mutual version, and preserves identity',
    verifiesIdentity,
  );
  it('reports incompatible only after authenticated disjoint ranges', verifiesIncompatibility);
  it('expires challenges and rejects their replay without version disclosure', rejectsReplay);
  it('closes exactly one listener when stopped during startup', stopsDuringStartup);
});

async function stopsDuringStartup(): Promise<void> {
  const listen = deferred<RuntimeTransportListener>();
  let closeCount = 0;
  const transport: RuntimeLocalTransport = {
    connect: async () => Promise.reject(new Error('not used')),
    listen: async () => listen.promise,
  };
  const server = runtimeServer(transport, {
    kind: 'unix',
    address: '/tmp/runtime-server-start-race.sock',
    runtimeDirectory: '/tmp',
  });
  const start = server.start();
  const stop = server.stop();

  listen.resolve({ close: async () => void (closeCount += 1) });
  await Promise.all([start, stop, server.stop()]);

  expect(closeCount).toBe(1);
}

async function verifiesIdentity(): Promise<void> {
  const fixture = await startRuntime({
    prefix: 'id',
    range: { min: 2, max: 4 },
    runtimeVersion: '0.6.8',
    buildId: 'build-19',
    now: () => NOW,
  });
  const first = await connect(fixture, TOKEN, { min: 1, max: 3 });
  expect(first.kind).toBe('connected');
  if (first.kind !== 'connected') throw new Error('expected connection');
  const firstHealth = await first.session.queryHealth(500);
  expect(firstHealth).toMatchObject({
    status: 'ready',
    instanceId: fixture.server.identity.instanceId,
    buildId: 'build-19',
    protocolVersion: 3,
    startedAt: '2026-08-20T10:00:00.000Z',
  });
  await first.session.disconnect();
  await reconnectAndShutdown(fixture, firstHealth);
}

async function reconnectAndShutdown(
  fixture: ServerFixture,
  firstHealth: { instanceId: string; buildId: string; startedAt: string },
): Promise<void> {
  const second = await connect(fixture, TOKEN, { min: 3, max: 4 });
  expect(second.kind).toBe('connected');
  if (second.kind !== 'connected') throw new Error('expected reconnection');
  await expect(second.session.queryHealth(500)).resolves.toMatchObject({
    ...firstHealth,
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
  await fixture.server.stop();
  await expect(connect(fixture, TOKEN, { min: 1, max: 4 }, 50)).rejects.toEqual(
    new RuntimePortError('endpoint-unavailable'),
  );
}

async function verifiesIncompatibility(): Promise<void> {
  const fixture = await startRuntime({
    prefix: 'version',
    range: { min: 5, max: 7 },
    runtimeVersion: '0.7.0',
    buildId: 'future-build',
    now: () => NOW,
  });
  await expect(connect(fixture, TOKEN, { min: 1, max: 3 })).resolves.toEqual({
    kind: 'incompatible',
    runtimeRange: { min: 5, max: 7 },
    runtimeVersion: '0.7.0',
    buildId: 'future-build',
  });
  const wrongToken = new Uint8Array(32).fill(99);
  await expect(connect(fixture, wrongToken, { min: 1, max: 3 })).rejects.toEqual(
    new RuntimePortError('authentication-rejected'),
  );
  const secretText = Buffer.from(TOKEN).toString('base64url');
  await connect(fixture, wrongToken, { min: 1, max: 3 }).catch((error: unknown) =>
    expect(JSON.stringify(error)).not.toContain(secretText),
  );
}

async function rejectsReplay(): Promise<void> {
  let now = NOW;
  const fixture = await startRuntime({
    prefix: 'replay',
    range: { min: 1, max: 1 },
    runtimeVersion: 'secret-version',
    buildId: 'secret-build',
    now: () => now,
    handshakeDeadlineMs: 50,
  });
  const connection = await fixture.transport.connect(fixture.endpoint, 500);
  const challenge = parseChallengeFrame(await connection.readFrame(500));
  const authenticate = replayAuthentication(challenge.challengeId);
  now += 51;
  await sendAuthentication(connection, challenge, authenticate);
  const rejected = await connection.readFrame(500);
  expect(rejected).toEqual({
    kind: 'runtime.unauthorized',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
  });
  expect(JSON.stringify(rejected)).not.toContain('secret-version');
  expect(JSON.stringify(rejected)).not.toContain('secret-build');
}

function replayAuthentication(challengeId: string): Omit<RuntimeAuthenticateFrame, 'proof'> {
  return {
    kind: 'runtime.authenticate',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId,
    requestId: 'replay-request',
    clientNonce: 'replay-client-nonce',
    client: { name: 'hariari-desktop', version: '0.6.8' },
    protocolRange: { min: 1, max: 1 },
  };
}

async function sendAuthentication(
  connection: RuntimeFrameConnection,
  challenge: Parameters<typeof createClientProof>[1],
  authenticate: Omit<RuntimeAuthenticateFrame, 'proof'>,
): Promise<void> {
  await connection.writeFrame(
    { ...authenticate, proof: createClientProof(TOKEN, challenge, authenticate) },
    500,
  );
}

interface RuntimeFixtureOptions {
  readonly prefix: string;
  readonly range: RuntimeProtocolRange;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly now: () => number;
  readonly handshakeDeadlineMs?: number;
}

interface ServerFixture {
  readonly endpoint: RuntimeEndpoint;
  readonly transport: NodeLocalRuntimeTransport;
  readonly server: RuntimeServer;
  readonly client: NodeRuntimeClient;
}

async function startRuntime(options: RuntimeFixtureOptions): Promise<ServerFixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hariari-runtime-${options.prefix}-`));
  directories.push(directory);
  const endpoint: RuntimeEndpoint = {
    kind: 'unix',
    address: path.join(directory, 'runtime.sock'),
    runtimeDirectory: directory,
  };
  let id = 0;
  const randomId = (): string => `${options.prefix}-${++id}`;
  const transport = new NodeLocalRuntimeTransport();
  const server = new RuntimeServer({
    transport,
    endpoint,
    token: TOKEN,
    supportedProtocolRange: options.range,
    runtimeVersion: options.runtimeVersion,
    buildId: options.buildId,
    now: options.now,
    randomId,
    randomNonce: randomId,
    handshakeDeadlineMs: options.handshakeDeadlineMs ?? 500,
    requestDeadlineMs: 500,
  });
  servers.push(server);
  await server.start();
  const client = new NodeRuntimeClient({ transport, randomId, randomNonce: randomId });
  return { endpoint, transport, server, client };
}

function runtimeServer(
  transport: RuntimeLocalTransport,
  endpoint: RuntimeLocalEndpoint,
): RuntimeServer {
  let id = 0;
  return new RuntimeServer({
    transport,
    endpoint,
    token: TOKEN,
    supportedProtocolRange: { min: 1, max: 1 },
    runtimeVersion: '0.6.8',
    buildId: 'build-19',
    now: () => NOW,
    randomId: () => `race-${++id}`,
    randomNonce: () => `race-nonce-${++id}`,
    handshakeDeadlineMs: 500,
    requestDeadlineMs: 500,
  });
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function connect(
  fixture: ServerFixture,
  token: Uint8Array,
  supportedProtocolRange: RuntimeProtocolRange,
  deadlineMs = 500,
) {
  return fixture.client.connect(fixture.endpoint, token, {
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange,
    deadlineMs,
  });
}

async function cleanRuntimeFixtures(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

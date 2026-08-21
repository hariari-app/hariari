import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import { LocalRuntimeEndpointPort } from '../../src/main/runtime/local-endpoint-port';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import type {
  RuntimeArtifactPort,
  RuntimeEndpoint,
  RuntimeProcessPort,
} from '../../src/main/runtime/runtime-ports';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import type { RuntimeInterface } from '../../src/shared/runtime/runtime-interface';
import {
  NodeLocalRuntimeTransport,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { ProtectedRuntimeTokenStore } from '../../src/runtime/token-store';

const directories: string[] = [];
const servers: RuntimeServer[] = [];

describe('real local Runtime Interface vertical', () => {
  afterEach(cleanRuntimeFixtures);
  it(
    'starts, reconnects, queries health, disconnects, and shuts down through the public seam',
    verifiesRealRuntimeLifecycle,
  );
  it('waits for endpoint termination before public shutdown reports stopped', verifiesShutdown);
  it(
    'keeps a healthy idle session connected across multiple server request deadlines',
    verifiesIdleHealthSupervision,
  );
  it(
    'creates, lists, idempotently replays, and rebuilds durable Tasks through RuntimeInterface',
    verifiesDurableTasks,
  );
});

async function verifiesDurableTasks(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const runtime = fixture.createInterface();
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const request = {
    objective: 'Make durable task creation observable.',
    project: 'Hariari',
    repository: 'hariari-app/hariari',
    baseRef: 'main',
    provider: 'codex',
    idempotencyKey: 'task-create-one',
  } as const;

  const created = await runtime.createTask(request);
  await expect(
    Promise.all([runtime.createTask(request), runtime.createTask(request)]),
  ).resolves.toEqual([created, created]);
  await expect(
    runtime.createTask({ ...request, objective: 'A different task with the same key' }),
  ).rejects.toEqual(new RuntimePortError('idempotency-conflict', false));
  await expect(runtime.listTasks()).resolves.toEqual([created]);
  await runtime.disconnect();

  await servers[0]?.stop();
  fs.rmSync(path.join(fixture.runtimeDirectory, 'tasks', 'projection.json'));
  const restarted = fixture.createInterface();
  await expect(restarted.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  await expect(restarted.listTasks()).resolves.toEqual([created]);
  await restarted.disconnect();
}

async function verifiesIdleHealthSupervision(): Promise<void> {
  const fixture = await createRealRuntimeFixture({
    requestDeadlineMs: 80,
    healthPollIntervalMs: 20,
  });
  const runtime = fixture.createInterface();
  const observed: Array<Awaited<ReturnType<RuntimeInterface['queryHealth']>>> = [];
  runtime.subscribeStatus((state) => observed.push(state));
  await expect(runtime.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
  const connectedAt = observed.findIndex((state) => state.state === 'connected');

  await waitFor(260);

  expect(observed.slice(connectedAt)).toHaveLength(1);
  expect(observed.at(-1)?.state).toBe('connected');
  await runtime.disconnect();
}

async function verifiesShutdown(): Promise<void> {
  const fixture = await createRealRuntimeFixture({ gateShutdown: true });
  const runtime = fixture.createInterface();
  const connected = await runtime.connectOrStart();
  if (connected.state !== 'connected') throw new Error('expected connected Runtime');
  let settled = false;
  const shutdown = runtime
    .shutdown({
      idempotencyKey: 'termination-shutdown',
      expectedInstanceId: connected.health.instanceId,
      reason: 'test',
    })
    .then((result) => {
      settled = true;
      return result;
    });

  await fixture.transport.closeRequested;
  const settledBeforeEndpointRelease = settled;
  fixture.transport.releaseClose();
  expect(settledBeforeEndpointRelease).toBe(false);
  await expect(shutdown).resolves.toEqual({
    state: 'stopped',
    instanceId: connected.health.instanceId,
  });
  await expect(fixture.transport.connect(fixture.endpoint, 50)).rejects.toMatchObject({
    code: 'endpoint-unavailable',
  });
}

async function verifiesRealRuntimeLifecycle(): Promise<void> {
  const fixture = await createRealRuntimeFixture();
  const first = fixture.createInterface();
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
  const second = fixture.createInterface();
  const reconnected = await second.connectOrStart();
  expect(reconnected).toMatchObject({
    state: 'connected',
    health: { instanceId: servers[0].identity.instanceId },
  });
  expect(fixture.launches.value).toBe(1);
  await shutdownConnectedRuntime(second, reconnected);
}

async function shutdownConnectedRuntime(
  runtime: RuntimeInterface,
  state: Awaited<ReturnType<RuntimeInterface['connectOrStart']>>,
): Promise<void> {
  if (state.state !== 'connected') throw new Error('expected connected Runtime');
  await expect(
    runtime.shutdown({
      idempotencyKey: 'vertical-shutdown',
      expectedInstanceId: state.health.instanceId,
      reason: 'test',
    }),
  ).resolves.toEqual({
    state: 'stopped',
    instanceId: state.health.instanceId,
  });
}

interface RealRuntimeFixture {
  readonly launches: { value: number };
  readonly createInterface: () => RuntimeInterface;
  readonly endpoint: RuntimeEndpoint;
  readonly runtimeDirectory: string;
  readonly transport: GatedCloseTransport;
}

interface RealRuntimeFixtureOptions {
  readonly gateShutdown?: boolean;
  readonly requestDeadlineMs?: number;
  readonly healthPollIntervalMs?: number;
}

async function createRealRuntimeFixture(
  options: RealRuntimeFixtureOptions = {},
): Promise<RealRuntimeFixture> {
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
  const transport = new GatedCloseTransport(options.gateShutdown ?? false);
  let id = 0;
  const randomId = (): string => `vertical-${++id}`;
  const launches = { value: 0 };
  const processes = createProcessPort({
    tokens,
    endpoint,
    transport,
    randomId,
    launches,
    requestDeadlineMs: options.requestDeadlineMs,
  });
  const artifacts: RuntimeArtifactPort = {
    resolve: async () => ({
      executablePath: '/packaged/Hariari',
      runtimeVersion: '0.6.8',
      buildId: 'build-19',
    }),
  };
  const createInterface = (): RuntimeInterface =>
    createRuntimeConnector({
      clients: new NodeRuntimeClient({ transport, randomId, randomNonce: randomId }),
      endpoints,
      tokens,
      processes,
      leases: new FileRuntimeStartupLeasePort(runtimeDirectory),
      artifacts,
      clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
      supportedProtocolRange: { min: 1, max: 2 },
      connectDeadlineMs: 500,
      startupDeadlineMs: 2_000,
      reconnectDelayMs: 25,
      healthPollIntervalMs: options.healthPollIntervalMs ?? 100,
      schedule: scheduleTestTask,
      now: Date.now,
      delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
  return { launches, createInterface, endpoint, runtimeDirectory, transport };
}

interface ProcessFixtureOptions {
  readonly tokens: ProtectedRuntimeTokenStore;
  readonly endpoint: RuntimeEndpoint;
  readonly transport: NodeLocalRuntimeTransport;
  readonly randomId: () => string;
  readonly launches: { value: number };
  readonly requestDeadlineMs?: number;
}

function createProcessPort(options: ProcessFixtureOptions): RuntimeProcessPort {
  return {
    start: async (request) => {
      options.launches.value += 1;
      expect(JSON.stringify(request)).not.toContain(
        Buffer.from(new Uint8Array(32).fill(91)).toString('base64url'),
      );
      const token = await options.tokens.read();
      if (!token) throw new Error('test token missing');
      const server = new RuntimeServer({
        transport: options.transport,
        endpoint: options.endpoint,
        token,
        supportedProtocolRange: { min: 1, max: 2 },
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
        now: () => Date.parse('2026-08-20T10:00:00.000Z'),
        randomId: options.randomId,
        randomNonce: options.randomId,
        handshakeDeadlineMs: 500,
        requestDeadlineMs: options.requestDeadlineMs ?? 500,
      });
      servers.push(server);
      await server.start();
      return {
        terminate: () => server.stop(),
        settled: async () => undefined,
      };
    },
  };
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scheduleTestTask(milliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, milliseconds);
  return () => clearTimeout(timer);
}

async function cleanRuntimeFixtures(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

class GatedCloseTransport extends NodeLocalRuntimeTransport {
  readonly closeRequested: Promise<void>;
  private resolveCloseRequested: () => void = () => undefined;
  private allowClose: () => void = () => undefined;
  private readonly closeAllowed: Promise<void>;

  constructor(private readonly gated: boolean) {
    super();
    this.closeRequested = new Promise((resolve) => {
      this.resolveCloseRequested = resolve;
    });
    this.closeAllowed = new Promise((resolve) => {
      this.allowClose = resolve;
    });
  }

  override async listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    const listener = await super.listen(endpoint, onConnection);
    if (!this.gated) return listener;
    return {
      close: async () => {
        this.resolveCloseRequested();
        await this.closeAllowed;
        await listener.close();
      },
    };
  }

  releaseClose(): void {
    this.allowClose();
  }
}

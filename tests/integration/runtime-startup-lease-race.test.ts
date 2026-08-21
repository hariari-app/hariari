import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileRuntimeStartupLeasePort } from '../../src/main/runtime/file-startup-lease';
import {
  createRuntimeConnector,
  type RuntimeConnectorDependencies,
} from '../../src/main/runtime/runtime-connector';
import type { RuntimeArtifactPort, RuntimeProcessPort } from '../../src/main/runtime/runtime-ports';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

const roots: string[] = [];

describe('Runtime startup lease fencing', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('fences a stale owner immediately before launch after a successor takes over', async () => {
    const environment = new FakeRuntimeEnvironment();
    const artifactEntered = deferred<void>();
    const releaseArtifact = deferred<void>();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-lease-race-'));
    roots.push(root);
    let now = Date.now();
    let launches = 0;
    const processes = processPort(environment, () => void (launches += 1));
    const first = connector(environment, {
      artifacts: gatedArtifacts(environment.artifacts, artifactEntered, releaseArtifact),
      processes,
      leases: leasePort(root, 'first-owner', () => now),
      now: () => now,
    });
    const firstConnect = first.connectOrStart();
    await artifactEntered.promise;

    now += 5_001;
    const second = connector(environment, {
      processes,
      leases: leasePort(root, 'successor', () => now),
      now: () => now,
    });
    await expect(second.connectOrStart()).resolves.toMatchObject({ state: 'connected' });
    releaseArtifact.resolve();
    await expect(firstConnect).resolves.toMatchObject({ state: 'connected' });

    expect(launches).toBe(1);
  });
});

function gatedArtifacts(
  artifacts: RuntimeArtifactPort,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): RuntimeArtifactPort {
  return {
    resolve: async () => {
      entered.resolve();
      await release.promise;
      return artifacts.resolve();
    },
  };
}

function processPort(
  environment: FakeRuntimeEnvironment,
  recordLaunch: () => void,
): RuntimeProcessPort {
  return {
    start: async () => {
      recordLaunch();
      environment.running = true;
      return {
        terminate: async () => void (environment.running = false),
        settled: async () => undefined,
      };
    },
  };
}

function leasePort(directory: string, leaseId: string, now: () => number) {
  return new FileRuntimeStartupLeasePort(directory, {
    processId: leaseId === 'first-owner' ? 101 : 202,
    randomId: () => leaseId,
    now,
    heartbeatIntervalMs: 1_000,
    staleAfterMs: 5_000,
    setHeartbeatInterval: () => setInterval(() => undefined, 2_147_483_647),
  });
}

function connector(
  environment: FakeRuntimeEnvironment,
  overrides: Partial<RuntimeConnectorDependencies>,
) {
  return createRuntimeConnector({
    clients: environment.clients,
    endpoints: environment.endpoints,
    tokens: environment.tokens,
    processes: environment.processes,
    leases: environment.leases,
    artifacts: environment.artifacts,
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange: { min: 1, max: 2 },
    connectDeadlineMs: 100,
    startupDeadlineMs: 50,
    reconnectDelayMs: 25,
    healthPollIntervalMs: 10_000,
    schedule: () => () => undefined,
    now: environment.now,
    delay: environment.delay,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

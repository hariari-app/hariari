import { describe, expect, it } from 'vitest';
import {
  createRuntimeConnector,
  type RuntimeConnectorDependencies,
} from '../../src/main/runtime/runtime-connector';
import type { RuntimeConnectionState } from '../../src/shared/runtime/runtime-interface';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

describe('Runtime Interface', () => {
  it('connects first, starts one missing Runtime, and queries health', async () => {
    const environment = new FakeRuntimeEnvironment();
    const runtime = connector(environment);

    await expect(runtime.connectOrStart()).resolves.toEqual({
      state: 'connected',
      health: environment.health,
    });
    expect(environment.launchCount).toBe(1);
    expect(environment.connectCount).toBe(3);
  });

  it('coalesces concurrent startup in one client and across Desktop clients', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.tokenAvailable = false;
    const first = connector(environment);
    const second = connector(environment);

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => first.connectOrStart()),
      second.connectOrStart(),
    ]);

    expect(results.every((result) => result.state === 'connected')).toBe(true);
    expect(environment.launchCount).toBe(1);
    expect(
      results.every(
        (result) =>
          result.state === 'connected' &&
          result.health.instanceId === environment.health.instanceId,
      ),
    ).toBe(true);
  });

  it('disconnects only the client and a fresh client reconnects to the same Runtime', async () => {
    const environment = new FakeRuntimeEnvironment();
    const first = connector(environment);
    await first.connectOrStart();

    await first.disconnect();
    const second = connector(environment);
    const reconnected = await second.connectOrStart();

    expect(reconnected).toMatchObject({
      state: 'connected',
      health: { instanceId: environment.health.instanceId },
    });
    expect(environment.launchCount).toBe(1);
    expect(environment.shutdownCount).toBe(0);
  });

  it('reconnects after transport loss and preserves the Runtime identity', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    const runtime = connector(environment);
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));
    await runtime.connectOrStart();

    environment.dropConnections();
    await eventually(() => observed.at(-1)?.state === 'connected');

    expect(observed.some((state) => state.state === 'unavailable')).toBe(true);
    expect(observed.at(-1)).toMatchObject({
      state: 'connected',
      health: { instanceId: environment.health.instanceId },
    });
    expect(environment.launchCount).toBe(0);
  });

  it('surfaces incompatible only for authenticated disjoint ranges and never replaces it', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.serverRange = { min: 5, max: 7 };
    const runtime = connector(environment);

    await expect(runtime.connectOrStart()).resolves.toEqual({
      state: 'incompatible',
      desktopRange: { min: 1, max: 2 },
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: environment.health.runtimeVersion,
      buildId: environment.health.buildId,
    });
    expect(environment.launchCount).toBe(0);

    environment.authenticationFailure = true;
    const unauthenticated = connector(environment);
    await expect(unauthenticated.connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: 'authentication-rejected',
      retryable: false,
    });
    expect(environment.launchCount).toBe(0);

    environment.authenticationFailure = false;
    environment.connectionFailure = true;
    const inaccessible = connector(environment);
    await expect(inaccessible.connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: 'connection-failed',
      retryable: true,
    });
    expect(environment.launchCount).toBe(0);
  });

  it('bounds startup and returns a stable timeout without duplicate launches', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.availabilityFailures = 100;
    const runtime = connector(environment, { startupDeadlineMs: 50 });

    await expect(runtime.connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: 'startup-timeout',
      retryable: true,
    });
    expect(environment.launchCount).toBe(1);
  });

  it('performs privileged shutdown idempotently without autostart', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    const runtime = connector(environment);
    await runtime.connectOrStart();
    const request = {
      idempotencyKey: 'shutdown-1',
      expectedInstanceId: environment.health.instanceId,
      reason: 'test' as const,
    };

    await expect(runtime.shutdown(request)).resolves.toEqual({
      state: 'stopped',
      instanceId: environment.health.instanceId,
    });
    await expect(runtime.shutdown(request)).resolves.toEqual({ state: 'not-running' });
    expect(environment.shutdownCount).toBe(1);
    expect(environment.launchCount).toBe(0);
  });

  it('keeps tokens and launch paths out of statuses, errors, and process requests', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.authenticationFailure = true;
    const runtime = connector(environment);
    const state = await runtime.connectOrStart();
    const secret = Buffer.from(environment.token).toString('base64url');

    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(state)).not.toContain(environment.endpoint.address);
    expect(JSON.stringify(environment.launchRequests)).not.toContain(secret);
  });
});

function connector(
  environment: FakeRuntimeEnvironment,
  overrides: Partial<RuntimeConnectorDependencies> = {},
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
    startupDeadlineMs: 1_000,
    reconnectDelayMs: 25,
    now: environment.now,
    delay: environment.delay,
    ...overrides,
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

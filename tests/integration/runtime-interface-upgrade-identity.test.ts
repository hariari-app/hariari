import { describe, expect, it } from 'vitest';
import {
  createRuntimeConnector,
  type RuntimeConnectorDependencies,
} from '../../src/main/runtime/runtime-connector';
import type { RuntimeProcessPort } from '../../src/main/runtime/runtime-ports';
import type { RuntimeConnectionState } from '../../src/shared/runtime/runtime-interface';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

describe('Runtime Interface packaged identity lifecycle', () => {
  it('reconnects to an exact packaged Runtime identity without restarting it', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;

    const connected = await connector(environment).connectOrStart();

    expect(connected).toMatchObject({
      state: 'connected',
      health: {
        instanceId: 'runtime-1',
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
      },
    });
    expect(environment.shutdownCount).toBe(0);
    expect(environment.launchCount).toBe(0);
  });

  it.each([
    {
      mismatch: 'version',
      runningVersion: '0.6.7',
      runningBuildId: 'build-18',
    },
    {
      mismatch: 'build',
      runningVersion: '0.6.8',
      runningBuildId: 'build-18',
    },
  ])(
    'fences and replaces a protocol-compatible Runtime with a stale $mismatch',
    async ({ runningVersion, runningBuildId }) => {
      const environment = new FakeRuntimeEnvironment();
      environment.running = true;
      environment.setRunningIdentity(runningVersion, runningBuildId);
      const runtime = connector(environment);
      const observed: RuntimeConnectionState[] = [];
      runtime.subscribeStatus((state) => observed.push(state));

      const connected = await runtime.connectOrStart();

      expect(connected).toMatchObject({
        state: 'connected',
        health: {
          instanceId: 'runtime-1',
          runtimeVersion: '0.6.8',
          buildId: 'build-19',
        },
      });
      expect(environment.shutdownCount).toBe(1);
      expect(environment.launchCount).toBe(1);
      expect(environment.running).toBe(true);
      expect(
        observed.some(
          (state) => state.state === 'connected' && state.health.instanceId === 'runtime-old',
        ),
      ).toBe(false);
    },
  );

  it('coalesces concurrent stale-Runtime replacement behind the startup lease', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.setRunningIdentity('0.6.7', 'build-18');
    let launches = 0;
    const processes = replacementProcess(environment, () => void (launches += 1));
    const first = connector(environment, { processes });
    const second = connector(environment, { processes });

    const connected = await Promise.all([first.connectOrStart(), second.connectOrStart()]);

    expect(connected).toEqual([
      expect.objectContaining({
        state: 'connected',
        health: expect.objectContaining({
          instanceId: 'runtime-new',
          runtimeVersion: '0.6.8',
          buildId: 'build-19',
        }),
      }),
      expect.objectContaining({
        state: 'connected',
        health: expect.objectContaining({
          instanceId: 'runtime-new',
          runtimeVersion: '0.6.8',
          buildId: 'build-19',
        }),
      }),
    ]);
    expect(environment.shutdownCount).toBe(1);
    expect(launches).toBe(1);
  });

  it('awaits stale endpoint release before launching the packaged Runtime', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.shutdownLeavesRunning = true;
    environment.setRunningIdentity('0.6.7', 'build-18');

    await expect(
      connector(environment, { connectDeadlineMs: 50 }).connectOrStart(),
    ).resolves.toEqual({
      state: 'unavailable',
      reason: 'health-timeout',
      retryable: true,
    });
    expect(environment.shutdownCount).toBe(1);
    expect(environment.launchCount).toBe(0);
    expect(environment.running).toBe(true);
  });

  it('does not stop a healthy Runtime when packaged identity cannot be verified', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.artifactFailure = true;

    await expect(connector(environment).connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: 'artifact-unavailable',
      retryable: false,
    });
    expect(environment.shutdownCount).toBe(0);
    expect(environment.launchCount).toBe(0);
    expect(environment.running).toBe(true);
  });

  it('preserves incompatible state without attempting an identity replacement', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    environment.serverRange = { min: 5, max: 7 };
    environment.setRunningIdentity('0.6.7', 'build-18');

    await expect(connector(environment).connectOrStart()).resolves.toEqual({
      state: 'incompatible',
      desktopRange: { min: 1, max: 2 },
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: '0.6.7',
      buildId: 'build-18',
    });
    expect(environment.shutdownCount).toBe(0);
    expect(environment.launchCount).toBe(0);
  });
});

function replacementProcess(
  environment: FakeRuntimeEnvironment,
  recordLaunch: () => void,
): RuntimeProcessPort {
  return {
    start: async ({ artifact }) => {
      recordLaunch();
      environment.setRunningIdentity(artifact.runtimeVersion, artifact.buildId, 'runtime-new');
      environment.running = true;
      return {
        terminate: async () => void (environment.running = false),
        settled: async () => undefined,
      };
    },
  };
}

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
    healthPollIntervalMs: 10_000,
    schedule: () => () => undefined,
    now: environment.now,
    delay: environment.delay,
    ...overrides,
  });
}

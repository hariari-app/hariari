import { describe, expect, it } from 'vitest';
import {
  createRuntimeConnector,
  type RuntimeConnectorDependencies,
} from '../../src/main/runtime/runtime-connector';
import type { RuntimeClientPort } from '../../src/main/runtime/runtime-ports';
import type { RuntimeConnectionState } from '../../src/shared/runtime/runtime-interface';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

const RECONNECT_TERMINAL_CASES = [
  {
    name: 'an authenticated incompatible Runtime',
    configure: (environment: FakeRuntimeEnvironment) => {
      environment.serverRange = { min: 5, max: 7 };
    },
    expected: { state: 'incompatible' },
  },
  {
    name: 'a non-retryable authentication rejection',
    configure: (environment: FakeRuntimeEnvironment) => {
      environment.authenticationFailure = true;
    },
    expected: { state: 'unavailable', reason: 'authentication-rejected', retryable: false },
  },
] as const;

const HEALTH_FAILURE_CASES = [
  {
    code: 'timeout',
    expected: { state: 'unavailable', reason: 'health-timeout', retryable: true },
  },
  {
    code: 'protocol-error',
    expected: { state: 'unavailable', reason: 'protocol-error', retryable: false },
  },
  {
    code: 'transport-lost',
    expected: { state: 'unavailable', reason: 'transport-lost', retryable: true },
  },
] as const;

describe('Runtime Interface', registerRuntimeInterfaceTests);

function registerRuntimeInterfaceTests(): void {
  registerStartupTests();
  registerConnectionLifecycleTests();
  registerHealthSupervisionTest();
  registerHealthQueryFailureTests();
  registerInitialHealthFailureTests();
  registerHealthFailureSupervisionTest();
  registerPersistentReconnectTest();
  registerDelayedReconnectCancellationTest();
  registerInFlightReconnectCancellationTest();
  registerReconnectTerminalStateTests();
  registerInitialRetryTests();
  registerRetainedLaunchRetryTest();
  registerInitialRetryTerminalStateTests();
  registerConnectionFailureTests();
  registerBoundarySecurityTest();
  registerTaskExecutionIdentityTest();
}

function registerTaskExecutionIdentityTest(): void {
  it('starts one created Task and returns its joined execution identity through RuntimeInterface', async () => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    const runtime = connector(environment);
    const task = await runtime.createTask({
      objective: 'Run one deterministic task.',
      project: 'Hariari',
      repository: 'local-checkout',
      baseRef: 'main',
      provider: 'shell',
      idempotencyKey: 'create-execution-task',
    });

    const started = await runtime.startTask({
      taskId: task.id,
      idempotencyKey: 'start-execution-task',
    });

    expect(started).toMatchObject({
      task: { id: task.id, executionState: 'running' },
      run: { id: 'run-1', number: 1 },
      attempt: { id: 'attempt-1', number: 1, state: 'running' },
      context: {
        id: 'context-1',
        worktreeId: 'worktree-1',
        processId: 'process-1',
        ptyId: 'pty-1',
      },
    });
    await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(started);
    await expect(
      runtime.startTask({ taskId: task.id, idempotencyKey: 'start-execution-task' }),
    ).resolves.toEqual(started);
  });
}

function registerInitialHealthFailureTests(): void {
  it.each(HEALTH_FAILURE_CASES)(
    'preserves $code from the first post-handshake health query',
    async (testCase) => {
      const environment = new FakeRuntimeEnvironment();
      environment.running = true;
      environment.healthFailure = true;
      environment.healthFailureCode = testCase.code;

      await expect(connector(environment).connectOrStart()).resolves.toEqual(testCase.expected);
    },
  );
}

function registerHealthQueryFailureTests(): void {
  it.each(HEALTH_FAILURE_CASES)('maps $code from queryHealth precisely', async (testCase) => {
    const environment = new FakeRuntimeEnvironment();
    environment.running = true;
    const runtime = connector(environment);
    await runtime.connectOrStart();

    environment.healthFailure = true;
    environment.healthFailureCode = testCase.code;

    await expect(runtime.queryHealth()).resolves.toEqual(testCase.expected);
  });
}

function registerRetainedLaunchRetryTest(): void {
  it('retains an unready launch across retries and relaunches once after exit', async () => {
    const environment = new FakeRuntimeEnvironment();
    const retries = controlledTimers(100);
    environment.launchMakesReady = false;
    const runtime = connector(environment, {
      startupDeadlineMs: 50,
      reconnectDelayMs: 100,
      schedule: retries.schedule,
    });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));

    await expect(runtime.connectOrStart()).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'startup-timeout',
    });
    for (let retry = 0; retry < 2; retry += 1) {
      await eventually(() => retries.pending(100) === 1);
      retries.releaseNext(100);
      await eventually(() => retries.pending(100) === 1);
    }
    expect(environment.launchCount).toBe(1);

    environment.exitLaunchedProcess();
    environment.launchMakesReady = true;
    retries.releaseNext(100);
    await eventually(() => observed.at(-1)?.state === 'connected');
    expect(environment.launchCount).toBe(2);
  });
}

function registerStartupTests(): void {
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
}

function registerConnectionLifecycleTests(): void {
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
    const reconnects = controlledTimers(25);
    environment.running = true;
    const runtime = connector(environment, { schedule: reconnects.schedule });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));
    await runtime.connectOrStart();

    environment.dropConnections();
    await eventually(() => reconnects.pending() === 1);
    reconnects.releaseNext();
    await eventually(() => observed.at(-1)?.state === 'connected');

    expect(observed.some((state) => state.state === 'unavailable')).toBe(true);
    expect(observed.at(-1)).toMatchObject({
      state: 'connected',
      health: { instanceId: environment.health.instanceId },
    });
    expect(environment.launchCount).toBe(0);
  });
}

function registerPersistentReconnectTest(): void {
  it('keeps retrying automatic reconnects after a transient failed attempt', async () => {
    const environment = new FakeRuntimeEnvironment();
    const delays = controlledTimers(25);
    environment.running = true;
    const runtime = connector(environment, { schedule: delays.schedule });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));
    await runtime.connectOrStart();

    environment.connectionFailure = true;
    environment.dropConnections();
    await eventually(() => delays.pending() === 1);
    delays.releaseNext();
    await eventually(() => {
      const latest = observed.at(-1);
      return (
        latest?.state === 'unavailable' &&
        latest.reason === 'connection-failed' &&
        delays.pending() === 1
      );
    });

    environment.connectionFailure = false;
    delays.releaseNext();
    await eventually(() => observed.at(-1)?.state === 'connected');

    expect(observed.at(-1)).toMatchObject({
      state: 'connected',
      health: { instanceId: environment.health.instanceId },
    });
    expect(environment.launchCount).toBe(0);
  });
}

function registerHealthSupervisionTest(): void {
  it('polls connected health continuously and cancels polling on explicit disconnect', async () => {
    const environment = new FakeRuntimeEnvironment();
    const polls = controlledTimers(10);
    environment.running = true;
    const runtime = connector(environment, {
      healthPollIntervalMs: 10,
      schedule: polls.schedule,
    });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));

    await runtime.connectOrStart();
    expect(environment.healthQueryCount).toBe(1);
    expect(polls.pending()).toBe(1);
    polls.releaseNext();
    await eventually(() => environment.healthQueryCount === 2 && polls.pending() === 1);

    await runtime.disconnect();
    expect(polls.pending()).toBe(0);
    expect(observed.at(-1)).toMatchObject({
      state: 'unavailable',
      reason: 'client-disconnected',
    });
  });
}

function registerHealthFailureSupervisionTest(): void {
  it.each(HEALTH_FAILURE_CASES)(
    'maps $code from polling with its retry policy',
    async (testCase) => {
      const environment = new FakeRuntimeEnvironment();
      const timers = controlledTimers(10, 25);
      environment.running = true;
      const runtime = connector(environment, {
        healthPollIntervalMs: 10,
        schedule: timers.schedule,
      });
      const observed: RuntimeConnectionState[] = [];
      runtime.subscribeStatus((state) => observed.push(state));
      await runtime.connectOrStart();

      environment.healthFailure = true;
      environment.healthFailureCode = testCase.code;
      timers.releaseNext(10);
      await eventually(() => observed.at(-1)?.state === 'unavailable');
      await flushMicrotasks();

      expect(observed.at(-1)).toEqual(testCase.expected);
      expect(timers.pending(25)).toBe(testCase.expected.retryable ? 1 : 0);
    },
  );
}

function registerDelayedReconnectCancellationTest(): void {
  it('cancels a pending automatic retry when Desktop explicitly disconnects', async () => {
    const environment = new FakeRuntimeEnvironment();
    const delays = controlledTimers(25);
    environment.running = true;
    const runtime = connector(environment, { schedule: delays.schedule });
    await runtime.connectOrStart();

    environment.dropConnections();
    await eventually(() => delays.pending() === 1);
    const connectCountBeforeDisconnect = environment.connectCount;
    await runtime.disconnect();
    delays.releaseNext();
    await flushMicrotasks();

    expect(environment.connectCount).toBe(connectCountBeforeDisconnect);
    expect(environment.shutdownCount).toBe(0);
    expect(environment.running).toBe(true);
  });
}

function registerInFlightReconnectCancellationTest(): void {
  it('discards an in-flight reconnect session when Desktop explicitly disconnects', async () => {
    const environment = new FakeRuntimeEnvironment();
    const delays = controlledTimers(25);
    const reconnectEntered = deferred<void>();
    const releaseReconnect = deferred<void>();
    let blockReconnect = false;
    const clients: RuntimeClientPort = {
      connect: async (...args) => {
        if (blockReconnect) {
          reconnectEntered.resolve();
          await releaseReconnect.promise;
        }
        return environment.clients.connect(...args);
      },
    };
    environment.running = true;
    const runtime = connector(environment, { clients, schedule: delays.schedule });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));
    await runtime.connectOrStart();

    blockReconnect = true;
    environment.dropConnections();
    await eventually(() => delays.pending() === 1);
    delays.releaseNext();
    await reconnectEntered.promise;
    await runtime.disconnect();
    releaseReconnect.resolve();
    await flushMicrotasks();

    expect(observed.at(-1)).toEqual({
      state: 'unavailable',
      reason: 'client-disconnected',
      retryable: true,
    });
    expect(environment.activeSessionCount).toBe(0);
    expect(environment.launchCount).toBe(0);
  });
}

function registerReconnectTerminalStateTests(): void {
  it.each(RECONNECT_TERMINAL_CASES)('stops automatic retries after $name', async (testCase) => {
    const environment = new FakeRuntimeEnvironment();
    const delays = controlledTimers(25);
    environment.running = true;
    const runtime = connector(environment, { schedule: delays.schedule });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));
    await runtime.connectOrStart();

    environment.connectionFailure = true;
    environment.dropConnections();
    await eventually(() => delays.pending() === 1);
    delays.releaseNext();
    await eventually(() => observed.at(-1)?.state === 'unavailable' && delays.pending() === 1);

    environment.connectionFailure = false;
    testCase.configure(environment);
    delays.releaseNext();
    await eventually(() => {
      const latest = observed.at(-1);
      return (
        latest?.state === 'incompatible' ||
        (latest?.state === 'unavailable' && latest.reason === 'authentication-rejected')
      );
    });
    await flushMicrotasks();

    expect(observed.at(-1)).toMatchObject(testCase.expected);
    expect(delays.pending()).toBe(0);
    expect(environment.launchCount).toBe(0);
  });
}

function registerInitialRetryTests(): void {
  it('automatically recovers when a Runtime becomes ready after the initial startup timeout', async () => {
    const environment = new FakeRuntimeEnvironment();
    const retries = controlledTimers(100);
    environment.availabilityFailures = 100;
    const runtime = connector(environment, {
      startupDeadlineMs: 50,
      reconnectDelayMs: 100,
      schedule: retries.schedule,
    });
    const observed: RuntimeConnectionState[] = [];
    runtime.subscribeStatus((state) => observed.push(state));

    await expect(runtime.connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: 'startup-timeout',
      retryable: true,
    });
    await eventually(() => retries.pending() === 1);
    environment.availabilityFailures = 0;
    retries.releaseNext();
    await eventually(() => observed.at(-1)?.state === 'connected');

    expect(observed.at(-1)).toMatchObject({
      state: 'connected',
      health: { instanceId: environment.health.instanceId },
    });
    expect(environment.launchCount).toBe(1);
  });
}

function registerInitialRetryTerminalStateTests(): void {
  it.each(RECONNECT_TERMINAL_CASES)(
    'stops initial retry supervision after $name',
    async (testCase) => {
      const environment = new FakeRuntimeEnvironment();
      const retries = controlledTimers(100);
      environment.availabilityFailures = 100;
      const runtime = connector(environment, {
        startupDeadlineMs: 50,
        reconnectDelayMs: 100,
        schedule: retries.schedule,
      });
      const observed: RuntimeConnectionState[] = [];
      runtime.subscribeStatus((state) => observed.push(state));

      await expect(runtime.connectOrStart()).resolves.toMatchObject({
        state: 'unavailable',
        reason: 'startup-timeout',
      });
      await eventually(() => retries.pending() === 1);
      environment.availabilityFailures = 0;
      testCase.configure(environment);
      retries.releaseNext();
      await eventually(() => {
        const latest = observed.at(-1);
        return (
          latest?.state === 'incompatible' ||
          (latest?.state === 'unavailable' && latest.reason === 'authentication-rejected')
        );
      });

      expect(observed.at(-1)).toMatchObject(testCase.expected);
      expect(retries.pending()).toBe(0);
      expect(environment.launchCount).toBe(1);
    },
  );
}

function registerConnectionFailureTests(): void {
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
}

function registerBoundarySecurityTest(): void {
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

function controlledTimers(...acceptedDelayMs: number[]) {
  const tasks: Array<{ milliseconds: number; task: () => void }> = [];
  return {
    schedule: (milliseconds: number, task: () => void) => {
      if (!acceptedDelayMs.includes(milliseconds)) return () => undefined;
      const scheduled = { milliseconds, task };
      tasks.push(scheduled);
      return () => {
        const index = tasks.indexOf(scheduled);
        if (index >= 0) tasks.splice(index, 1);
      };
    },
    pending: (milliseconds?: number) =>
      milliseconds === undefined
        ? tasks.length
        : tasks.filter((task) => task.milliseconds === milliseconds).length,
    releaseNext: (milliseconds?: number) => {
      const index = tasks.findIndex(
        (task) => milliseconds === undefined || task.milliseconds === milliseconds,
      );
      if (index >= 0) tasks.splice(index, 1)[0]?.task();
    },
  };
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await Promise.resolve();
}

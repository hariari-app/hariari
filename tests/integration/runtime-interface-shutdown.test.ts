import { describe, expect, it } from 'vitest';
import {
  createRuntimeConnector,
  type RuntimeConnectorDependencies,
} from '../../src/main/runtime/runtime-connector';
import type {
  RuntimeClientPort,
  RuntimeClientSession,
  RuntimeProcessPort,
} from '../../src/main/runtime/runtime-ports';
import { RuntimePortError } from '../../src/main/runtime/runtime-ports';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

describe('Runtime Interface shutdown ownership', registerShutdownOwnershipTests);

function registerShutdownOwnershipTests(): void {
  it('lets shutdown retain its session while an older health query fails', shutdownOwnsSession);
  it('performs privileged shutdown idempotently without autostart', shutsDownIdempotently);
  it('bounds shutdown while the Runtime endpoint remains live', boundsShutdown);
  it('starts a fresh connection only after the shutdown-owned session settles', reconnectsSafely);
  it('waits for a connector-owned cold-start child to terminate', terminatesColdStart);
  it('evaluates a valid shutdown queued behind a stale request', stopsAfterStaleRequest);
  it('does not report a queued stale request as stopped', rejectsStaleRequestAfterStop);
}

async function stopsAfterStaleRequest(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  const gate = shutdownGate();
  environment.running = true;
  const runtime = connector(environment, {
    clients: orderedShutdownClient(environment.clients, gate),
  });
  await runtime.connectOrStart();
  const stale = runtime.shutdown(shutdownRequest('stale-first', 'stale-runtime'));
  await gate.entered.promise;
  const valid = runtime.shutdown(shutdownRequest('valid-second'));

  await flushMicrotasks();
  expect(gate.expectedInstanceIds).toEqual(['stale-runtime']);
  gate.release.resolve();
  await expect(stale).resolves.toEqual({
    state: 'unavailable',
    reason: 'stale-instance',
    retryable: false,
  });
  await expect(valid).resolves.toEqual({ state: 'stopped', instanceId: 'runtime-1' });
  expect(gate.expectedInstanceIds).toEqual(['stale-runtime', 'runtime-1']);
}

async function rejectsStaleRequestAfterStop(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  const gate = shutdownGate();
  environment.running = true;
  const runtime = connector(environment, {
    clients: orderedShutdownClient(environment.clients, gate),
  });
  await runtime.connectOrStart();
  const valid = runtime.shutdown(shutdownRequest('valid-first'));
  await gate.entered.promise;
  const stale = runtime.shutdown(shutdownRequest('stale-second', 'stale-runtime'));

  await flushMicrotasks();
  expect(gate.expectedInstanceIds).toEqual(['runtime-1']);
  gate.release.resolve();
  await expect(valid).resolves.toEqual({ state: 'stopped', instanceId: 'runtime-1' });
  await expect(stale).resolves.toEqual({ state: 'not-running' });
}

async function reconnectsSafely(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  const shutdownEntered = deferred<void>();
  const releaseShutdown = deferred<void>();
  environment.running = true;
  const runtime = connector(environment, {
    clients: gatedShutdownClient(environment.clients, shutdownEntered, releaseShutdown),
  });
  await runtime.connectOrStart();
  const shutdown = runtime.shutdown(shutdownRequest('shutdown-connect-race'));
  await shutdownEntered.promise;
  let reconnectSettled = false;
  const reconnect = runtime.connectOrStart().then((state) => {
    reconnectSettled = true;
    return state;
  });

  await flushMicrotasks();
  expect(reconnectSettled).toBe(false);
  releaseShutdown.resolve();
  await expect(shutdown).resolves.toMatchObject({ state: 'stopped' });
  await expect(reconnect).resolves.toMatchObject({ state: 'connected' });
  expect(environment.launchCount).toBe(1);
}

async function terminatesColdStart(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  const startupWaiting = deferred<void>();
  const releaseStartupWait = deferred<void>();
  const releaseChildBind = deferred<void>();
  const releaseTermination = deferred<void>();
  let terminationCalls = 0;
  const processes = bindingProcessPort(
    environment,
    releaseChildBind.promise,
    releaseTermination.promise,
    () => void (terminationCalls += 1),
  );
  const runtime = connector(environment, {
    processes,
    delay: async () => {
      startupWaiting.resolve();
      await releaseStartupWait.promise;
    },
  });
  const connect = runtime.connectOrStart();
  await startupWaiting.promise;
  let shutdownSettled = false;
  const shutdown = runtime.shutdown(shutdownRequest('shutdown-cold-start')).then((result) => {
    shutdownSettled = true;
    return result;
  });

  await flushMicrotasks();
  expect(shutdownSettled).toBe(false);
  releaseStartupWait.resolve();
  await eventually(() => terminationCalls === 1);
  expect(shutdownSettled).toBe(false);
  releaseChildBind.resolve();
  await eventually(() => environment.running);
  releaseTermination.resolve();
  await expect(shutdown).resolves.toEqual({ state: 'not-running' });
  expect(environment.running).toBe(false);
  await connect;
}

async function shutdownOwnsSession(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  const healthEntered = deferred<void>();
  const releaseHealth = deferred<void>();
  let blockHealth = false;
  environment.running = true;
  const runtime = connector(environment, {
    clients: serialHealthClient(environment.clients, async () => {
      if (!blockHealth) return;
      healthEntered.resolve();
      await releaseHealth.promise;
      throw new RuntimePortError('timeout');
    }),
  });
  await runtime.connectOrStart();
  blockHealth = true;
  const staleHealth = runtime.queryHealth();
  await healthEntered.promise;
  const shutdown = runtime.shutdown(shutdownRequest('shutdown-health-race'));
  releaseHealth.resolve();

  await staleHealth;
  await expect(shutdown).resolves.toMatchObject({ state: 'stopped' });
  expect(environment.shutdownCount).toBe(1);
}

async function shutsDownIdempotently(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  environment.running = true;
  const runtime = connector(environment);
  await runtime.connectOrStart();
  const request = shutdownRequest('shutdown-1');

  await expect(runtime.shutdown(request)).resolves.toEqual({
    state: 'stopped',
    instanceId: environment.health.instanceId,
  });
  await expect(runtime.shutdown(request)).resolves.toEqual({ state: 'not-running' });
  expect(environment.shutdownCount).toBe(1);
  expect(environment.launchCount).toBe(0);
}

async function boundsShutdown(): Promise<void> {
  const environment = new FakeRuntimeEnvironment();
  environment.running = true;
  environment.shutdownLeavesRunning = true;
  const runtime = connector(environment, { connectDeadlineMs: 50 });
  await runtime.connectOrStart();

  await expect(runtime.shutdown(shutdownRequest('shutdown-stalled'))).resolves.toEqual({
    state: 'unavailable',
    reason: 'health-timeout',
    retryable: true,
  });
  expect(environment.shutdownCount).toBe(1);
  expect(environment.running).toBe(true);
}

function serialHealthClient(
  client: RuntimeClientPort,
  beforeHealth: () => Promise<void>,
): RuntimeClientPort {
  return {
    connect: async (...args) => {
      const connection = await client.connect(...args);
      if (connection.kind !== 'connected') return connection;
      return { kind: 'connected', session: serialSession(connection.session, beforeHealth) };
    },
  };
}

function serialSession(
  session: RuntimeClientSession,
  beforeHealth: () => Promise<void>,
): RuntimeClientSession {
  let requestQueue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = requestQueue.then(operation);
    requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    queryHealth: (deadlineMs) =>
      enqueue(async () => {
        await beforeHealth();
        return session.queryHealth(deadlineMs);
      }),
    shutdown: (request, deadlineMs) => enqueue(() => session.shutdown(request, deadlineMs)),
    createTask: (request, deadlineMs) => enqueue(() => session.createTask(request, deadlineMs)),
    listTasks: (deadlineMs) => enqueue(() => session.listTasks(deadlineMs)),
    startTask: (request, deadlineMs) => enqueue(() => session.startTask(request, deadlineMs)),
    resumeProviderSession: (request, deadlineMs) =>
      enqueue(() => session.resumeProviderSession(request, deadlineMs)),
    forkProviderSession: (request, deadlineMs) =>
      enqueue(() => session.forkProviderSession(request, deadlineMs)),
    reconcileTask: (request, deadlineMs) =>
      enqueue(() => session.reconcileTask(request, deadlineMs)),
    recoverTask: (request, deadlineMs) =>
      enqueue(() => session.recoverTask(request, deadlineMs)),
    cancelTask: (request, deadlineMs) => enqueue(() => session.cancelTask(request, deadlineMs)),
    getTaskExecution: (taskId, deadlineMs) =>
      enqueue(() => session.getTaskExecution(taskId, deadlineMs)),
    getTaskTimeline: (taskId, deadlineMs) =>
      enqueue(() => session.getTaskTimeline(taskId, deadlineMs)),
    subscribeTaskOutput: (taskId, listener, deadlineMs) =>
      session.subscribeTaskOutput(taskId, listener, deadlineMs),
    disconnect: () => session.disconnect(),
    onDisconnect: (listener) => session.onDisconnect(listener),
  };
}

function gatedShutdownClient(
  client: RuntimeClientPort,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): RuntimeClientPort {
  return {
    connect: async (...args) => {
      const connection = await client.connect(...args);
      if (connection.kind !== 'connected') return connection;
      return {
        kind: 'connected',
        session: gatedShutdownSession(connection.session, entered, release),
      };
    },
  };
}

interface ShutdownGate {
  readonly entered: ReturnType<typeof deferred<void>>;
  readonly release: ReturnType<typeof deferred<void>>;
  readonly expectedInstanceIds: string[];
}

function shutdownGate(): ShutdownGate {
  return { entered: deferred<void>(), release: deferred<void>(), expectedInstanceIds: [] };
}

function orderedShutdownClient(client: RuntimeClientPort, gate: ShutdownGate): RuntimeClientPort {
  return {
    connect: async (...args) => {
      const connection = await client.connect(...args);
      if (connection.kind !== 'connected') return connection;
      let shutdownCount = 0;
      return {
        kind: 'connected',
        session: {
          queryHealth: (deadlineMs) => connection.session.queryHealth(deadlineMs),
          shutdown: async (request, deadlineMs) => {
            gate.expectedInstanceIds.push(request.expectedInstanceId);
            shutdownCount += 1;
            if (shutdownCount === 1) {
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (request.expectedInstanceId !== 'runtime-1') {
              throw new RuntimePortError('stale-instance');
            }
            return connection.session.shutdown(request, deadlineMs);
          },
          createTask: (request, deadlineMs) => connection.session.createTask(request, deadlineMs),
          listTasks: (deadlineMs) => connection.session.listTasks(deadlineMs),
          startTask: (request, deadlineMs) => connection.session.startTask(request, deadlineMs),
          resumeProviderSession: (request, deadlineMs) =>
            connection.session.resumeProviderSession(request, deadlineMs),
          forkProviderSession: (request, deadlineMs) =>
            connection.session.forkProviderSession(request, deadlineMs),
          reconcileTask: (request, deadlineMs) =>
            connection.session.reconcileTask(request, deadlineMs),
          recoverTask: (request, deadlineMs) =>
            connection.session.recoverTask(request, deadlineMs),
          cancelTask: (request, deadlineMs) => connection.session.cancelTask(request, deadlineMs),
          getTaskExecution: (taskId, deadlineMs) =>
            connection.session.getTaskExecution(taskId, deadlineMs),
          getTaskTimeline: (taskId, deadlineMs) =>
            connection.session.getTaskTimeline(taskId, deadlineMs),
          subscribeTaskOutput: (taskId, listener, deadlineMs) =>
            connection.session.subscribeTaskOutput(taskId, listener, deadlineMs),
          disconnect: () => connection.session.disconnect(),
          onDisconnect: (listener) => connection.session.onDisconnect(listener),
        },
      };
    },
  };
}

function gatedShutdownSession(
  session: RuntimeClientSession,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): RuntimeClientSession {
  return {
    queryHealth: (deadlineMs) => session.queryHealth(deadlineMs),
    shutdown: async (request, deadlineMs) => {
      entered.resolve();
      await release.promise;
      return session.shutdown(request, deadlineMs);
    },
    createTask: (request, deadlineMs) => session.createTask(request, deadlineMs),
    listTasks: (deadlineMs) => session.listTasks(deadlineMs),
    startTask: (request, deadlineMs) => session.startTask(request, deadlineMs),
    resumeProviderSession: (request, deadlineMs) =>
      session.resumeProviderSession(request, deadlineMs),
    forkProviderSession: (request, deadlineMs) =>
      session.forkProviderSession(request, deadlineMs),
    reconcileTask: (request, deadlineMs) => session.reconcileTask(request, deadlineMs),
    recoverTask: (request, deadlineMs) => session.recoverTask(request, deadlineMs),
    cancelTask: (request, deadlineMs) => session.cancelTask(request, deadlineMs),
    getTaskExecution: (taskId, deadlineMs) => session.getTaskExecution(taskId, deadlineMs),
    getTaskTimeline: (taskId, deadlineMs) => session.getTaskTimeline(taskId, deadlineMs),
    subscribeTaskOutput: (taskId, listener, deadlineMs) =>
      session.subscribeTaskOutput(taskId, listener, deadlineMs),
    disconnect: () => session.disconnect(),
    onDisconnect: (listener) => session.onDisconnect(listener),
  };
}

function bindingProcessPort(
  environment: FakeRuntimeEnvironment,
  bind: Promise<void>,
  allowTermination: Promise<void>,
  recordTermination: () => void,
): RuntimeProcessPort {
  return {
    start: async () => {
      let terminated = false;
      const childSettled = deferred<void>();
      void bind.then(() => {
        if (!terminated) environment.running = true;
      });
      return {
        terminate: async () => {
          recordTermination();
          await allowTermination;
          terminated = true;
          environment.running = false;
          childSettled.resolve();
        },
        settled: () => childSettled.promise,
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

function shutdownRequest(idempotencyKey: string, expectedInstanceId = 'runtime-1') {
  return {
    idempotencyKey,
    expectedInstanceId,
    reason: 'test' as const,
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

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not met');
}

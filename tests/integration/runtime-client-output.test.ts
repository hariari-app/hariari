import { describe, expect, it } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import type { RuntimeClientConnectOptions } from '../../src/main/runtime/runtime-ports';
import type { TaskOutputEvent } from '../../src/shared/runtime/runtime-interface';
import {
  RuntimeTransportError,
  type RuntimeFrameConnection,
  type RuntimeLocalEndpoint,
  type RuntimeLocalTransport,
} from '../../src/runtime/local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  createServerProof,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeReplyWithoutProof,
  type RuntimeRequestFrame,
} from '../../src/runtime/protocol';

const TOKEN = new Uint8Array(32).fill(7);
const SUBSCRIPTION_DEADLINE_MS = 10;
const CONNECT_OPTIONS: RuntimeClientConnectOptions = {
  clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
  supportedProtocolRange: { min: 1, max: 1 },
  deadlineMs: 100,
};
const OUTPUT_EVENT: TaskOutputEvent = {
  kind: 'data',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  sequence: 1,
  data: 'slow-start output',
};
const TERMINAL_STREAM_FAILURES = [
  { name: 'closed transport', failure: 'closed' },
  { name: 'transport protocol failure', failure: 'protocol' },
  { name: 'malformed output frame', failure: 'malformed-frame' },
] as const;

type OutputScript = 'deadline-then-output' | (typeof TERMINAL_STREAM_FAILURES)[number]['failure'];

describe('Runtime client output subscriptions', registerOutputSubscriptionTests);

function registerOutputSubscriptionTests(): void {
  it(
    'survives an idle read deadline before slow-start output and cleans up on unsubscribe',
    survivesIdleDeadline,
  );
  it.each(TERMINAL_STREAM_FAILURES)('closes on $name', closesOnTerminalStreamFailure);
}

async function survivesIdleDeadline(): Promise<void> {
  const transport = new OutputTransport();
  const connection = await connectClient(transport);
  const observed = deferred<TaskOutputEvent>();
  const unsubscribe = await connection.session.subscribeTaskOutput(
    'task-1',
    observed.resolve,
    SUBSCRIPTION_DEADLINE_MS,
  );
  const event = await withTimeout(observed.promise, 250);
  const outputConnection = transport.outputConnection();

  expect(event).toEqual(OUTPUT_EVENT);
  expect(transport.connectDeadlines).toEqual([
    CONNECT_OPTIONS.deadlineMs,
    SUBSCRIPTION_DEADLINE_MS,
  ]);
  expect(outputConnection.readDeadlines.slice(0, 3)).toEqual([
    CONNECT_OPTIONS.deadlineMs,
    CONNECT_OPTIONS.deadlineMs,
    SUBSCRIPTION_DEADLINE_MS,
  ]);
  expect(outputConnection.writeDeadlines).toEqual([
    CONNECT_OPTIONS.deadlineMs,
    SUBSCRIPTION_DEADLINE_MS,
  ]);
  expect(outputConnection.outputReadDeadlines.slice(0, 2)).toEqual([
    SUBSCRIPTION_DEADLINE_MS,
    SUBSCRIPTION_DEADLINE_MS,
  ]);
  expect(outputConnection.closeCalls).toBe(0);
  unsubscribe();
  unsubscribe();
  expect(outputConnection.closeCalls).toBe(1);
  await connection.session.disconnect();
}

async function closesOnTerminalStreamFailure({
  failure,
}: (typeof TERMINAL_STREAM_FAILURES)[number]): Promise<void> {
  const transport = new OutputTransport(failure);
  const connection = await connectClient(transport);
  const unsubscribe = await connection.session.subscribeTaskOutput(
    'task-1',
    () => undefined,
    SUBSCRIPTION_DEADLINE_MS,
  );
  const outputConnection = transport.outputConnection();
  await withTimeout(outputConnection.whenClosed(), 100);

  expect(outputConnection.closeCalls).toBe(1);
  unsubscribe();
  expect(outputConnection.closeCalls).toBe(1);
  await connection.session.disconnect();
}

async function connectClient(transport: OutputTransport) {
  const client = new NodeRuntimeClient({
    transport,
    randomId: () => 'client-request',
    randomNonce: () => 'client-nonce',
  });
  const connection = await client.connect(endpoint(), TOKEN, CONNECT_OPTIONS);
  if (connection.kind !== 'connected') throw new Error('expected connection');
  return connection;
}

class OutputTransport implements RuntimeLocalTransport {
  readonly connectDeadlines: number[] = [];
  private readonly connections: OutputConnection[] = [];

  constructor(private readonly outputScript: OutputScript = 'deadline-then-output') {}

  async connect(
    _endpoint: RuntimeLocalEndpoint,
    deadlineMs: number,
  ): Promise<RuntimeFrameConnection> {
    this.connectDeadlines.push(deadlineMs);
    const connection = new OutputConnection(
      this.connections.length === 1 ? this.outputScript : null,
    );
    this.connections.push(connection);
    return connection;
  }

  async listen(): Promise<never> {
    throw new Error('not used');
  }

  outputConnection(): OutputConnection {
    const connection = this.connections[1];
    if (!connection) throw new Error('output connection was not opened');
    return connection;
  }
}

class OutputConnection implements RuntimeFrameConnection {
  readonly readDeadlines: number[] = [];
  readonly writeDeadlines: number[] = [];
  readonly outputReadDeadlines: number[] = [];
  closeCalls = 0;
  private readonly closed = deferred<void>();
  private reads = 0;
  private authenticate: RuntimeAuthenticateFrame | null = null;
  private request: RuntimeRequestFrame | null = null;

  constructor(private readonly outputScript: OutputScript | null) {}

  async readFrame(deadlineMs: number): Promise<Record<string, unknown>> {
    this.readDeadlines.push(deadlineMs);
    this.reads += 1;
    if (this.reads === 1) return { ...challenge() };
    if (this.reads === 2) return this.handshakeReply();
    if (!this.outputScript) throw new RuntimeTransportError('protocol');
    if (this.reads === 3) return this.subscriptionReply();
    this.outputReadDeadlines.push(deadlineMs);
    if (this.outputScript === 'malformed-frame') return { kind: 'invalid' };
    if (this.outputScript !== 'deadline-then-output') {
      throw new RuntimeTransportError(this.outputScript);
    }
    if (this.outputReadDeadlines.length === 1) {
      await wait(deadlineMs + 1);
      throw new RuntimeTransportError('deadline');
    }
    if (this.outputReadDeadlines.length === 2) {
      return { kind: 'runtime.output', protocolVersion: 1, taskId: 'task-1', event: OUTPUT_EVENT };
    }
    await this.closed.promise;
    throw new RuntimeTransportError('closed');
  }

  async writeFrame(frame: Record<string, unknown>, deadlineMs: number): Promise<void> {
    this.writeDeadlines.push(deadlineMs);
    if (frame.kind === 'runtime.authenticate') {
      this.authenticate = frame as unknown as RuntimeAuthenticateFrame;
      return;
    }
    this.request = frame as unknown as RuntimeRequestFrame;
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed.resolve(undefined);
  }

  whenClosed(): Promise<void> {
    return this.closed.promise;
  }

  private handshakeReply(): Record<string, unknown> {
    if (!this.authenticate) throw new Error('authenticate frame was not written');
    const reply: RuntimeReplyWithoutProof = {
      kind: 'runtime.welcome',
      handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: challenge().challengeId,
      requestId: this.authenticate.requestId,
      serverNonce: challenge().serverNonce,
      clientNonce: this.authenticate.clientNonce,
      runtimeRange: { min: 1, max: 1 },
      sessionId: 'runtime-session',
      selectedProtocolVersion: 1,
      runtime: {
        instanceId: 'runtime-instance',
        runtimeVersion: '0.6.8',
        buildId: 'build-21',
        startedAt: '2026-08-21T10:00:00.000Z',
      },
    };
    return { ...reply, proof: createServerProof(TOKEN, reply) };
  }

  private subscriptionReply(): Record<string, unknown> {
    if (!this.request) throw new Error('subscription request was not written');
    return {
      kind: 'runtime.response',
      protocolVersion: this.request.protocolVersion,
      requestId: this.request.requestId,
      operation: this.request.operation,
      correlationId: this.request.correlationId,
      ok: true,
      result: { subscribed: true },
    };
  }
}

function challenge(): RuntimeChallengeFrame {
  return {
    kind: 'runtime.challenge',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: 'runtime-challenge',
    serverNonce: 'runtime-nonce',
    expiresAt: '2026-08-21T10:00:30.000Z',
  };
}

function endpoint() {
  return {
    kind: 'unix' as const,
    address: '/tmp/runtime-output.sock',
    runtimeDirectory: '/tmp',
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('output was not delivered')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

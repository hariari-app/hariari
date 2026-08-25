import { describe, expect, it } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import { createRuntimeConnector } from '../../src/main/runtime/runtime-connector';
import {
  RuntimePortError,
  type RuntimeClientConnectOptions,
} from '../../src/main/runtime/runtime-ports';
import {
  RuntimeTransportError,
  type RuntimeFrameConnection,
  type RuntimeLocalTransport,
} from '../../src/runtime/local-transport';
import {
  RUNTIME_HANDSHAKE_VERSION,
  createServerProof,
  type RuntimeAuthenticateFrame,
  type RuntimeChallengeFrame,
  type RuntimeProtocolErrorFrame,
  type RuntimeReplyWithoutProof,
  type RuntimeRequestFrame,
} from '../../src/runtime/protocol';
import { FakeRuntimeEnvironment } from './runtime-test-fakes';

const TOKEN = new Uint8Array(32).fill(7);
const CONNECT_OPTIONS: RuntimeClientConnectOptions = {
  clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
  supportedProtocolRange: { min: 1, max: 1 },
  deadlineMs: 100,
};

type HandshakeStage = 'challenge-read' | 'authenticate-write' | 'reply-read';

const TRANSPORT_FAILURES = (['deadline', 'closed'] as const).flatMap((code) =>
  (['challenge-read', 'authenticate-write', 'reply-read'] as const).map((stage) => ({
    name: `${code} at ${stage}`,
    code,
    stage,
    expectedPortCode: code === 'deadline' ? ('timeout' as const) : ('transport-lost' as const),
    expectedState:
      code === 'deadline'
        ? { state: 'unavailable' as const, reason: 'health-timeout' as const, retryable: true }
        : { state: 'unavailable' as const, reason: 'transport-lost' as const, retryable: true },
  })),
);

const TERMINAL_FAILURES = [
  { name: 'malformed challenge', script: { malformedChallenge: true }, code: 'protocol-error' },
  { name: 'malformed reply', script: { reply: 'malformed' }, code: 'protocol-error' },
  { name: 'invalid server proof', script: { reply: 'invalid-proof' }, code: 'protocol-error' },
  {
    name: 'invalid selected version',
    script: { reply: 'invalid-version' },
    code: 'protocol-error',
  },
  {
    name: 'authentication rejection',
    script: { reply: 'unauthorized' },
    code: 'authentication-rejected',
  },
] as const;

const OPERATION_FAILURES: ReadonlyArray<RuntimeProtocolErrorFrame> = [
  { code: 'invalid-request', retryable: false },
  { code: 'unsupported-operation', retryable: false },
  { code: 'stale-instance', retryable: false },
  { code: 'idempotency-conflict', retryable: false },
  { code: 'runtime-stopping', retryable: true },
  { code: 'internal', retryable: true },
];

describe('Runtime client handshake failures', registerRuntimeClientFailureTests);

it('allows worktree allocation the task-start deadline at the client seam', async () => {
  const transport = new HandshakeTransport({});
  const client = new NodeRuntimeClient({
    transport,
    randomId: () => 'client-request',
    randomNonce: () => 'client-nonce',
  });
  const connection = await client.connect(endpoint(), TOKEN, CONNECT_OPTIONS);
  if (connection.kind !== 'connected') throw new Error('expected connection');

  await expect(connection.session.startTask(startRequest())).resolves.toMatchObject({
    task: { id: 'task-1', executionState: 'running' },
    attempt: { state: 'running' },
  });

  expect(transport.operationDeadlines).toEqual([10_000, 10_000]);
});

it('allows worktree allocation the task-start deadline through RuntimeInterface', async () => {
  const environment = new FakeRuntimeEnvironment();
  const transport = new HandshakeTransport({});
  const runtime = runtimeInterface(
    environment,
    new NodeRuntimeClient({
      transport,
      randomId: () => 'client-request',
      randomNonce: () => 'client-nonce',
    }),
    2_000,
  );

  await expect(runtime.startTask(startRequest())).resolves.toMatchObject({
    task: { id: 'task-1', executionState: 'running' },
    attempt: { state: 'running' },
  });

  expect(transport.operationDeadlines).toEqual([2_000, 2_000, 10_000, 10_000]);
});

function registerRuntimeClientFailureTests(): void {
  registerHandshakeTransportFailures();
  registerTerminalHandshakeFailures();
  registerOperationResponseFailures();
  registerShutdownResponseFailures();
}

function registerHandshakeTransportFailures(): void {
  it.each(TRANSPORT_FAILURES)('preserves transport $name at the client seam', async (testCase) => {
    const client = handshakeClient({ failure: { stage: testCase.stage, code: testCase.code } });

    await expect(client.connect(endpoint(), TOKEN, CONNECT_OPTIONS)).rejects.toEqual(
      new RuntimePortError(testCase.expectedPortCode),
    );
  });

  it.each(TRANSPORT_FAILURES)('preserves transport $name at the public seam', async (testCase) => {
    const environment = new FakeRuntimeEnvironment();
    const clients = handshakeClient({ failure: { stage: testCase.stage, code: testCase.code } });

    await expect(runtimeInterface(environment, clients).connectOrStart()).resolves.toEqual(
      testCase.expectedState,
    );
  });
}

function registerTerminalHandshakeFailures(): void {
  it.each(TERMINAL_FAILURES)('keeps $name terminal at the client seam', async (testCase) => {
    await expect(
      handshakeClient(testCase.script).connect(endpoint(), TOKEN, CONNECT_OPTIONS),
    ).rejects.toMatchObject({ code: testCase.code });
  });

  it.each(TERMINAL_FAILURES)('keeps $name terminal at the public seam', async (testCase) => {
    const environment = new FakeRuntimeEnvironment();
    const runtime = runtimeInterface(environment, handshakeClient(testCase.script));

    await expect(runtime.connectOrStart()).resolves.toEqual({
      state: 'unavailable',
      reason: testCase.code,
      retryable: false,
    });
  });
}

function registerOperationResponseFailures(): void {
  it.each(OPERATION_FAILURES)(
    'preserves $code response semantics at the client seam',
    async (error) => {
      const connection = await handshakeClient({ operationError: error }).connect(
        endpoint(),
        TOKEN,
        CONNECT_OPTIONS,
      );
      if (connection.kind !== 'connected') throw new Error('expected connection');

      await expect(connection.session.queryHealth()).rejects.toMatchObject(error);
    },
  );

  it.each(OPERATION_FAILURES)(
    'preserves $code response semantics at the public seam',
    async (error) => {
      const environment = new FakeRuntimeEnvironment();
      const runtime = runtimeInterface(environment, handshakeClient({ operationError: error }));

      await expect(runtime.connectOrStart()).resolves.toEqual({
        state: 'unavailable',
        reason: error.code,
        retryable: error.retryable,
      });
    },
  );
}

function registerShutdownResponseFailures(): void {
  it.each(OPERATION_FAILURES)('preserves $code from shutdown at the client seam', async (error) => {
    const connection = await handshakeClient({ shutdownError: error }).connect(
      endpoint(),
      TOKEN,
      CONNECT_OPTIONS,
    );
    if (connection.kind !== 'connected') throw new Error('expected connection');

    await expect(connection.session.shutdown(shutdownRequest())).rejects.toMatchObject(error);
  });

  it.each(OPERATION_FAILURES)('preserves $code from shutdown at the public seam', async (error) => {
    const environment = new FakeRuntimeEnvironment();
    const runtime = runtimeInterface(environment, handshakeClient({ shutdownError: error }));
    await runtime.connectOrStart();

    await expect(runtime.shutdown(shutdownRequest())).resolves.toEqual({
      state: 'unavailable',
      reason: error.code,
      retryable: error.retryable,
    });
  });
}

interface HandshakeFailure {
  readonly stage: HandshakeStage;
  readonly code: 'deadline' | 'closed';
}

interface HandshakeScript {
  readonly failure?: HandshakeFailure;
  readonly malformedChallenge?: boolean;
  readonly reply?: 'malformed' | 'invalid-proof' | 'invalid-version' | 'unauthorized';
  readonly operationError?: RuntimeProtocolErrorFrame;
  readonly shutdownError?: RuntimeProtocolErrorFrame;
}

function handshakeClient(script: HandshakeScript): NodeRuntimeClient {
  return new NodeRuntimeClient({
    transport: new HandshakeTransport(script),
    randomId: () => 'client-request',
    randomNonce: () => 'client-nonce',
  });
}

function runtimeInterface(
  environment: FakeRuntimeEnvironment,
  clients: NodeRuntimeClient,
  connectDeadlineMs = CONNECT_OPTIONS.deadlineMs,
) {
  return createRuntimeConnector({
    clients,
    endpoints: environment.endpoints,
    tokens: environment.tokens,
    processes: environment.processes,
    leases: environment.leases,
    artifacts: environment.artifacts,
    clientIdentity: CONNECT_OPTIONS.clientIdentity,
    supportedProtocolRange: CONNECT_OPTIONS.supportedProtocolRange,
    connectDeadlineMs,
    startupDeadlineMs: 100,
    reconnectDelayMs: 25,
    healthPollIntervalMs: 10_000,
    schedule: () => () => undefined,
    now: environment.now,
    delay: environment.delay,
  });
}

class HandshakeTransport implements RuntimeLocalTransport {
  readonly operationDeadlines: number[] = [];

  constructor(private readonly script: HandshakeScript) {}

  async connect(): Promise<RuntimeFrameConnection> {
    return new HandshakeConnection(this.script, this.operationDeadlines);
  }

  async listen(): Promise<never> {
    throw new Error('not used');
  }
}

class HandshakeConnection implements RuntimeFrameConnection {
  private reads = 0;
  private authenticate: RuntimeAuthenticateFrame | null = null;
  private request: RuntimeRequestFrame | null = null;

  constructor(
    private readonly script: HandshakeScript,
    private readonly operationDeadlines: number[] = [],
  ) {}

  async readFrame(deadlineMs: number): Promise<Record<string, unknown>> {
    this.reads += 1;
    const stage = this.reads === 1 ? 'challenge-read' : 'reply-read';
    if (this.script.failure?.stage === stage) {
      throw new RuntimeTransportError(this.script.failure.code);
    }
    if (this.reads === 1) {
      return this.script.malformedChallenge ? { kind: 'invalid' } : { ...challenge() };
    }
    if (this.reads > 2) this.operationDeadlines.push(deadlineMs);
    return this.reads === 2 ? this.handshakeReply() : this.operationReply();
  }

  async writeFrame(frame: Record<string, unknown>, deadlineMs: number): Promise<void> {
    if (this.script.failure?.stage === 'authenticate-write') {
      throw new RuntimeTransportError(this.script.failure.code);
    }
    if (frame.kind === 'runtime.authenticate') {
      this.authenticate = frame as unknown as RuntimeAuthenticateFrame;
      return;
    }
    this.request = frame as unknown as RuntimeRequestFrame;
    this.operationDeadlines.push(deadlineMs);
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): void {}

  private handshakeReply(): Record<string, unknown> {
    if (this.script.reply === 'malformed') return { kind: 'invalid' };
    if (this.script.reply === 'unauthorized') {
      return { kind: 'runtime.unauthorized', handshakeVersion: RUNTIME_HANDSHAKE_VERSION };
    }
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
      selectedProtocolVersion: this.script.reply === 'invalid-version' ? 2 : 1,
      runtime: {
        instanceId: 'runtime-instance',
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
        startedAt: '2026-08-20T10:00:00.000Z',
      },
    };
    return {
      ...reply,
      proof:
        this.script.reply === 'invalid-proof' ? 'invalid-proof' : createServerProof(TOKEN, reply),
    };
  }

  private operationReply(): Record<string, unknown> {
    if (!this.request) throw new Error('operation was not scripted');
    const error =
      this.script.operationError ??
      (this.request.operation.name === 'runtime.shutdown' ? this.script.shutdownError : undefined);
    if (!error) return this.healthReply();
    return {
      kind: 'runtime.response',
      protocolVersion: this.request.protocolVersion,
      requestId: this.request.requestId,
      operation: this.request.operation,
      correlationId: this.request.correlationId,
      ok: false,
      error,
    };
  }

  private healthReply(): Record<string, unknown> {
    if (!this.request) throw new Error('successful operation was not scripted');
    if (this.request.operation.name === 'task.start') return this.taskStartReply();
    if (this.request.operation.name !== 'runtime.health') {
      throw new Error('successful operation was not scripted');
    }
    return {
      kind: 'runtime.response',
      protocolVersion: this.request.protocolVersion,
      requestId: this.request.requestId,
      operation: this.request.operation,
      correlationId: this.request.correlationId,
      ok: true,
      result: {
        status: 'ready',
        instanceId: 'runtime-instance',
        runtimeVersion: '0.6.8',
        buildId: 'build-19',
        protocolVersion: 1,
        startedAt: '2026-08-20T10:00:00.000Z',
        checkedAt: '2026-08-20T10:00:01.000Z',
      },
    };
  }

  private taskStartReply(): Record<string, unknown> {
    if (!this.request) throw new Error('task start was not scripted');
    return {
      kind: 'runtime.response',
      protocolVersion: this.request.protocolVersion,
      requestId: this.request.requestId,
      operation: this.request.operation,
      correlationId: this.request.correlationId,
      ok: true,
      result: {
        task: {
          id: 'task-1',
          objective: 'Allocate a task worktree.',
          project: 'Hariari',
          repository: '/tmp/repository',
          baseRef: 'HEAD',
          provider: 'shell',
          createdAt: '2026-08-21T10:00:00.000Z',
          executionState: 'running',
        },
        run: { id: 'run-1', number: 1 },
        attempt: { id: 'attempt-1', number: 1, state: 'running' },
        attempts: [{ id: 'attempt-1', number: 1, state: 'running' }],
        context: {
          id: 'context-1',
          worktreeId: 'worktree-1',
          branchName: 'hariari/task-task-1/run-1/attempt-1',
          baseCommit: 'base-1',
        },
        executionContexts: [
          {
            id: 'context-1',
            worktreeId: 'worktree-1',
            branchName: 'hariari/task-task-1/run-1/attempt-1',
            baseCommit: 'base-1',
          },
        ],
        providerSessions: [],
      },
    };
  }
}

function challenge(): RuntimeChallengeFrame {
  return {
    kind: 'runtime.challenge',
    handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
    challengeId: 'runtime-challenge',
    serverNonce: 'runtime-nonce',
    expiresAt: '2026-08-20T10:00:30.000Z',
  };
}

function endpoint() {
  return {
    kind: 'unix' as const,
    address: '/tmp/runtime-handshake.sock',
    runtimeDirectory: '/tmp',
  };
}

function shutdownRequest() {
  return {
    idempotencyKey: 'semantic-shutdown',
    expectedInstanceId: 'runtime-instance',
    reason: 'test' as const,
  };
}

function startRequest() {
  return { taskId: 'task-1', idempotencyKey: 'worktree-allocation' };
}

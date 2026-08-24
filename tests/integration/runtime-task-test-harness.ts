import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type { GenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';
import type { RuntimeLocalEndpoint } from '../../src/runtime/local-transport';
import {
  CLAUDE_RESUME_OPERATION,
  CLAUDE_FORK_OPERATION,
  RUNTIME_HANDSHAKE_VERSION,
  RUNTIME_OPERATION_VERSION,
  createClientProof,
  type RuntimeAuthenticateFrame,
  type RuntimeResponseFrame,
} from '../../src/runtime/protocol';
import {
  parseChallengeFrame,
  parseResponseFrame,
} from '../../src/runtime/protocol-validation';
import { RuntimeServer } from '../../src/runtime/runtime-server';
import { createDisposableGitRepository } from '../test-common/disposable-git-repository';
import { ObservedRuntimeTransport } from './runtime-test-fakes';

const roots: string[] = [];
const servers: RuntimeServer[] = [];

export const FAILED_APPEND_MODES = [
  'zero-first',
  'partial-then-zero',
  'partial-then-error',
] as const;

export interface RuntimeSubject {
  readonly runtimeDirectory: string;
  readonly transport: ObservedRuntimeTransport;
  connect(): Promise<RuntimeClientSession>;
  restart(): Promise<void>;
  legacyClaudeResume(payload: Record<string, unknown>, idempotencyKey: string):
    Promise<RuntimeResponseFrame>;
  legacyClaudeFork(payload: Record<string, unknown>, idempotencyKey: string):
    Promise<RuntimeResponseFrame>;
}

export function registerRuntimeTaskTestCleanup(): void {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
}

export async function createSubject(
  adapterFactory: (runtimeDirectory: string) => GenericCliExecutionAdapter,
): Promise<RuntimeSubject> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-start-remediation-'));
  roots.push(root);
  const runtimeDirectory = path.join(root, 'runtime');
  const endpoint = runtimeEndpoint(root, runtimeDirectory);
  const token = new Uint8Array(32).fill(47);
  const transport = new ObservedRuntimeTransport();
  let id = 0;
  const randomId = (): string => `start-remediation-${++id}-${randomUUID()}`;
  const adapter = adapterFactory(runtimeDirectory);
  let server = serverFor(endpoint, token, transport, randomId, adapter);
  servers.push(server);
  await server.start();
  const legacy = (operation: typeof CLAUDE_RESUME_OPERATION | typeof CLAUDE_FORK_OPERATION) =>
    (payload: Record<string, unknown>, idempotencyKey: string) => legacyClaudeRequest(
      endpoint, token, transport, randomId, operation, payload, idempotencyKey,
    );
  return runtimeSubject(runtimeDirectory, transport, connectSubject, restartSubject,
    legacy(CLAUDE_RESUME_OPERATION), legacy(CLAUDE_FORK_OPERATION));

  function connectSubject(): Promise<RuntimeClientSession> {
    return connect(endpoint, token, transport, randomId);
  }

  async function restartSubject(): Promise<void> {
    await server.stop();
    server = serverFor(endpoint, token, transport, randomId, adapter);
    servers.push(server);
    await server.start();
  }
}

function runtimeEndpoint(root: string, runtimeDirectory: string): RuntimeLocalEndpoint {
  return { kind: 'unix', address: path.join(root, 'runtime.sock'), runtimeDirectory };
}

function runtimeSubject(
  runtimeDirectory: string,
  transport: ObservedRuntimeTransport,
  connect: () => Promise<RuntimeClientSession>,
  restart: () => Promise<void>,
  legacyClaudeResume: RuntimeSubject['legacyClaudeResume'],
  legacyClaudeFork: RuntimeSubject['legacyClaudeFork'],
): RuntimeSubject {
  return { runtimeDirectory, transport, connect, restart,
    legacyClaudeResume, legacyClaudeFork };
}

async function legacyClaudeRequest(
  endpoint: RuntimeLocalEndpoint,
  token: Uint8Array,
  transport: ObservedRuntimeTransport,
  randomId: () => string,
  operation: typeof CLAUDE_RESUME_OPERATION | typeof CLAUDE_FORK_OPERATION,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<RuntimeResponseFrame> {
  const connection = await transport.connect(endpoint, 500);
  try {
    const challenge = parseChallengeFrame(await connection.readFrame(500));
    const authentication: Omit<RuntimeAuthenticateFrame, 'proof'> = {
      kind: 'runtime.authenticate', handshakeVersion: RUNTIME_HANDSHAKE_VERSION,
      challengeId: challenge.challengeId, requestId: randomId(), clientNonce: randomId(),
      client: { name: 'hariari-desktop', version: '0.6.8' },
      protocolRange: { min: 1, max: 1 },
    };
    await connection.writeFrame({ ...authentication,
      proof: createClientProof(token, challenge, authentication) }, 500);
    await connection.readFrame(500);
    const requestId = randomId();
    const correlationId = randomId();
    await connection.writeFrame({
      kind: 'runtime.request', protocolVersion: 1, requestId,
      operation: { name: operation, version: RUNTIME_OPERATION_VERSION },
      correlationId, causationId: null, idempotencyKey, payload,
    }, 500);
    return parseResponseFrame(await connection.readFrame(500));
  } finally {
    connection.close();
  }
}

function serverFor(
  endpoint: RuntimeLocalEndpoint,
  token: Uint8Array,
  transport: ObservedRuntimeTransport,
  randomId: () => string,
  executionAdapter: GenericCliExecutionAdapter,
): RuntimeServer {
  return new RuntimeServer({
    transport,
    endpoint,
    token,
    supportedProtocolRange: { min: 1, max: 1 },
    runtimeVersion: '0.6.8',
    buildId: 'start-remediation-build',
    now: () => Date.parse('2026-08-21T10:00:00.000Z'),
    randomId,
    randomNonce: randomId,
    handshakeDeadlineMs: 500,
    requestDeadlineMs: 500,
    executionAdapter,
  });
}

async function connect(
  endpoint: RuntimeLocalEndpoint,
  token: Uint8Array,
  transport: ObservedRuntimeTransport,
  randomId: () => string,
): Promise<RuntimeClientSession> {
  const result = await new NodeRuntimeClient({
    transport,
    randomId,
    randomNonce: randomId,
  }).connect(endpoint, token, {
    clientIdentity: { name: 'hariari-desktop', version: '0.6.8' },
    supportedProtocolRange: { min: 1, max: 1 },
    deadlineMs: 500,
  });
  if (result.kind !== 'connected') throw new Error('expected authenticated Runtime session');
  return result.session;
}

export function createTestRepository(): { readonly path: string; readonly baseCommit: string } {
  const repository = createDisposableGitRepository({
    temporaryPrefix: 'hariari-failed-allocation-',
    readmeContents: '# Failed allocation\n',
    commitMessage: 'failed allocation fixture',
    authorName: 'Runtime Test',
    authorEmail: 'runtime@example.test',
  });
  roots.push(repository.root);
  return repository;
}

export function shellTask(idempotencyKey: string, repository: string) {
  return {
    objective: 'Exercise Runtime-owned Task start.',
    project: 'Hariari',
    repository,
    baseRef: 'HEAD',
    provider: 'shell' as const,
    idempotencyKey,
  };
}

export function corruptExecutionAppend(
  eventPath: string,
  failedWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
): void {
  const open = fs.promises.open.bind(fs.promises);
  let writes = 0;
  let partial = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, permissions) => {
    const handle = await open(file, flags, permissions);
    if (file !== eventPath || flags !== 'a') return handle;
    return failingHandle(handle, failedWrite, mode, () => ++writes, () => partial, () => {
      partial = true;
    });
  });
}

export async function appendLegacyTaskEvent(
  runtimeDirectory: string,
  event: Record<string, unknown>,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(event), 'utf8');
  const header = Buffer.alloc(36);
  header.writeUInt32BE(payload.length, 0);
  createHash('sha256').update(payload).digest().copy(header, 4);
  const handle = await fs.promises.open(
    path.join(runtimeDirectory, 'tasks', 'events.log'), 'a', 0o600,
  );
  try {
    await handle.writeFile(Buffer.concat([header, payload]));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function failingHandle(
  handle: fs.promises.FileHandle,
  failedWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
  nextWrite: () => number,
  isPartial: () => boolean,
  markPartial: () => void,
): fs.promises.FileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property !== 'write') return Reflect.get(target, property, receiver);
      return async (data: Buffer) => {
        const write = nextWrite();
        if (write === failedWrite && mode === 'zero-first') {
          return { bytesWritten: 0, buffer: data };
        }
        if (write === failedWrite) {
          markPartial();
          return target.write(data.subarray(0, 1));
        }
        if (isPartial() && write === failedWrite + 1) {
          if (mode === 'partial-then-error') throw new Error('injected append error');
          return { bytesWritten: 0, buffer: data };
        }
        return target.write(data);
      };
    },
  });
}

export function nextRuntimeTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

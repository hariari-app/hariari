import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import { NodeRuntimeClient } from '../../src/main/runtime/node-runtime-client';
import type { RuntimeClientSession } from '../../src/main/runtime/runtime-ports';
import type {
  CreateTaskRequest,
  TaskExecutionState,
  TaskExecutionView,
  TaskTimelineView,
  TaskView,
} from '../../src/shared/runtime/runtime-interface';
import type { GenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';
import type { RuntimeLocalEndpoint } from '../../src/runtime/local-transport';
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
export const APPEND_DURABILITY_MODES = ['complete', ...FAILED_APPEND_MODES] as const;

export interface ExpectedAppendBoundary {
  readonly operation: string;
  readonly writeCall: number;
  readonly eventType: string;
  readonly normalizedKind?: string;
}

export interface ExpectedAppendObservation {
  assertObserved(): void;
}

export interface RuntimeSubject {
  readonly runtimeDirectory: string;
  readonly transport: ObservedRuntimeTransport;
  connect(): Promise<RuntimeClientSession>;
  connectWithCorrelations(correlationIds: readonly string[]): Promise<RuntimeClientSession>;
  restart(): Promise<void>;
  restartWith(adapter: GenericCliExecutionAdapter): Promise<void>;
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
  let adapter = adapterFactory(runtimeDirectory);
  let server = serverFor(endpoint, token, transport, randomId, adapter);
  servers.push(server);
  await server.start();
  return runtimeSubject(
    runtimeDirectory,
    transport,
    connectSubject,
    connectWithCorrelations,
    restartSubject,
    restartWith,
  );

  function connectSubject(): Promise<RuntimeClientSession> {
    return connect(endpoint, token, transport, randomId);
  }

  function connectWithCorrelations(correlationIds: readonly string[]): Promise<RuntimeClientSession> {
    return connect(endpoint, token, transport, clientIds(correlationIds));
  }

  async function restartSubject(): Promise<void> {
    await server.stop();
    server = serverFor(endpoint, token, transport, randomId, adapter);
    servers.push(server);
    await server.start();
  }

  async function restartWith(nextAdapter: GenericCliExecutionAdapter): Promise<void> {
    adapter = nextAdapter;
    await restartSubject();
  }
}

function runtimeEndpoint(root: string, runtimeDirectory: string): RuntimeLocalEndpoint {
  return { kind: 'unix', address: path.join(root, 'runtime.sock'), runtimeDirectory };
}

function runtimeSubject(
  runtimeDirectory: string,
  transport: ObservedRuntimeTransport,
  connect: () => Promise<RuntimeClientSession>,
  connectWithCorrelations: (
    correlationIds: readonly string[],
  ) => Promise<RuntimeClientSession>,
  restart: () => Promise<void>,
  restartWith: (adapter: GenericCliExecutionAdapter) => Promise<void>,
): RuntimeSubject {
  return {
    runtimeDirectory,
    transport,
    connect,
    connectWithCorrelations,
    restart,
    restartWith,
  };
}

function clientIds(correlationIds: readonly string[]): () => string {
  const correlations = [...correlationIds];
  let call = 0;
  return () => {
    call += 1;
    if (call === 1) return 'authenticated-handshake-request';
    if (call === 2) return 'authenticated-handshake-nonce';
    if (call % 2 === 1) return `authenticated-operation-request-${(call - 1) / 2}`;
    return correlations.shift() ?? `authenticated-query-correlation-${call}`;
  };
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

export function readTaskEvents(runtimeDirectory: string): readonly Record<string, unknown>[] {
  const bytes = fs.readFileSync(path.join(runtimeDirectory, 'tasks', 'events.log'));
  return decodeTaskEventFrames(bytes);
}

export function decodeTaskEventFrames(bytes: Buffer): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const payloadOffset = offset + 36;
    const payload = bytes.subarray(payloadOffset, payloadOffset + length).toString('utf8');
    events.push(JSON.parse(payload) as Record<string, unknown>);
    offset = payloadOffset + length;
  }
  return events;
}

export function appendTaskEventFrame(eventPath: string, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.alloc(36 + body.length);
  frame.writeUInt32BE(body.length, 0);
  createHash('sha256').update(body).digest().copy(frame, 4);
  body.copy(frame, 36);
  fs.appendFileSync(eventPath, frame);
}

export async function createStartedTask(
  runtime: RuntimeClientSession,
  request: CreateTaskRequest,
  startKey: string,
): Promise<{ readonly task: TaskView; readonly execution: TaskExecutionView }> {
  const task = await runtime.createTask(request);
  const execution = await runtime.startTask({ taskId: task.id, idempotencyKey: startKey });
  return { task, execution };
}

export async function waitForTaskState(
  runtime: Pick<RuntimeClientSession, 'getTaskExecution' | 'getTaskTimeline'>,
  taskId: string,
  expected: Extract<TaskExecutionState, 'completed' | 'failed' | 'cancelled'>,
): Promise<TaskExecutionView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const execution = await runtime.getTaskExecution(taskId);
    const timeline = await runtime.getTaskTimeline(taskId);
    if (execution.task.executionState === expected &&
      timeline.normalizedEvents.some((event) => event.kind === `attempt-${expected}`)) {
      return execution;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not reach ${expected}`);
}

export async function assertAuthenticatedTaskReplay(
  subject: RuntimeSubject,
  runtime: RuntimeClientSession,
  task: TaskView,
  status: TaskExecutionView,
  timeline: TaskTimelineView,
): Promise<void> {
  const tasks = await runtime.listTasks();
  await runtime.disconnect();
  fs.rmSync(path.join(subject.runtimeDirectory, 'tasks', 'projection.json'));
  await subject.restart();
  const restarted = await subject.connect();
  await expect(restarted.listTasks()).resolves.toEqual(tasks);
  await expect(restarted.getTaskExecution(task.id)).resolves.toEqual(status);
  await expect(restarted.getTaskTimeline(task.id)).resolves.toEqual(timeline);
  await restarted.disconnect();
}

export function corruptExecutionAppend(
  eventPath: string,
  targetWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number],
): void {
  installAppendBoundary(eventPath, targetWrite, mode);
}

export function observeExpectedExecutionAppend(
  eventPath: string,
  boundary: ExpectedAppendBoundary,
  mode: (typeof APPEND_DURABILITY_MODES)[number],
): ExpectedAppendObservation {
  let observed = false;
  let mismatch: unknown = null;
  installAppendBoundary(
    eventPath,
    boundary.writeCall,
    mode === 'complete' ? null : mode,
    (data) => {
      observed = true;
      try {
        assertExpectedAppend(data, boundary);
      } catch (error) {
        mismatch = error;
      }
    },
  );
  return {
    assertObserved(): void {
      if (!observed) {
        throw new Error(`${boundary.operation} boundary was not reached`);
      }
      if (mismatch) {
        throw mismatch;
      }
    },
  };
}

function installAppendBoundary(
  eventPath: string,
  targetWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number] | null,
  observeTarget: (data: Buffer) => void = () => undefined,
): void {
  const open = fs.promises.open.bind(fs.promises);
  let writes = 0;
  let partial = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, permissions) => {
    const handle = await open(file, flags, permissions);
    if (file !== eventPath || flags !== 'a') return handle;
    return instrumentedAppendHandle(
      handle,
      targetWrite,
      mode,
      () => ++writes,
      () => partial,
      () => {
        partial = true;
      },
      observeTarget,
    );
  });
}

function instrumentedAppendHandle(
  handle: fs.promises.FileHandle,
  targetWrite: number,
  mode: (typeof FAILED_APPEND_MODES)[number] | null,
  nextWrite: () => number,
  isPartial: () => boolean,
  markPartial: () => void,
  observeTarget: (data: Buffer) => void,
): fs.promises.FileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property !== 'write') return Reflect.get(target, property, receiver);
      return async (data: Buffer) => {
        const write = nextWrite();
        if (write === targetWrite && mode === null) {
          observeTarget(data);
          return target.write(data);
        }
        if (write === targetWrite && mode === 'zero-first') {
          observeTarget(data);
          return { bytesWritten: 0, buffer: data };
        }
        if (write === targetWrite) {
          observeTarget(data);
          markPartial();
          return target.write(data.subarray(0, 1));
        }
        if (isPartial() && write === targetWrite + 1) {
          if (mode === 'partial-then-error') throw new Error('injected append error');
          return { bytesWritten: 0, buffer: data };
        }
        return target.write(data);
      };
    },
  });
}

function assertExpectedAppend(data: Buffer, boundary: ExpectedAppendBoundary): void {
  const payloadLength = data.readUInt32BE(0);
  const payload = JSON.parse(data.subarray(36, 36 + payloadLength).toString('utf8')) as {
    readonly type?: unknown;
    readonly event?: { readonly kind?: unknown };
  };
  if (payload.type !== boundary.eventType) {
    throw new Error(
      `${boundary.operation} write ${boundary.writeCall} expected ${boundary.eventType}, ` +
      `observed ${String(payload.type)}`,
    );
  }
  if (boundary.normalizedKind && payload.event?.kind !== boundary.normalizedKind) {
    throw new Error(
      `${boundary.operation} write ${boundary.writeCall} expected ${boundary.normalizedKind}, ` +
      `observed ${String(payload.event?.kind)}`,
    );
  }
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

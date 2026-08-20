import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NodeLocalRuntimeTransport,
  RuntimeTransportError,
  type NodeLocalRuntimeTransportOptions,
  type RuntimeLocalEndpoint,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';

const temporaryDirectories: string[] = [];
const listeners: RuntimeTransportListener[] = [];
const POST_BIND_FAILURES: ReadonlyArray<{
  readonly name: string;
  readonly options: NodeLocalRuntimeTransportOptions;
}> = [
  { name: 'chmod', options: { chmod: async () => Promise.reject(new Error('chmod failed')) } },
  { name: 'lstat', options: { lstat: async () => Promise.reject(new Error('lstat failed')) } },
];

describe('Node local Runtime transport', registerRuntimeTransportTests);

function registerRuntimeTransportTests(): void {
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exchanges bounded frames over a Unix-domain socket', exchangesFrames);
  it('enforces read deadlines without exposing socket errors', enforcesReadDeadline);
  it.each(POST_BIND_FAILURES)('closes the bound server when $name fails', closesFailedListener);
}

async function exchangesFrames(): Promise<void> {
  const endpoint = unixEndpoint('hariari-runtime-transport-');
  const transport = new NodeLocalRuntimeTransport();
  const listener = await transport.listen(endpoint, async (connection) => {
    const request = await connection.readFrame(500);
    await connection.writeFrame({ kind: 'reply', request }, 500);
    connection.close();
  });
  listeners.push(listener);
  const connection = await transport.connect(endpoint, 500);
  await connection.writeFrame({ kind: 'request', value: 19 }, 500);

  await expect(connection.readFrame(500)).resolves.toEqual({
    kind: 'reply',
    request: { kind: 'request', value: 19 },
  });
}

async function enforcesReadDeadline(): Promise<void> {
  const endpoint = unixEndpoint('hariari-runtime-deadline-');
  const transport = new NodeLocalRuntimeTransport();
  const listener = await transport.listen(endpoint, async () => undefined);
  listeners.push(listener);
  const connection = await transport.connect(endpoint, 500);

  await expect(connection.readFrame(5)).rejects.toEqual(new RuntimeTransportError('deadline'));
  connection.close();
}

async function closesFailedListener(testCase: (typeof POST_BIND_FAILURES)[number]): Promise<void> {
  const endpoint = unixEndpoint(`hariari-runtime-${testCase.name}-failure-`);
  const transport = new NodeLocalRuntimeTransport(testCase.options);
  const outcome = await transport
    .listen(endpoint, async () => undefined)
    .then(
      (listener) => ({ listener }),
      (error: unknown) => ({ error }),
    );
  if ('listener' in outcome) listeners.push(outcome.listener);

  expect(outcome).toMatchObject({ error: { code: 'connect-failed' } });
  expect(fs.existsSync(endpoint.address)).toBe(false);
  const recovered = await new NodeLocalRuntimeTransport().listen(endpoint, async () => undefined);
  listeners.push(recovered);
}

function unixEndpoint(prefix: string): RuntimeLocalEndpoint {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return {
    kind: 'unix',
    address: path.join(directory, 'runtime.sock'),
    runtimeDirectory: directory,
  };
}

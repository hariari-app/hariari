import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NodeLocalRuntimeTransport,
  RuntimeTransportError,
  type RuntimeTransportListener,
} from '../../src/runtime/local-transport';

describe('Node local Runtime transport', () => {
  const temporaryDirectories: string[] = [];
  const listeners: RuntimeTransportListener[] = [];

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exchanges bounded frames over a Unix-domain socket', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-transport-'));
    temporaryDirectories.push(directory);
    const endpoint = {
      kind: 'unix' as const,
      address: path.join(directory, 'runtime.sock'),
      runtimeDirectory: directory,
    };
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
  });

  it('enforces read deadlines without exposing socket errors', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-runtime-deadline-'));
    temporaryDirectories.push(directory);
    const endpoint = {
      kind: 'unix' as const,
      address: path.join(directory, 'runtime.sock'),
      runtimeDirectory: directory,
    };
    const transport = new NodeLocalRuntimeTransport();
    const listener = await transport.listen(endpoint, async () => undefined);
    listeners.push(listener);
    const connection = await transport.connect(endpoint, 500);

    const result = connection.readFrame(5);
    await expect(result).rejects.toEqual(new RuntimeTransportError('deadline'));
    connection.close();
  });
});

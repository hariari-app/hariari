import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeEndpoint } from './endpoint';
import { NodeLocalRuntimeTransport } from './local-transport';
import { RuntimeServer } from './runtime-server';
import { ProtectedRuntimeTokenStore } from './token-store';
import { RUNTIME_IDENTIFIER_MAX_LENGTH } from '../shared/runtime/runtime-interface';

const DEFAULT_HANDSHAKE_DEADLINE_MS = 5_000;
const DEFAULT_REQUEST_DEADLINE_MS = 30_000;

interface RuntimeProcessConfiguration {
  readonly runtimeDirectory: string;
  readonly runtimeVersion: string;
  readonly buildId: string;
}

export async function runRuntimeProcess(configuration: RuntimeProcessConfiguration): Promise<void> {
  const tokens = new ProtectedRuntimeTokenStore(configuration.runtimeDirectory);
  const token = await tokens.read();
  if (!token) throw new Error('Runtime credential is unavailable');
  const server = new RuntimeServer({
    transport: new NodeLocalRuntimeTransport(),
    endpoint: resolveRuntimeEndpoint(configuration.runtimeDirectory),
    token,
    supportedProtocolRange: { min: 1, max: 1 },
    runtimeVersion: configuration.runtimeVersion,
    buildId: configuration.buildId,
    now: Date.now,
    randomId: randomUUID,
    randomNonce: () => randomBytes(32).toString('base64url'),
    handshakeDeadlineMs: DEFAULT_HANDSHAKE_DEADLINE_MS,
    requestDeadlineMs: DEFAULT_REQUEST_DEADLINE_MS,
    nodeModulesRoot: path.dirname(process.execPath),
  });
  const stop = (): void => {
    void server.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await server.start();
}

function parseConfiguration(argv: readonly string[]): RuntimeProcessConfiguration {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Runtime arguments are invalid');
    }
    values.set(name, value);
  }
  const runtimeDirectory =
    values.get('--runtime-dir') ?? path.join(os.homedir(), '.hariari', 'runtime');
  const runtimeVersion = requiredValue(values, '--runtime-version');
  const buildId = requiredValue(values, '--build-id');
  return { runtimeDirectory, runtimeVersion, buildId };
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value || value.length > RUNTIME_IDENTIFIER_MAX_LENGTH) {
    throw new Error('Runtime arguments are invalid');
  }
  return value;
}

async function main(): Promise<void> {
  await runRuntimeProcess(parseConfiguration(process.argv.slice(2)));
}

void main().catch(() => {
  process.stderr.write('Hariari Runtime failed to start\n');
  process.exitCode = 1;
});

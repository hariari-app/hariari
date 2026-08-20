import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeLocalEndpoint } from './local-transport';

export interface RuntimeEndpointOptions {
  readonly platform?: NodeJS.Platform;
  readonly temporaryDirectory?: string;
  readonly userId?: string;
}

export function resolveRuntimeEndpoint(
  runtimeDirectory: string,
  options: RuntimeEndpointOptions = {},
): RuntimeLocalEndpoint {
  const platform = options.platform ?? process.platform;
  const canonicalDirectory =
    platform === 'win32'
      ? runtimeDirectory.replaceAll('/', '\\').toLowerCase()
      : path.resolve(runtimeDirectory);
  const hash = createHash('sha256').update(canonicalDirectory).digest('hex').slice(0, 16);
  const resolvedRuntimeDirectory =
    platform === 'win32' ? runtimeDirectory : path.resolve(runtimeDirectory);

  if (platform === 'win32') {
    return {
      kind: 'windows-pipe',
      address: `\\\\.\\pipe\\hariari-runtime-${hash}-v1`,
      runtimeDirectory: resolvedRuntimeDirectory,
    };
  }

  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const userId = safeUserId(options.userId ?? String(process.getuid?.() ?? 'user'));
  return {
    kind: 'unix',
    address: path.join(temporaryDirectory, `hariari-${userId}-${hash}`, 'r-v1.sock'),
    runtimeDirectory: resolvedRuntimeDirectory,
  };
}

function safeUserId(value: string): string {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(value)) return value;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

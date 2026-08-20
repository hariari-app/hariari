import type { RuntimeProtocolRange } from '../../shared/runtime/runtime-interface';
import {
  RuntimePortError,
  type RuntimeClientIdentity,
  type RuntimeClientPort,
  type RuntimeEndpoint,
  type RuntimeEndpointPort,
  type RuntimeTokenPort,
} from './runtime-ports';

interface RuntimeTerminationDependencies {
  readonly clients: RuntimeClientPort;
  readonly endpoints: RuntimeEndpointPort;
  readonly tokens: RuntimeTokenPort;
  readonly clientIdentity: RuntimeClientIdentity;
  readonly supportedProtocolRange: RuntimeProtocolRange;
  readonly connectDeadlineMs: number;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
}

export async function waitForRuntimeTermination(
  dependencies: RuntimeTerminationDependencies,
): Promise<boolean> {
  const endpoint = await dependencies.endpoints.resolve();
  const deadlineAt = dependencies.now() + dependencies.connectDeadlineMs;
  let token: Uint8Array | null = null;
  try {
    token = await dependencies.tokens.read();
  } catch {
    // A transport probe still distinguishes a released endpoint without credentials.
  }
  do {
    const remaining = Math.max(1, deadlineAt - dependencies.now());
    if (await endpointIsUnavailable(dependencies, endpoint, token, remaining)) return true;
    if (dependencies.now() >= deadlineAt) return false;
    await dependencies.delay(Math.min(25, remaining));
  } while (dependencies.now() < deadlineAt);
  return endpointIsUnavailable(dependencies, endpoint, token, 1);
}

async function endpointIsUnavailable(
  dependencies: RuntimeTerminationDependencies,
  endpoint: RuntimeEndpoint,
  token: Uint8Array | null,
  deadlineMs: number,
): Promise<boolean> {
  try {
    const connection = await dependencies.clients.connect(endpoint, token, {
      clientIdentity: dependencies.clientIdentity,
      supportedProtocolRange: dependencies.supportedProtocolRange,
      deadlineMs,
    });
    if (connection.kind === 'connected') await connection.session.disconnect();
    return false;
  } catch (error) {
    return error instanceof RuntimePortError && error.code === 'endpoint-unavailable';
  }
}

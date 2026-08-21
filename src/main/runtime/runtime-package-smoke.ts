import type {
  RuntimeConnectionState,
  RuntimeInterface,
} from '../../shared/runtime/runtime-interface';

export const RUNTIME_PACKAGE_SMOKE_OK = 'HARIARI_RUNTIME_PACKAGE_SMOKE_OK';

export async function verifyRuntimePackageSmoke(
  runtime: RuntimeInterface,
): Promise<Extract<RuntimeConnectionState, { state: 'connected' }>> {
  try {
    const state = await runtime.connectOrStart();
    if (state.state !== 'connected') {
      throw new Error(`Packaged Desktop could not connect to Runtime: ${state.state}`);
    }
    const shutdown = await runtime.shutdown({
      idempotencyKey: `package-smoke-${state.health.instanceId}`,
      expectedInstanceId: state.health.instanceId,
      reason: 'test',
    });
    if (shutdown.state !== 'stopped') {
      throw new Error(`Packaged Desktop could not stop Runtime: ${shutdown.state}`);
    }
    return state;
  } finally {
    await runtime.disconnect().catch(() => undefined);
  }
}

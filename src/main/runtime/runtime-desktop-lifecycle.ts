import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RuntimeRendererStatus } from '../../shared/ipc-types';
import type {
  RuntimeInterface,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';
import { registerRuntimeIpc, type RuntimeIpcRegistry } from '../ipc/runtime-ipc';
import { createDesktopRuntimeInterface } from './desktop-runtime';
import { RUNTIME_PACKAGE_SMOKE_OK, verifyRuntimePackageSmoke } from './runtime-package-smoke';

export interface DesktopRuntimeLifecycle {
  publishLatest(): void;
  prepareForDesktopUpdate(): Promise<void>;
  dispose(): void;
}

interface DesktopRuntimeLifecycleOptions {
  readonly ipc: RuntimeIpcRegistry;
  readonly publishStatus: (status: RuntimeRendererStatus) => void;
  readonly runtime?: RuntimeInterface;
}

export function startDesktopRuntimeLifecycle(
  options: DesktopRuntimeLifecycleOptions,
): DesktopRuntimeLifecycle {
  const runtime = options.runtime ?? createDesktopRuntimeInterface();
  const registration = registerRuntimeIpc(runtime, options.ipc, options.publishStatus);
  void runtime.connectOrStart().catch(() => undefined);
  return {
    publishLatest: () => registration.publishLatest(),
    prepareForDesktopUpdate: () => prepareRuntimeForDesktopUpdate(runtime),
    dispose: () => {
      registration.dispose();
      void runtime.disconnect().catch(() => undefined);
    },
  };
}

async function prepareRuntimeForDesktopUpdate(runtime: RuntimeInterface): Promise<void> {
  const current = await runtime.queryHealth();
  const connected = current.state === 'connected' ? current : await runtime.connectOrStart();
  if (connected.state !== 'connected') throw new Error('Runtime is not connected');
  const expectedInstanceId = connected.health.instanceId;
  let result: RuntimeShutdownResult;
  try {
    result = await runtime.shutdown({
      idempotencyKey: randomUUID(),
      expectedInstanceId,
      reason: 'desktop-update',
    });
  } catch (error) {
    await restoreRuntimeConnection(runtime);
    throw error;
  }
  if (
    result.state === 'not-running' ||
    (result.state === 'stopped' && result.instanceId === expectedInstanceId)
  ) {
    return;
  }
  await restoreRuntimeConnection(runtime);
  throw new Error('Runtime shutdown was not confirmed');
}

async function restoreRuntimeConnection(runtime: RuntimeInterface): Promise<void> {
  await runtime.connectOrStart().catch(() => undefined);
}

export async function smokePackagedDesktopRuntime(runtimeDirectory: string): Promise<void> {
  await verifyRuntimePackageSmoke(createDesktopRuntimeInterface({ runtimeDirectory }));
}

export function startRuntimePackageSmokeIfRequested(
  application: Pick<Electron.App, 'whenReady' | 'exit'>,
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!argv.includes('--runtime-package-smoke')) return false;
  const runtimeDirectory = environment.HARIARI_RUNTIME_SMOKE_DIRECTORY;
  if (!runtimeDirectory || !path.isAbsolute(runtimeDirectory)) {
    throw new Error('Runtime package smoke directory must be absolute');
  }
  void application
    .whenReady()
    .then(() => smokePackagedDesktopRuntime(runtimeDirectory))
    .then(
      () => {
        console.log(RUNTIME_PACKAGE_SMOKE_OK);
        application.exit(0);
      },
      (error: unknown) => {
        console.error('Packaged Desktop Runtime smoke failed', error);
        application.exit(1);
      },
    );
  return true;
}

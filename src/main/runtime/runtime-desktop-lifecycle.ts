import path from 'node:path';
import type { RuntimeRendererStatus } from '../../shared/ipc-types';
import type { RuntimeInterface } from '../../shared/runtime/runtime-interface';
import {
  registerRuntimeIpc,
  type RuntimeIpcRegistry,
} from '../ipc/runtime-ipc';
import { createDesktopRuntimeInterface } from './desktop-runtime';
import {
  RUNTIME_PACKAGE_SMOKE_OK,
  verifyRuntimePackageSmoke,
} from './runtime-package-smoke';

export interface DesktopRuntimeLifecycle {
  publishLatest(): void;
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
    dispose: () => {
      registration.dispose();
      void runtime.disconnect().catch(() => undefined);
    },
  };
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

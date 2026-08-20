import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { RuntimeInterface } from '../../shared/runtime/runtime-interface';
import { NodeLocalRuntimeTransport } from '../../runtime/local-transport';
import { ProtectedRuntimeTokenStore } from '../../runtime/token-store';
import { DetachedRuntimeProcessAdapter } from './detached-runtime-process';
import { FileRuntimeStartupLeasePort } from './file-startup-lease';
import { LocalRuntimeEndpointPort } from './local-endpoint-port';
import { NodeRuntimeClient } from './node-runtime-client';
import { PackagedRuntimeArtifactPort } from './packaged-runtime-artifact';
import { createRuntimeConnector, type RuntimeConnectorDependencies } from './runtime-connector';
import type { RuntimeSupervisionSchedule } from './runtime-connection-supervisor';
import type {
  RuntimeArtifactPort,
  RuntimeClientPort,
  RuntimeEndpointPort,
  RuntimeProcessPort,
  RuntimeStartupLeasePort,
  RuntimeTokenPort,
} from './runtime-ports';

const CONNECT_DEADLINE_MS = 2_000;
const STARTUP_DEADLINE_MS = 8_000;
const RECONNECT_DELAY_MS = 250;
const HEALTH_POLL_INTERVAL_MS = 10_000;

export interface DesktopRuntimeOptions {
  readonly runtimeVersion?: string;
  readonly runtimeDirectory?: string;
  readonly developmentResourcesPath?: string;
  readonly clients?: RuntimeClientPort;
  readonly endpoints?: RuntimeEndpointPort;
  readonly tokens?: RuntimeTokenPort;
  readonly processes?: RuntimeProcessPort;
  readonly leases?: RuntimeStartupLeasePort;
  readonly artifacts?: RuntimeArtifactPort;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly healthPollIntervalMs?: number;
  readonly schedule?: RuntimeSupervisionSchedule;
}

export function createDesktopRuntimeInterface(
  options: DesktopRuntimeOptions = {},
): RuntimeInterface {
  const runtimeVersion = options.runtimeVersion ?? app.getVersion();
  const runtimeDirectory =
    options.runtimeDirectory ?? path.join(os.homedir(), '.hariari', 'runtime');
  const transport = new NodeLocalRuntimeTransport();
  const artifacts =
    options.artifacts ??
    new PackagedRuntimeArtifactPort({
      resourcesPath: app.isPackaged
        ? process.resourcesPath
        : (options.developmentResourcesPath ??
          path.join(app.getAppPath(), 'out', 'runtime-artifacts')),
      runtimeDirectory,
      expectedRuntimeVersion: runtimeVersion,
    });
  const dependencies: RuntimeConnectorDependencies = {
    clients:
      options.clients ??
      new NodeRuntimeClient({
        transport,
        randomId: randomUUID,
        randomNonce: () => randomBytes(32).toString('base64url'),
      }),
    endpoints: options.endpoints ?? new LocalRuntimeEndpointPort(runtimeDirectory),
    tokens: options.tokens ?? new ProtectedRuntimeTokenStore(runtimeDirectory),
    processes: options.processes ?? new DetachedRuntimeProcessAdapter({ runtimeVersion }),
    leases: options.leases ?? new FileRuntimeStartupLeasePort(runtimeDirectory),
    artifacts,
    clientIdentity: { name: 'hariari-desktop', version: runtimeVersion },
    supportedProtocolRange: { min: 1, max: 1 },
    connectDeadlineMs: CONNECT_DEADLINE_MS,
    startupDeadlineMs: STARTUP_DEADLINE_MS,
    reconnectDelayMs: RECONNECT_DELAY_MS,
    healthPollIntervalMs: options.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS,
    schedule: options.schedule ?? scheduleRuntimeTask,
    now: options.now ?? Date.now,
    delay:
      options.delay ??
      ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
  return createRuntimeConnector(dependencies);
}

function scheduleRuntimeTask(milliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

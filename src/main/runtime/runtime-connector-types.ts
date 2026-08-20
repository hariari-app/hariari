import type {
  RuntimeConnectionState,
  RuntimeProtocolRange,
} from '../../shared/runtime/runtime-interface';
import type { RuntimeSupervisionSchedule } from './runtime-connection-supervisor';
import type {
  RuntimeArtifactPort,
  RuntimeClientIdentity,
  RuntimeClientPort,
  RuntimeEndpointPort,
  RuntimeProcessPort,
  RuntimeStartupLeasePort,
  RuntimeTokenPort,
  RuntimePortError,
} from './runtime-ports';

export interface RuntimeConnectorDependencies {
  readonly clients: RuntimeClientPort;
  readonly endpoints: RuntimeEndpointPort;
  readonly tokens: RuntimeTokenPort;
  readonly processes: RuntimeProcessPort;
  readonly leases: RuntimeStartupLeasePort;
  readonly artifacts: RuntimeArtifactPort;
  readonly clientIdentity: RuntimeClientIdentity;
  readonly supportedProtocolRange: RuntimeProtocolRange;
  readonly connectDeadlineMs: number;
  readonly startupDeadlineMs: number;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly reconnectDelayMs: number;
  readonly healthPollIntervalMs: number;
  readonly schedule: RuntimeSupervisionSchedule;
}

type ConnectedState = Extract<RuntimeConnectionState, { state: 'connected' }>;
type IncompatibleState = Extract<RuntimeConnectionState, { state: 'incompatible' }>;

export type RuntimeConnectResult =
  | { readonly kind: 'connected'; readonly state: ConnectedState }
  | { readonly kind: 'incompatible'; readonly state: IncompatibleState }
  | {
      readonly kind: 'unavailable';
      readonly state: Extract<RuntimeConnectionState, { state: 'unavailable' }>;
    }
  | { readonly kind: 'failed'; readonly error: RuntimePortError }
  | { readonly kind: 'cancelled' };

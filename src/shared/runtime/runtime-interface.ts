export interface RuntimeProtocolRange {
  readonly min: number;
  readonly max: number;
}

export interface RuntimeHealth {
  readonly status: 'ready';
  readonly instanceId: string;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly protocolVersion: number;
  readonly startedAt: string;
  readonly checkedAt: string;
}

export type RuntimeOperationFailureCode =
  | 'invalid-request'
  | 'unsupported-operation'
  | 'stale-instance'
  | 'idempotency-conflict'
  | 'runtime-stopping'
  | 'internal';

export type RuntimeUnavailableReason =
  | 'not-connected'
  | 'client-disconnected'
  | 'credentials-unavailable'
  | 'authentication-rejected'
  | 'artifact-unavailable'
  | 'start-failed'
  | 'startup-timeout'
  | 'connection-failed'
  | 'transport-lost'
  | 'protocol-error'
  | 'health-timeout'
  | 'runtime-stopped'
  | RuntimeOperationFailureCode;

export type RuntimeConnectionState =
  | {
      readonly state: 'connected';
      readonly health: RuntimeHealth;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: RuntimeUnavailableReason;
      readonly retryable: boolean;
    }
  | {
      readonly state: 'incompatible';
      readonly desktopRange: RuntimeProtocolRange;
      readonly runtimeRange: RuntimeProtocolRange;
      readonly runtimeVersion: string;
      readonly buildId: string;
    };

export interface RuntimeShutdownRequest {
  readonly idempotencyKey: string;
  readonly expectedInstanceId: string;
  readonly reason: 'user-request' | 'desktop-update' | 'test';
}

export type RuntimeShutdownResult =
  | {
      readonly state: 'stopped';
      readonly instanceId: string;
    }
  | { readonly state: 'not-running' }
  | Extract<RuntimeConnectionState, { readonly state: 'unavailable' | 'incompatible' }>;

export interface RuntimeInterface {
  connectOrStart(): Promise<RuntimeConnectionState>;
  queryHealth(): Promise<RuntimeConnectionState>;
  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void;
  disconnect(): Promise<void>;
  shutdown(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult>;
}

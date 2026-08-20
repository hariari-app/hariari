import type {
  RuntimeHealth,
  RuntimeOperationFailureCode,
  RuntimeProtocolRange,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';

export type RuntimePortErrorCode =
  | 'endpoint-unavailable'
  | 'connection-failed'
  | 'credentials-unavailable'
  | 'authentication-rejected'
  | 'artifact-unavailable'
  | 'start-failed'
  | 'timeout'
  | 'transport-lost'
  | 'protocol-error'
  | RuntimeOperationFailureCode;

export class RuntimePortError extends Error {
  readonly code: RuntimePortErrorCode;

  constructor(
    code: RuntimePortErrorCode,
    readonly retryable?: boolean,
    options?: ErrorOptions,
  ) {
    super(`Runtime operation failed: ${code}`, options);
    this.name = 'RuntimePortError';
    this.code = code;
  }
}

export interface RuntimeEndpoint {
  readonly kind: 'unix' | 'windows-pipe';
  readonly address: string;
  readonly runtimeDirectory: string;
}

export interface RuntimeClientIdentity {
  readonly name: 'hariari-desktop' | 'hariari-cli';
  readonly version: string;
}

export interface RuntimeClientConnectOptions {
  readonly clientIdentity: RuntimeClientIdentity;
  readonly supportedProtocolRange: RuntimeProtocolRange;
  readonly deadlineMs: number;
}

export interface RuntimeClientSession {
  queryHealth(deadlineMs?: number): Promise<RuntimeHealth>;
  shutdown(request: RuntimeShutdownRequest, deadlineMs?: number): Promise<RuntimeShutdownResult>;
  disconnect(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
}

export type RuntimeClientConnection =
  | { readonly kind: 'connected'; readonly session: RuntimeClientSession }
  | {
      readonly kind: 'incompatible';
      readonly runtimeRange: RuntimeProtocolRange;
      readonly runtimeVersion: string;
      readonly buildId: string;
    };

export interface RuntimeClientPort {
  connect(
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    options: RuntimeClientConnectOptions,
  ): Promise<RuntimeClientConnection>;
}

export interface RuntimeEndpointPort {
  resolve(): Promise<RuntimeEndpoint>;
}

export interface RuntimeTokenPort {
  read(): Promise<Uint8Array | null>;
  ensure(): Promise<Uint8Array>;
}

export interface RuntimeArtifact {
  readonly executablePath: string;
  readonly runtimeVersion: string;
  readonly buildId: string;
}

export interface RuntimeArtifactPort {
  resolve(): Promise<RuntimeArtifact>;
}

export interface RuntimeProcessStartRequest {
  readonly artifact: RuntimeArtifact;
  readonly endpoint: RuntimeEndpoint;
}

export interface RuntimeProcessLaunch {
  terminate(): Promise<void>;
  settled(): Promise<void>;
}

export interface RuntimeProcessPort {
  start(request: RuntimeProcessStartRequest): Promise<RuntimeProcessLaunch>;
}

export interface RuntimeStartupLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface RuntimeStartupLeasePort {
  acquire(deadlineAt: number): Promise<RuntimeStartupLease | null>;
}

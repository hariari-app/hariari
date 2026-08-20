import type {
  RuntimeConnectionState,
  RuntimeShutdownRequest,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';
import type { RuntimeProcessLaunch } from './runtime-ports';

export interface RuntimeConnectOwnership {
  readonly generation: number;
  promise: Promise<RuntimeConnectionState>;
  launch: RuntimeProcessLaunch | null;
}

export class RuntimeConnectorLifecycle {
  private connectOwnerValue: RuntimeConnectOwnership | null = null;
  private shutdownOwner: RuntimeConnectOwnership | null = null;
  private shutdownTail: Promise<RuntimeShutdownResult> | null = null;
  private readonly shutdownsByFingerprint = new Map<string, Promise<RuntimeShutdownResult>>();

  connectInFlight(generation: number): Promise<RuntimeConnectionState> | null {
    return this.connectOwnerValue?.generation === generation
      ? this.connectOwnerValue.promise
      : null;
  }

  shutdownInFlight(): Promise<RuntimeShutdownResult> | null {
    return this.shutdownTail;
  }

  beginConnect(
    generation: number,
    operation: () => Promise<RuntimeConnectionState>,
  ): Promise<RuntimeConnectionState> {
    const owner: RuntimeConnectOwnership = {
      generation,
      promise: Promise.resolve({
        state: 'unavailable',
        reason: 'not-connected',
        retryable: true,
      }),
      launch: null,
    };
    const promise = operation().finally(() => {
      if (this.connectOwnerValue === owner) this.connectOwnerValue = null;
    });
    owner.promise = promise;
    this.connectOwnerValue = owner;
    return promise;
  }

  ownLaunch(generation: number, launch: RuntimeProcessLaunch): void {
    const owner = this.connectOwnerValue ?? this.shutdownOwner;
    if (owner?.generation === generation) owner.launch = launch;
  }

  beginShutdown(
    request: RuntimeShutdownRequest,
    operation: (owner: RuntimeConnectOwnership | null) => Promise<RuntimeShutdownResult>,
  ): Promise<RuntimeShutdownResult> {
    const fingerprint = shutdownFingerprint(request);
    const equivalent = this.shutdownsByFingerprint.get(fingerprint);
    if (equivalent) return equivalent;
    const predecessor = this.shutdownTail;
    const owner = predecessor ? null : this.connectOwnerValue;
    if (owner) this.shutdownOwner = owner;
    const execute = () => invokeShutdown(operation, owner);
    const promise = predecessor ? predecessor.then(execute, execute) : execute();
    this.shutdownTail = promise;
    this.shutdownsByFingerprint.set(fingerprint, promise);
    const settled = () => this.settleShutdown(fingerprint, promise);
    void promise.then(settled, settled);
    return promise;
  }

  private settleShutdown(fingerprint: string, promise: Promise<RuntimeShutdownResult>): void {
    if (this.shutdownsByFingerprint.get(fingerprint) === promise) {
      this.shutdownsByFingerprint.delete(fingerprint);
    }
    if (this.shutdownTail === promise) {
      this.shutdownTail = null;
      this.shutdownOwner = null;
    }
  }
}

function shutdownFingerprint(request: RuntimeShutdownRequest): string {
  return JSON.stringify([request.idempotencyKey, request.expectedInstanceId, request.reason]);
}

function invokeShutdown(
  operation: (owner: RuntimeConnectOwnership | null) => Promise<RuntimeShutdownResult>,
  owner: RuntimeConnectOwnership | null,
): Promise<RuntimeShutdownResult> {
  try {
    return operation(owner);
  } catch (error) {
    return Promise.reject(error);
  }
}

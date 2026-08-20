import type {
  RuntimeConnectionState,
  RuntimeShutdownResult,
} from '../../shared/runtime/runtime-interface';
import type { RuntimeProcessLaunch } from './runtime-ports';

export interface RuntimeConnectOwnership {
  readonly generation: number;
  promise: Promise<RuntimeConnectionState>;
  launch: RuntimeProcessLaunch | null;
}

type RuntimeConnectorLifecycleState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'connecting'; readonly owner: RuntimeConnectOwnership }
  | {
      readonly phase: 'shutting-down';
      readonly promise: Promise<RuntimeShutdownResult>;
      readonly owner: RuntimeConnectOwnership | null;
    };

export class RuntimeConnectorLifecycle {
  private state: RuntimeConnectorLifecycleState = { phase: 'idle' };

  connectInFlight(generation: number): Promise<RuntimeConnectionState> | null {
    return this.state.phase === 'connecting' && this.state.owner.generation === generation
      ? this.state.owner.promise
      : null;
  }

  shutdownInFlight(): Promise<RuntimeShutdownResult> | null {
    return this.state.phase === 'shutting-down' ? this.state.promise : null;
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
      if (this.state.phase === 'connecting' && this.state.owner === owner) {
        this.state = { phase: 'idle' };
      }
    });
    owner.promise = promise;
    this.state = { phase: 'connecting', owner };
    return promise;
  }

  ownLaunch(generation: number, launch: RuntimeProcessLaunch): void {
    const owner = this.connectOwner();
    if (owner?.generation === generation) owner.launch = launch;
  }

  beginShutdown(
    operation: (owner: RuntimeConnectOwnership | null) => Promise<RuntimeShutdownResult>,
  ): Promise<RuntimeShutdownResult> {
    const active = this.shutdownInFlight();
    if (active) return active;
    const owner = this.connectOwner();
    const promise = Promise.resolve()
      .then(() => operation(owner))
      .finally(() => {
        if (this.state.phase === 'shutting-down' && this.state.promise === promise) {
          this.state = { phase: 'idle' };
        }
      });
    this.state = { phase: 'shutting-down', promise, owner };
    return promise;
  }

  private connectOwner(): RuntimeConnectOwnership | null {
    if (this.state.phase === 'connecting') return this.state.owner;
    return this.state.phase === 'shutting-down' ? this.state.owner : null;
  }
}

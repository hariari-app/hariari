import type { RuntimeConnectionState } from '../../shared/runtime/runtime-interface';
import { RuntimePortError } from './runtime-ports';

export type RuntimeSupervisionSchedule = (milliseconds: number, task: () => void) => () => void;

interface RuntimeConnectionSupervisorOptions {
  readonly reconnectDelayMs: number;
  readonly healthPollIntervalMs: number;
  readonly schedule: RuntimeSupervisionSchedule;
}

type RuntimeUnavailableState = Extract<RuntimeConnectionState, { state: 'unavailable' }>;

const PORT_ERROR_STATES: Record<
  RuntimePortError['code'],
  readonly [RuntimeUnavailableState['reason'], boolean]
> = {
  'credentials-unavailable': ['credentials-unavailable', false],
  'authentication-rejected': ['authentication-rejected', false],
  'artifact-unavailable': ['artifact-unavailable', false],
  'start-failed': ['start-failed', true],
  timeout: ['health-timeout', true],
  'protocol-error': ['protocol-error', false],
  'endpoint-unavailable': ['connection-failed', true],
  'transport-lost': ['transport-lost', true],
  'connection-failed': ['connection-failed', true],
  'invalid-request': ['invalid-request', false],
  'unsupported-operation': ['unsupported-operation', false],
  'stale-instance': ['stale-instance', false],
  'idempotency-conflict': ['idempotency-conflict', false],
  'not-found': ['not-found', false],
  'task-not-ready': ['task-not-ready', false],
  'worktree-unavailable': ['worktree-unavailable', true],
  'process-start-failed': ['process-start-failed', true],
  'runtime-stopping': ['runtime-stopping', true],
  internal: ['internal', true],
};

export class RuntimeConnectionSupervisor {
  private generation = 0;
  private active = false;
  private suspended = false;
  private cancelRetry: (() => void) | null = null;
  private cancelHealthPoll: (() => void) | null = null;
  private state: RuntimeConnectionState = {
    state: 'unavailable',
    reason: 'not-connected',
    retryable: true,
  };
  private readonly listeners = new Set<(state: RuntimeConnectionState) => void>();

  constructor(private readonly options: RuntimeConnectionSupervisorOptions) {}

  start(): number {
    if (!this.active || this.suspended) this.generation += 1;
    this.active = true;
    this.suspended = false;
    return this.generation;
  }

  suspend(): number {
    this.generation += 1;
    this.active = true;
    this.suspended = true;
    this.clearTimers();
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
    this.active = false;
    this.suspended = false;
    this.clearTimers();
  }

  isActive(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  currentGeneration(): number | null {
    return this.active ? this.generation : null;
  }

  currentState(): RuntimeConnectionState {
    return this.state;
  }

  subscribe(listener: (state: RuntimeConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  publish<T extends RuntimeConnectionState>(state: T): T {
    if (JSON.stringify(this.state) === JSON.stringify(state)) return state;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Observers cannot break the Runtime connection lifecycle.
      }
    }
    return state;
  }

  publishUnavailable(
    reason: RuntimeUnavailableState['reason'],
    retryable: boolean,
  ): RuntimeUnavailableState {
    return this.publish({ state: 'unavailable', reason, retryable });
  }

  publishPortError(error: RuntimePortError): RuntimeUnavailableState {
    return this.publish(runtimeUnavailableFromPortError(error));
  }

  scheduleRetry(generation: number, task: () => void): void {
    if (!this.canSchedule(generation) || this.cancelRetry) return;
    this.cancelRetry = this.options.schedule(Math.max(1, this.options.reconnectDelayMs), () => {
      this.cancelRetry = null;
      if (this.canSchedule(generation)) task();
    });
  }

  scheduleHealthPoll(generation: number, task: () => void): void {
    if (!this.canSchedule(generation)) return;
    this.clearHealthPoll(generation);
    this.cancelHealthPoll = this.options.schedule(
      Math.max(1, this.options.healthPollIntervalMs),
      () => {
        this.cancelHealthPoll = null;
        if (this.canSchedule(generation)) task();
      },
    );
  }

  clearRetry(generation: number): void {
    if (!this.isActive(generation)) return;
    this.cancelRetry?.();
    this.cancelRetry = null;
  }

  clearHealthPoll(generation: number): void {
    if (!this.isActive(generation)) return;
    this.forceClearHealthPoll();
  }

  private forceClearHealthPoll(): void {
    this.cancelHealthPoll?.();
    this.cancelHealthPoll = null;
  }

  private canSchedule(generation: number): boolean {
    return this.isActive(generation) && !this.suspended;
  }

  private clearTimers(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.forceClearHealthPoll();
  }
}

export function runtimeUnavailableFromPortError(error: RuntimePortError): RuntimeUnavailableState {
  const [reason, defaultRetryable] = PORT_ERROR_STATES[error.code];
  return { state: 'unavailable', reason, retryable: error.retryable ?? defaultRetryable };
}

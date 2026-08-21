import { createHash } from 'node:crypto';
import type {
  RuntimeConnectionState,
  RuntimeHealth,
  RuntimeShutdownRequest,
} from '../../shared/runtime/runtime-interface';
import {
  runtimeUnavailableFromPortError,
  type RuntimeConnectionSupervisor,
} from './runtime-connection-supervisor';
import type { RuntimeConnectorDependencies, RuntimeConnectResult } from './runtime-connector-types';
import {
  RuntimePortError,
  type RuntimeArtifact,
  type RuntimeClientSession,
  type RuntimeEndpoint,
  type RuntimeProcessLaunch,
  type RuntimeStartupLease,
} from './runtime-ports';
import { waitForRuntimeTermination } from './runtime-termination-probe';

export interface RuntimeConnectedCandidate {
  readonly session: RuntimeClientSession;
  readonly health: RuntimeHealth;
}

type IncompatibleState = Extract<RuntimeConnectionState, { state: 'incompatible' }>;
type UnavailableState = Extract<RuntimeConnectionState, { state: 'unavailable' }>;

type RuntimeIdentityResult =
  | { readonly kind: 'connected'; readonly candidate: RuntimeConnectedCandidate }
  | { readonly kind: 'incompatible'; readonly state: IncompatibleState }
  | { readonly kind: 'unavailable'; readonly state: UnavailableState }
  | { readonly kind: 'cancelled' };

type RuntimeCandidateInspection =
  | { readonly kind: 'connected'; readonly candidate: RuntimeConnectedCandidate }
  | { readonly kind: 'failed'; readonly error: RuntimePortError }
  | { readonly kind: 'cancelled' };

interface RuntimeIdentityRequest {
  readonly candidate: RuntimeConnectedCandidate;
  readonly endpoint: RuntimeEndpoint;
  readonly token: Uint8Array | null;
  readonly generation: number;
  readonly lease?: RuntimeStartupLease;
}

type RuntimeIdentityDependencies = Pick<
  RuntimeConnectorDependencies,
  | 'artifacts'
  | 'clients'
  | 'endpoints'
  | 'tokens'
  | 'processes'
  | 'leases'
  | 'clientIdentity'
  | 'supportedProtocolRange'
  | 'connectDeadlineMs'
  | 'startupDeadlineMs'
  | 'now'
  | 'delay'
>;

type CurrentRuntimeProbe =
  | RuntimeIdentityResult
  | { readonly kind: 'retry' }
  | { readonly kind: 'stale' };

export class RuntimeUpgradeIdentityPolicy {
  constructor(
    private readonly dependencies: RuntimeIdentityDependencies,
    private readonly supervisor: RuntimeConnectionSupervisor,
    private readonly adoptSession: (session: RuntimeClientSession, generation: number) => void,
    private readonly ownLaunch: (generation: number, launch: RuntimeProcessLaunch) => void,
  ) {}

  async connect(
    candidate: RuntimeConnectedCandidate,
    endpoint: RuntimeEndpoint,
    token: Uint8Array | null,
    generation: number,
    lease?: RuntimeStartupLease,
  ): Promise<RuntimeConnectionState> {
    const result = await this.reconcile({ candidate, endpoint, token, generation, lease });
    if (result.kind === 'cancelled') return this.supervisor.currentState();
    if (result.kind !== 'connected') return this.supervisor.publish(result.state);
    if (!this.supervisor.isActive(generation)) {
      await result.candidate.session.disconnect().catch(() => undefined);
      return this.supervisor.currentState();
    }
    this.adoptSession(result.candidate.session, generation);
    return this.supervisor.publish({ state: 'connected', health: result.candidate.health });
  }

  async inspect(session: RuntimeClientSession, generation: number): Promise<RuntimeConnectResult> {
    const result = await inspectRuntimeCandidate(session, this.dependencies.connectDeadlineMs, () =>
      this.supervisor.isActive(generation),
    );
    return result.kind === 'failed'
      ? { kind: 'unavailable', state: this.supervisor.publishPortError(result.error) }
      : result;
  }

  private async reconcile(request: RuntimeIdentityRequest): Promise<RuntimeIdentityResult> {
    const artifact = await this.resolveArtifact();
    if (!artifact) return this.unavailableCandidate(request.candidate, 'artifact-unavailable');
    if (!this.isActive(request)) return this.cancelCandidate(request.candidate);
    if (matchesArtifact(request.candidate.health, artifact)) {
      return { kind: 'connected', candidate: request.candidate };
    }

    const acquired = request.lease ? null : await this.acquireLease();
    const lease = request.lease ?? acquired;
    if (!this.isActive(request)) {
      await acquired?.release().catch(() => undefined);
      return this.cancelCandidate(request.candidate);
    }
    if (!lease) {
      await request.candidate.session.disconnect().catch(() => undefined);
      return this.waitForCurrentRuntime(request, artifact);
    }
    try {
      return await this.replaceStaleRuntime(request, artifact, lease);
    } finally {
      await acquired?.release().catch(() => undefined);
    }
  }

  private async replaceStaleRuntime(
    request: RuntimeIdentityRequest,
    artifact: RuntimeArtifact,
    lease: RuntimeStartupLease,
  ): Promise<RuntimeIdentityResult> {
    const stopped = await this.stopCandidate(request.candidate, artifact);
    if (stopped) return stopped;
    if (!this.isActive(request)) return { kind: 'cancelled' };
    if (!(await waitForRuntimeTermination(this.dependencies))) {
      return unavailableResult(new RuntimePortError('timeout'));
    }
    if (!this.isActive(request)) return { kind: 'cancelled' };
    if (!(await lease.renew())) return this.waitForCurrentRuntime(request, artifact);
    try {
      const launch = await this.dependencies.processes.start({
        artifact,
        endpoint: request.endpoint,
      });
      this.ownLaunch(request.generation, launch);
    } catch (error) {
      return unavailableResult(portError(error, 'start-failed'));
    }
    return this.waitForCurrentRuntime(request, artifact);
  }

  private async stopCandidate(
    candidate: RuntimeConnectedCandidate,
    artifact: RuntimeArtifact,
  ): Promise<RuntimeIdentityResult | null> {
    try {
      const result = await candidate.session.shutdown(
        upgradeShutdownRequest(candidate.health, artifact),
        this.dependencies.connectDeadlineMs,
      );
      if (result.state === 'incompatible') return { kind: 'incompatible', state: result };
      if (result.state === 'unavailable') return { kind: 'unavailable', state: result };
      return null;
    } catch (error) {
      return unavailableResult(portError(error, 'connection-failed'));
    } finally {
      await candidate.session.disconnect().catch(() => undefined);
    }
  }

  private async waitForCurrentRuntime(
    request: RuntimeIdentityRequest,
    artifact: RuntimeArtifact,
  ): Promise<RuntimeIdentityResult> {
    const deadlineAt = this.dependencies.now() + this.dependencies.startupDeadlineMs;
    do {
      if (!this.isActive(request)) return { kind: 'cancelled' };
      const result = await this.probeCurrentRuntime(request, artifact);
      if (result.kind !== 'retry' && result.kind !== 'stale') return result;
      await this.dependencies.delay(25);
    } while (this.dependencies.now() < deadlineAt);
    return unavailableResult(new RuntimePortError('timeout'));
  }

  private async probeCurrentRuntime(
    request: RuntimeIdentityRequest,
    artifact: RuntimeArtifact,
  ): Promise<CurrentRuntimeProbe> {
    let connection;
    try {
      connection = await this.dependencies.clients.connect(request.endpoint, request.token, {
        clientIdentity: this.dependencies.clientIdentity,
        supportedProtocolRange: this.dependencies.supportedProtocolRange,
        deadlineMs: this.dependencies.connectDeadlineMs,
      });
    } catch (error) {
      const failure = portError(error, 'connection-failed');
      return failure.code === 'endpoint-unavailable'
        ? { kind: 'retry' }
        : unavailableResult(failure);
    }
    if (connection.kind === 'incompatible')
      return incompatibleResult(this.dependencies, connection);
    return this.inspectConnectedRuntime(connection.session, artifact, () => this.isActive(request));
  }

  private async inspectConnectedRuntime(
    session: RuntimeClientSession,
    artifact: RuntimeArtifact,
    isActive: () => boolean,
  ): Promise<CurrentRuntimeProbe> {
    try {
      const health = await session.queryHealth(this.dependencies.connectDeadlineMs);
      if (!isActive()) {
        await session.disconnect().catch(() => undefined);
        return { kind: 'cancelled' };
      }
      if (matchesArtifact(health, artifact)) {
        return { kind: 'connected', candidate: { session, health } };
      }
      await session.disconnect().catch(() => undefined);
      return { kind: 'stale' };
    } catch (error) {
      await session.disconnect().catch(() => undefined);
      return unavailableResult(portError(error, 'connection-failed'));
    }
  }

  private async resolveArtifact(): Promise<RuntimeArtifact | null> {
    try {
      return await this.dependencies.artifacts.resolve();
    } catch {
      return null;
    }
  }

  private async acquireLease(): Promise<RuntimeStartupLease | null> {
    try {
      return await this.dependencies.leases.acquire(
        this.dependencies.now() + this.dependencies.startupDeadlineMs,
      );
    } catch {
      return null;
    }
  }

  private async unavailableCandidate(
    candidate: RuntimeConnectedCandidate,
    code: RuntimePortError['code'],
  ): Promise<RuntimeIdentityResult> {
    await candidate.session.disconnect().catch(() => undefined);
    return unavailableResult(new RuntimePortError(code));
  }

  private async cancelCandidate(
    candidate: RuntimeConnectedCandidate,
  ): Promise<RuntimeIdentityResult> {
    await candidate.session.disconnect().catch(() => undefined);
    return { kind: 'cancelled' };
  }

  private isActive(request: RuntimeIdentityRequest): boolean {
    return this.supervisor.isActive(request.generation);
  }
}

async function inspectRuntimeCandidate(
  session: RuntimeClientSession,
  deadlineMs: number,
  isActive: () => boolean,
): Promise<RuntimeCandidateInspection> {
  try {
    const health = await session.queryHealth(deadlineMs);
    if (isActive()) return { kind: 'connected', candidate: { session, health } };
    await session.disconnect().catch(() => undefined);
    return { kind: 'cancelled' };
  } catch (error) {
    await session.disconnect().catch(() => undefined);
    return { kind: 'failed', error: portError(error, 'connection-failed') };
  }
}

function matchesArtifact(health: RuntimeHealth, artifact: RuntimeArtifact): boolean {
  return health.runtimeVersion === artifact.runtimeVersion && health.buildId === artifact.buildId;
}

function upgradeShutdownRequest(
  health: RuntimeHealth,
  artifact: RuntimeArtifact,
): RuntimeShutdownRequest {
  const fingerprint = createHash('sha256')
    .update(`${health.instanceId}\0${artifact.runtimeVersion}\0${artifact.buildId}`)
    .digest('hex');
  return {
    idempotencyKey: `runtime-upgrade-${fingerprint}`,
    expectedInstanceId: health.instanceId,
    reason: 'desktop-update',
  };
}

function incompatibleResult(
  dependencies: RuntimeIdentityDependencies,
  connection: Extract<
    Awaited<ReturnType<RuntimeIdentityDependencies['clients']['connect']>>,
    { kind: 'incompatible' }
  >,
): RuntimeIdentityResult {
  return {
    kind: 'incompatible',
    state: {
      state: 'incompatible',
      desktopRange: dependencies.supportedProtocolRange,
      runtimeRange: connection.runtimeRange,
      runtimeVersion: connection.runtimeVersion,
      buildId: connection.buildId,
    },
  };
}

function portError(error: unknown, fallback: RuntimePortError['code']): RuntimePortError {
  return error instanceof RuntimePortError ? error : new RuntimePortError(fallback);
}

function unavailableResult(error: RuntimePortError): RuntimeIdentityResult {
  return { kind: 'unavailable', state: runtimeUnavailableFromPortError(error) };
}

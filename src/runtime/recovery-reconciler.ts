import type {
  TaskRecoveryDecisionView,
  TaskRecoveryView,
} from '../shared/runtime/runtime-interface';
import type {
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
} from './generic-cli-execution-adapter';
import type { PrivateTaskExecutionView } from './task-execution-projection';

const MAX_RECOVERY_RESOURCES = 20;

/** Central deterministic desired-versus-observed recovery decision table. */
export class RecoveryReconciler {
  constructor(private readonly randomId: () => string) {}

  reconcile(
    desired: PrivateTaskExecutionView,
    observation: ExecutionRecoveryObservation,
  ): TaskRecoveryView {
    const overflow = observation.resources.length > MAX_RECOVERY_RESOURCES;
    const boundedObservation = {
      resources: observation.resources.slice(0, MAX_RECOVERY_RESOURCES),
    };
    const resources = boundedObservation.resources.map((resource) => ({
      kind: resource.kind,
      classification: classify(resource),
    }));
    const decision = overflow ? 'fail' : decide(desired, boundedObservation, resources);
    const id = this.randomId();
    return {
      id,
      taskId: desired.task.id,
      desiredState: desired.task.executionState,
      status: decision === 'fail' ? 'attention' : 'ready',
      decision,
      resources,
      attention: decision === 'fail' ? {
        id: this.randomId(),
        reason: 'ambiguous-recovery',
      } : null,
    };
  }

  commit(recovery: TaskRecoveryView): TaskRecoveryDecisionView {
    return {
      id: this.randomId(),
      taskId: recovery.taskId,
      recoveryId: recovery.id,
      decision: recovery.decision,
      status: recovery.decision === 'fail' ? 'attention' : 'decided',
      attention: recovery.attention,
    };
  }
}

function classify(
  observation: ExecutionResourceObservation,
): TaskRecoveryView['resources'][number]['classification'] {
  if (!observation.expected) {
    return observation.state === 'active' || observation.state === 'inactive'
      ? 'orphaned' : observation.state === 'unknown' ? 'unknown' : 'healthy';
  }
  if (observation.state === 'unknown') return 'unknown';
  if (observation.state === 'absent') return 'missing';
  if (observation.copies > 1) return 'duplicated';
  if (observation.state === 'inactive') return 'stale';
  if (observation.identity !== 'matching' || observation.fingerprint !== 'matching') {
    return 'externally-modified';
  }
  return 'healthy';
}

function decide(
  desired: PrivateTaskExecutionView,
  observation: ExecutionRecoveryObservation,
  resources: TaskRecoveryView['resources'],
): TaskRecoveryView['decision'] {
  const classifications = new Set(resources.map((resource) => resource.classification));
  if (hasAmbiguity(classifications)) return 'fail';
  if (classifications.has('orphaned')) {
    return observation.resources
      .filter((resource) => !resource.expected)
      .every((resource) => resource.adoptable) ? 'adopt' : 'fail';
  }
  if (isTerminal(desired.task.executionState)) return 'archive';
  if (missingIsolation(resources)) return 'fail';
  if (classifications.has('missing') || classifications.has('stale')) {
    if (desired.providerSession?.capabilities.resume) return 'resume';
    if (desired.providerSession?.capabilities.fork) return 'fork';
    return 'fail';
  }
  return 'resume';
}

function missingIsolation(resources: TaskRecoveryView['resources']): boolean {
  return resources.some((resource) =>
    (resource.kind === 'worktree' || resource.kind === 'branch') &&
    (resource.classification === 'missing' || resource.classification === 'stale'));
}

function hasAmbiguity(classifications: ReadonlySet<string>): boolean {
  return classifications.has('unknown') ||
    classifications.has('duplicated') ||
    classifications.has('externally-modified');
}

function isTerminal(state: PrivateTaskExecutionView['task']['executionState']): boolean {
  return state === 'completed' || state === 'failed' ||
    state === 'cancelled' || state === 'superseded';
}

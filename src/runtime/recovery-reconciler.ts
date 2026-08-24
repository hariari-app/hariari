import type { TaskRecoveryView } from '../shared/runtime/runtime-interface';
import type {
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
} from './generic-cli-execution-adapter';
import type { PrivateTaskExecutionView } from './task-execution-projection';

/** Central deterministic desired-versus-observed recovery decision table. */
export class RecoveryReconciler {
  constructor(private readonly randomId: () => string) {}

  reconcile(
    desired: PrivateTaskExecutionView,
    observation: ExecutionRecoveryObservation,
  ): TaskRecoveryView {
    const resources = observation.resources.map((resource) => ({
      kind: resource.kind,
      classification: classify(resource),
    }));
    const decision = decide(desired, observation, resources);
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
  if (classifications.has('missing') || classifications.has('stale')) {
    if (desired.providerSession?.capabilities.resume) return 'resume';
    if (desired.providerSession?.capabilities.fork) return 'fork';
    return 'fail';
  }
  return 'resume';
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

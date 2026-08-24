import type { TaskRecoveryView } from '../shared/runtime/runtime-interface';
import type { ExecutionObservation } from './generic-cli-execution-adapter';
import type { PrivateTaskExecutionView } from './task-execution-projection';

/** Central deterministic desired-versus-observed recovery decision table. */
export class RecoveryReconciler {
  constructor(private readonly randomId: () => string) {}

  reconcile(
    desired: PrivateTaskExecutionView,
    observation: ExecutionObservation,
  ): TaskRecoveryView {
    const classification = observation === 'live'
      ? 'healthy'
      : observation === 'lost'
        ? 'stale'
        : 'unknown';
    const recoverable = classification !== 'unknown' &&
      desired.providerSession?.capabilities.resume === true;
    const id = this.randomId();
    return {
      id,
      taskId: desired.task.id,
      desiredState: desired.task.executionState,
      status: recoverable ? 'ready' : 'attention',
      decision: recoverable ? 'resume' : 'fail',
      resources: [{ kind: 'process', classification }],
      attention: recoverable ? null : {
        id: this.randomId(),
        reason: 'ambiguous-recovery',
      },
    };
  }
}

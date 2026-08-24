import type {
  ReconcileTaskRequest,
  RecoverTaskRequest,
  TaskRecoveryDecisionView,
  TaskRecoveryView,
} from '../shared/runtime/runtime-interface';
import type { TaskReconciledEvent, TaskRecoveryDecidedEvent } from './task-events';

type RecoveryFailureCode = 'idempotency-conflict' | 'not-found' | 'internal';
type RecoveryEvent = TaskReconciledEvent | TaskRecoveryDecidedEvent;

interface TaskRecoveryJournalPorts {
  readonly append: (event: RecoveryEvent) => Promise<void>;
  readonly assertWritable: () => void;
  readonly fail: (code: RecoveryFailureCode) => never;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly taskExists: (taskId: string) => boolean;
}

/** Owns the durable idempotency and replay projection for Task recovery commands. */
export class TaskRecoveryJournal {
  private readonly reconciliations = new Map<string, TaskReconciledEvent>();
  private readonly reconciliationsById = new Map<string, TaskReconciledEvent>();
  private readonly decisions = new Map<string, TaskRecoveryDecidedEvent>();

  constructor(private readonly ports: TaskRecoveryJournalPorts) {}

  reconciliation(request: ReconcileTaskRequest): TaskRecoveryView | null {
    this.ports.assertWritable();
    const existing = this.reconciliations.get(request.idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== reconciliationFingerprint(request.taskId)) {
      return this.ports.fail('idempotency-conflict');
    }
    return existing.recovery;
  }

  recordReconciliation(
    request: ReconcileTaskRequest,
    recovery: TaskRecoveryView,
  ): Promise<TaskRecoveryView> {
    return this.ports.serialize(async () => {
      this.ports.assertWritable();
      this.assertTaskExists(request.taskId);
      const existing = this.reconciliations.get(request.idempotencyKey);
      const fingerprint = reconciliationFingerprint(request.taskId);
      if (existing) return this.replayReconciliation(existing, fingerprint);
      if (recovery.taskId !== request.taskId) return this.ports.fail('internal');
      await this.ports.append({
        type: 'TaskReconciled', version: 1, taskId: request.taskId,
        idempotencyKey: request.idempotencyKey, fingerprint, recovery,
      });
      return this.reconciliations.get(request.idempotencyKey)!.recovery;
    });
  }

  recovery(request: RecoverTaskRequest): TaskRecoveryView {
    this.ports.assertWritable();
    const recovery = this.reconciliationsById.get(request.recoveryId);
    if (!recovery || recovery.taskId !== request.taskId) return this.ports.fail('not-found');
    return recovery.recovery;
  }

  decision(request: RecoverTaskRequest): TaskRecoveryDecisionView | null {
    this.ports.assertWritable();
    const existing = this.decisions.get(request.idempotencyKey);
    if (!existing) return null;
    if (existing.fingerprint !== decisionFingerprint(request)) {
      return this.ports.fail('idempotency-conflict');
    }
    return existing.result;
  }

  recordDecision(
    request: RecoverTaskRequest,
    result: TaskRecoveryDecisionView,
  ): Promise<TaskRecoveryDecisionView> {
    return this.ports.serialize(async () => {
      this.ports.assertWritable();
      const recovery = this.recovery(request);
      const existing = this.decisions.get(request.idempotencyKey);
      const fingerprint = decisionFingerprint(request);
      if (existing) return this.replayDecision(existing, fingerprint);
      if (result.taskId !== recovery.taskId || result.recoveryId !== recovery.id ||
        result.decision !== recovery.decision) return this.ports.fail('internal');
      await this.ports.append({
        type: 'TaskRecoveryDecided', version: 1, taskId: recovery.taskId,
        idempotencyKey: request.idempotencyKey, fingerprint, result,
      });
      return this.decisions.get(request.idempotencyKey)!.result;
    });
  }

  replay(event: RecoveryEvent): void {
    if (event.type === 'TaskReconciled') this.applyReconciliation(event);
    else this.applyDecision(event);
  }

  private applyReconciliation(event: TaskReconciledEvent): void {
    if (!this.ports.taskExists(event.taskId) || event.recovery.taskId !== event.taskId) {
      return this.ports.fail('internal');
    }
    const existing = this.reconciliations.get(event.idempotencyKey);
    if (existing && (existing.fingerprint !== event.fingerprint ||
      JSON.stringify(existing.recovery) !== JSON.stringify(event.recovery))) {
      return this.ports.fail('internal');
    }
    this.reconciliations.set(event.idempotencyKey, event);
    const byId = this.reconciliationsById.get(event.recovery.id);
    if (byId && byId.idempotencyKey !== event.idempotencyKey) {
      return this.ports.fail('internal');
    }
    this.reconciliationsById.set(event.recovery.id, event);
  }

  private applyDecision(event: TaskRecoveryDecidedEvent): void {
    const recovery = this.reconciliationsById.get(event.result.recoveryId);
    if (!recovery || recovery.taskId !== event.taskId ||
      recovery.recovery.decision !== event.result.decision) return this.ports.fail('internal');
    const existing = this.decisions.get(event.idempotencyKey);
    if (existing && (existing.fingerprint !== event.fingerprint ||
      JSON.stringify(existing.result) !== JSON.stringify(event.result))) {
      return this.ports.fail('internal');
    }
    this.decisions.set(event.idempotencyKey, event);
  }

  private assertTaskExists(taskId: string): void {
    if (!this.ports.taskExists(taskId)) this.ports.fail('not-found');
  }

  private replayReconciliation(
    existing: TaskReconciledEvent,
    fingerprint: string,
  ): TaskRecoveryView {
    if (existing.fingerprint !== fingerprint) return this.ports.fail('idempotency-conflict');
    return existing.recovery;
  }

  private replayDecision(
    existing: TaskRecoveryDecidedEvent,
    fingerprint: string,
  ): TaskRecoveryDecisionView {
    if (existing.fingerprint !== fingerprint) return this.ports.fail('idempotency-conflict');
    return existing.result;
  }
}

function reconciliationFingerprint(taskId: string): string {
  return JSON.stringify(['reconcile', taskId]);
}

function decisionFingerprint(request: RecoverTaskRequest): string {
  return JSON.stringify(['recover', request.taskId, request.recoveryId]);
}

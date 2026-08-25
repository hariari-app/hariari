export type TaskFailureCode =
  | 'idempotency-conflict'
  | 'not-found'
  | 'task-not-ready'
  | 'event-history-invalid'
  | 'unsupported-operation'
  | 'internal';

export class TaskStorageError extends Error {
  constructor(readonly code: TaskFailureCode) {
    super(`Task storage failed: ${code}`);
    this.name = 'TaskStorageError';
  }
}

import {
  TaskEventHistory,
  TaskEventHistoryError,
} from './task-event-history';
import { TaskStorageError } from './task-storage-error';
import type { TaskEvent } from './task-events';

interface TaskEventHistoryRepairDependencies {
  readonly now: () => string;
  readonly append: (event: TaskEvent) => Promise<void>;
}

/** Executes analyzer repair plans through the canonical durable append seam. */
export class TaskEventHistoryRepair {
  private readonly history = new TaskEventHistory();

  constructor(private readonly dependencies: TaskEventHistoryRepairDependencies) {}

  accept(event: TaskEvent, currentAttemptId: string | null): void {
    try {
      this.history.accept(event, currentAttemptId);
    } catch (error) {
      if (error instanceof TaskEventHistoryError) {
        throw new TaskStorageError('event-history-invalid');
      }
      throw error;
    }
  }

  async repair(taskId: string): Promise<void> {
    return this.repairAll([taskId]);
  }

  async repairAll(taskIds: readonly string[]): Promise<void> {
    try {
      const repairs = this.history.planRepairs(taskIds, this.dependencies.now());
      for (const repair of repairs) await this.dependencies.append(repair);
    } catch (error) {
      if (error instanceof TaskEventHistoryError) {
        throw new TaskStorageError('event-history-invalid');
      }
      throw error;
    }
  }
}

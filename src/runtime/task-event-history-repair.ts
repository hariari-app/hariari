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
    try {
      while (true) {
        const repair = this.history.nextRepair(taskId, this.dependencies.now());
        if (!repair) break;
        await this.dependencies.append(repair);
      }
      this.history.assertComplete(taskId);
    } catch (error) {
      if (error instanceof TaskEventHistoryError) {
        throw new TaskStorageError('event-history-invalid');
      }
      throw error;
    }
  }
}

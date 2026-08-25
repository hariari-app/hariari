import type { TaskEvent } from './task-events';

/** Rejects repeated durable records before any replay projection can absorb them. */
export class TaskEventHistory {
  private readonly records = new Set<string>();

  accept(event: TaskEvent, currentAttemptId: string | null = null): void {
    const record = JSON.stringify([event, isAttemptScopedPhase(event) ? currentAttemptId : null]);
    if (this.records.has(record)) throw new Error('duplicate durable Task event');
    this.records.add(record);
  }
}

function isAttemptScopedPhase(event: TaskEvent): boolean {
  return (
    event.type === 'AttemptStarted' ||
    event.type === 'AttemptCompleted' ||
    event.type === 'AttemptFailed' ||
    event.type === 'AttemptCancelled'
  );
}

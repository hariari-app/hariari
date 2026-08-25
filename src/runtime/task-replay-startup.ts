import { TaskEventStoreError } from './task-event-store';
import { TaskStorageError } from './task-storage-error';

/** Keeps replay semantic failures distinct from physical startup failures. */
export async function startTaskReplay(
  replay: () => Promise<void>,
  finalize: () => Promise<void>,
): Promise<void> {
  try {
    await replay();
  } catch (error) {
    throw replayStartupError(error);
  }
  try {
    await finalize();
  } catch (error) {
    if (error instanceof TaskStorageError) throw error;
    throw new TaskStorageError('event-history-invalid');
  }
}

function replayStartupError(error: unknown): TaskStorageError {
  if (error instanceof TaskStorageError) return new TaskStorageError('event-history-invalid');
  if (error instanceof TaskEventStoreError || isNodeIoError(error)) {
    return new TaskStorageError('internal');
  }
  return new TaskStorageError('event-history-invalid');
}

function isNodeIoError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'syscall' in error &&
    typeof (error as { readonly code?: unknown }).code === 'string' &&
    typeof (error as { readonly syscall?: unknown }).syscall === 'string');
}

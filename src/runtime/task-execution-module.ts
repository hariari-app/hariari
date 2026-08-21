import type {
  CancelTaskRequest,
  StartTaskRequest,
  TaskExecutionView,
  TaskOutputEvent,
} from '../shared/runtime/runtime-interface';
import {
  GenericCliExecutionError,
  type GenericCliExecution,
  type GenericCliExecutionAdapter,
} from './generic-cli-execution-adapter';
import { TaskModule, TaskStorageError } from './task-module';

const MAX_OUTPUT_CHARS = 4 * 1024;

export class TaskExecutionError extends Error {
  constructor(readonly code: 'worktree-unavailable' | 'process-start-failed' | 'internal') {
    super(`Task execution failed: ${code}`);
    this.name = 'TaskExecutionError';
  }
}

/** Runtime-owned execution module: adapter lifecycle, transient output, and durable transitions. */
export class TaskExecutionModule {
  private readonly starts = new Map<string, Promise<TaskExecutionView>>();
  private readonly active = new Map<string, GenericCliExecution>();
  private readonly subscribers = new Map<string, Set<(event: TaskOutputEvent) => void>>();
  private readonly outputSequences = new Map<string, number>();

  constructor(
    private readonly tasks: TaskModule,
    private readonly adapter: GenericCliExecutionAdapter,
    private readonly randomId: () => string,
  ) {}

  async start(request: StartTaskRequest): Promise<TaskExecutionView> {
    const reservation = await this.tasks.reserveExecution(request);
    if (!reservation.created) {
      const start = this.starts.get(request.taskId);
      return start ? start : reservation.execution;
    }
    const start = this.startReserved(request, reservation.execution);
    this.starts.set(request.taskId, start);
    try {
      return await start;
    } finally {
      this.starts.delete(request.taskId);
    }
  }

  async cancel(request: CancelTaskRequest): Promise<TaskExecutionView> {
    const view = await this.tasks.requestCancellation(request);
    if (view.attempt?.state !== 'cancelling') return view;
    const active = this.active.get(request.taskId);
    if (!active) return view;
    try {
      await active.stop();
    } catch {
      await this.tasks.fail(request.taskId).catch(() => undefined);
      throw new TaskExecutionError('internal');
    }
    return this.tasks.execution(request.taskId);
  }

  get(taskId: string): TaskExecutionView {
    return this.tasks.execution(taskId);
  }

  subscribe(taskId: string, listener: (event: TaskOutputEvent) => void): () => void {
    this.tasks.execution(taskId);
    const listeners = this.subscribers.get(taskId) ?? new Set<(event: TaskOutputEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  private async startReserved(
    request: StartTaskRequest,
    execution: TaskExecutionView,
  ): Promise<TaskExecutionView> {
    if (!execution.run || !execution.attempt) throw new TaskExecutionError('internal');
    let active: GenericCliExecution | null = null;
    try {
      active = await this.adapter.start({
        task: execution.task,
        run: execution.run,
        attempt: execution.attempt,
        identities: {
          contextId: this.randomId(),
          worktreeId: this.randomId(),
          processId: this.randomId(),
          ptyId: this.randomId(),
        },
        onOutput: (data) => this.publishOutput(request.taskId, execution.attempt!.id, data),
        onExit: (exitCode) => void this.settle(request.taskId, exitCode),
      });
      this.active.set(request.taskId, active);
      await this.tasks.allocateContext(request.taskId, active.context);
      await this.tasks.markStarted(request.taskId);
      active.activateOutput();
      return this.tasks.execution(request.taskId);
    } catch (error) {
      if (active) {
        await active.stop().catch(() => undefined);
        active.dispose();
        this.active.delete(request.taskId);
      }
      await this.tasks.fail(request.taskId).catch(() => undefined);
      if (error instanceof GenericCliExecutionError) throw new TaskExecutionError(error.code);
      if (error instanceof TaskStorageError) throw new TaskExecutionError('internal');
      throw new TaskExecutionError('internal');
    }
  }

  private async settle(taskId: string, exitCode: number): Promise<void> {
    try {
      await this.persistExit(taskId, exitCode);
    } catch {
      try {
        await this.persistExit(taskId, exitCode);
      } catch {
        // The durable writer is either repaired by the retry or remains poisoned privately.
      }
    } finally {
      const active = this.active.get(taskId);
      active?.dispose();
      this.active.delete(taskId);
    }
  }

  private async persistExit(taskId: string, exitCode: number): Promise<void> {
    const view = this.tasks.execution(taskId);
    if (!view.attempt || isTerminal(view.attempt.state)) return;
    if (view.attempt.state === 'cancelling') await this.tasks.cancel(taskId);
    else if (exitCode === 0) await this.tasks.complete(taskId, exitCode);
    else await this.tasks.fail(taskId);
  }

  private publishOutput(taskId: string, attemptId: string, value: string): void {
    const data = sanitizeOutput(value);
    if (data.length === 0) return;
    const sequence = (this.outputSequences.get(taskId) ?? 0) + 1;
    this.outputSequences.set(taskId, sequence);
    this.publish({ kind: 'data', taskId, attemptId, sequence, data });
    if (data.length < value.length) {
      const droppedSequence = sequence + 1;
      this.outputSequences.set(taskId, droppedSequence);
      this.publish({ kind: 'dropped', taskId, attemptId, sequence: droppedSequence });
    }
  }

  private publish(event: TaskOutputEvent): void {
    for (const listener of this.subscribers.get(event.taskId) ?? []) {
      try {
        listener(event);
      } catch {
        // Output listeners are isolated from the PTY lifecycle.
      }
    }
  }
}

function sanitizeOutput(value: string): string {
  return [...value.slice(0, MAX_OUTPUT_CHARS * 2)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character === '\n' || character === '\r' || character === '\t' || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .slice(0, MAX_OUTPUT_CHARS);
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

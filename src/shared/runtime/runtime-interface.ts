export interface RuntimeProtocolRange {
  readonly min: number;
  readonly max: number;
}

export const RUNTIME_IDENTIFIER_MAX_LENGTH = 128;

export interface RuntimeHealth {
  readonly status: 'ready';
  readonly instanceId: string;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly protocolVersion: number;
  readonly startedAt: string;
  readonly checkedAt: string;
}

export const TASK_PROVIDERS = [
  'claude',
  'gemini',
  'codex',
  'pi',
  'opencode',
  'cline',
  'copilot',
  'amp',
  'continue',
  'cursor',
  'crush',
  'qwen',
  'shell',
] as const;

export type TaskProvider = (typeof TASK_PROVIDERS)[number];

export interface CreateTaskRequest {
  readonly objective: string;
  readonly project: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly provider: TaskProvider;
  readonly idempotencyKey: string;
}

export interface TaskView {
  readonly id: string;
  readonly objective: string;
  readonly project: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly provider: TaskProvider;
  readonly createdAt: string;
}

export type TaskExecutionState =
  | 'ready'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

export interface StartTaskRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
}

export interface CancelTaskRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
}
export interface ResumeClaudeSessionRequest { readonly taskId: string; readonly providerSessionId: string; readonly repository: string; readonly worktreeId: string; readonly branchName: string; readonly idempotencyKey: string; }
export interface ForkClaudeSessionRequest { readonly taskId: string; readonly providerSessionId: string; readonly idempotencyKey: string; }

export interface TaskAttemptView {
  readonly id: string;
  readonly number: number;
  readonly state: TaskExecutionState;
  readonly exitCode?: number;
}

export interface ClaudeProviderSessionView {
  readonly id: string;
  readonly provider: 'claude';
  readonly nativeSessionId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly executionContextId: string;
  readonly capabilities: { readonly resume: boolean; readonly fork: boolean };
  readonly parentId: string | null;
}

export interface TaskExecutionView {
  readonly task: TaskView & { readonly executionState: TaskExecutionState };
  readonly run: { readonly id: string; readonly number: number } | null;
  readonly attempt: TaskAttemptView | null;
  readonly attempts: readonly TaskAttemptView[];
  readonly context:
    | {
        readonly id: string;
        readonly worktreeId: string;
        readonly branchName: string;
        readonly baseCommit: string;
        readonly processId: string;
        readonly ptyId: string;
      }
    | null;
  readonly providerSession?: ClaudeProviderSessionView | null;
  readonly providerSessions: readonly ClaudeProviderSessionView[];
}

export type TaskOutputEvent =
  | {
      readonly kind: 'data';
      readonly taskId: string;
      readonly attemptId: string;
      readonly sequence: number;
      readonly data: string;
    }
  | {
      readonly kind: 'dropped';
      readonly taskId: string;
      readonly attemptId: string;
      readonly sequence: number;
    };

export type RuntimeOperationFailureCode =
  | 'invalid-request'
  | 'unsupported-operation'
  | 'stale-instance'
  | 'idempotency-conflict'
  | 'not-found'
  | 'task-not-ready'
  | 'worktree-unavailable'
  | 'process-start-failed'
  | 'runtime-stopping'
  | 'internal';

export type RuntimeUnavailableReason =
  | 'not-connected'
  | 'client-disconnected'
  | 'credentials-unavailable'
  | 'authentication-rejected'
  | 'artifact-unavailable'
  | 'start-failed'
  | 'startup-timeout'
  | 'connection-failed'
  | 'transport-lost'
  | 'protocol-error'
  | 'health-timeout'
  | 'runtime-stopped'
  | RuntimeOperationFailureCode;

export type RuntimeConnectionState =
  | {
      readonly state: 'connected';
      readonly health: RuntimeHealth;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: RuntimeUnavailableReason;
      readonly retryable: boolean;
    }
  | {
      readonly state: 'incompatible';
      readonly desktopRange: RuntimeProtocolRange;
      readonly runtimeRange: RuntimeProtocolRange;
      readonly runtimeVersion: string;
      readonly buildId: string;
    };

export interface RuntimeShutdownRequest {
  readonly idempotencyKey: string;
  readonly expectedInstanceId: string;
  readonly reason: 'user-request' | 'desktop-update' | 'test';
}

export type RuntimeShutdownResult =
  | {
      readonly state: 'stopped';
      readonly instanceId: string;
    }
  | { readonly state: 'not-running' }
  | Extract<RuntimeConnectionState, { readonly state: 'unavailable' | 'incompatible' }>;

export interface RuntimeInterface {
  connectOrStart(): Promise<RuntimeConnectionState>;
  queryHealth(): Promise<RuntimeConnectionState>;
  subscribeStatus(listener: (state: RuntimeConnectionState) => void): () => void;
  disconnect(): Promise<void>;
  shutdown(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult>;
  createTask(request: CreateTaskRequest): Promise<TaskView>;
  listTasks(): Promise<readonly TaskView[]>;
  startTask(request: StartTaskRequest): Promise<TaskExecutionView>;
  resumeClaudeSession(request: ResumeClaudeSessionRequest): Promise<TaskExecutionView>;
  forkClaudeSession(request: ForkClaudeSessionRequest): Promise<TaskExecutionView>;
  cancelTask(request: CancelTaskRequest): Promise<TaskExecutionView>;
  getTaskExecution(taskId: string): Promise<TaskExecutionView>;
  subscribeTaskOutput(
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
  ): Promise<() => void>;
}

import type { EventTimelineView } from './event-timeline-contract';

export {
  EVENT_REDACTION_FIELDS,
  EVENT_TIMELINE_MESSAGES,
  EVENT_TIMELINE_SCHEMA_VERSION,
  PROVIDER_OBSERVATION_SCHEMA,
  RUNTIME_EVENT_SCHEMA,
} from './event-timeline-contract';
export type {
  EventRedactionMetadata,
  NormalizedRuntimeEventKind,
  NormalizedRuntimeEventView,
  RawProviderObservationView,
  TaskTimelineEntry,
  TaskTimelineMessage,
} from './event-timeline-contract';

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
  | 'cancelled'
  | 'superseding'
  | 'superseded';

export interface StartTaskRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
}

export interface CancelTaskRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
}
export interface ProviderSessionActionRequest {
  readonly taskId: string;
  readonly providerSessionId: string;
  readonly idempotencyKey: string;
}

export interface ReconcileTaskRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
}

export interface RecoverTaskRequest {
  readonly taskId: string;
  readonly recoveryId: string;
  readonly idempotencyKey: string;
}

export const RECOVERY_RESOURCE_KINDS = [
  'provider-session', 'process', 'pty', 'worktree', 'branch',
] as const;
export type RecoveryResourceKind = (typeof RECOVERY_RESOURCE_KINDS)[number];

export const RECOVERY_CLASSIFICATIONS = [
  'healthy', 'stale', 'missing', 'duplicated', 'externally-modified',
  'orphaned', 'unknown',
] as const;
export type RecoveryClassification = (typeof RECOVERY_CLASSIFICATIONS)[number];

export const RECOVERY_DECISIONS = ['resume', 'fork', 'adopt', 'archive', 'fail'] as const;
export type RecoveryDecision = (typeof RECOVERY_DECISIONS)[number];
export const RECOVERY_ATTENTION_REASON = 'ambiguous-recovery' as const;

export function isRecoveryResourceKind(value: unknown): value is RecoveryResourceKind {
  return typeof value === 'string' && RECOVERY_RESOURCE_KINDS.some((kind) => kind === value);
}

export function isRecoveryClassification(value: unknown): value is RecoveryClassification {
  return typeof value === 'string' &&
    RECOVERY_CLASSIFICATIONS.some((classification) => classification === value);
}

export function isRecoveryDecision(value: unknown): value is RecoveryDecision {
  return typeof value === 'string' && RECOVERY_DECISIONS.some((decision) => decision === value);
}

export function recoveryNeedsAttention(decision: RecoveryDecision): boolean {
  return decision === 'fail';
}

export interface TaskRecoveryView {
  readonly id: string;
  readonly taskId: string;
  readonly desiredState: TaskExecutionState;
  readonly status: 'ready' | 'attention';
  readonly decision: RecoveryDecision;
  readonly resources: readonly {
    readonly kind: RecoveryResourceKind;
    readonly classification: RecoveryClassification;
  }[];
  readonly attention: {
    readonly id: string;
    readonly reason: typeof RECOVERY_ATTENTION_REASON;
  } | null;
}

export interface TaskRecoveryDecisionView {
  readonly id: string;
  readonly taskId: string;
  readonly recoveryId: string;
  readonly decision: RecoveryDecision;
  readonly status: 'decided' | 'attention';
  readonly attention: TaskRecoveryView['attention'];
}

export interface TaskAttemptView {
  readonly id: string;
  readonly number: number;
  readonly state: TaskExecutionState;
  readonly exitCode?: number;
}

export interface ProviderSessionCapabilities {
  readonly resume: boolean;
  readonly fork: boolean;
}

export interface ExecutionContextView {
  readonly id: string;
  readonly worktreeId: string;
  readonly branchName: string;
  readonly baseCommit: string;
}

export interface ProviderSessionView {
  readonly id: string;
  readonly provider: TaskProvider;
  readonly attemptId: string;
  readonly executionContextId: string;
  readonly capabilities: ProviderSessionCapabilities;
  readonly parentId: string | null;
  readonly lineage: 'new' | 'native-resume' | 'fork';
}

export interface TaskExecutionView {
  readonly task: TaskView & { readonly executionState: TaskExecutionState };
  readonly run: { readonly id: string; readonly number: number } | null;
  readonly attempt: TaskAttemptView | null;
  readonly attempts: readonly TaskAttemptView[];
  readonly context: ExecutionContextView | null;
  readonly executionContexts: readonly ExecutionContextView[];
  readonly providerSession?: ProviderSessionView | null;
  readonly providerSessions: readonly ProviderSessionView[];
}

export type TaskTimelineView = EventTimelineView<TaskExecutionView>;

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
  | 'event-history-invalid'
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
  resumeProviderSession(request: ProviderSessionActionRequest): Promise<TaskExecutionView>;
  forkProviderSession(request: ProviderSessionActionRequest): Promise<TaskExecutionView>;
  reconcileTask(request: ReconcileTaskRequest): Promise<TaskRecoveryView>;
  recoverTask(request: RecoverTaskRequest): Promise<TaskRecoveryDecisionView>;
  cancelTask(request: CancelTaskRequest): Promise<TaskExecutionView>;
  getTaskExecution(taskId: string): Promise<TaskExecutionView>;
  getTaskTimeline(taskId: string): Promise<TaskTimelineView>;
  subscribeTaskOutput(
    taskId: string,
    listener: (event: TaskOutputEvent) => void,
  ): Promise<() => void>;
}

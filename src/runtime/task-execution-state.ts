import type { TaskExecutionView } from '../shared/runtime/runtime-interface';
import type {
  StoredAttempt,
  StoredContext,
  StoredProviderSession,
  StoredRun,
} from './task-events';

export interface StoredExecution {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly currentOperationKey: string;
  readonly run: StoredRun;
  readonly attempt: StoredAttempt | null;
  readonly attempts: readonly StoredAttempt[];
  readonly context: StoredContext | null;
  readonly executionContexts: readonly StoredContext[];
  readonly providerSession: StoredProviderSession | null;
  readonly providerSessions: readonly StoredProviderSession[];
  readonly supersession: {
    readonly actionKey: string;
    readonly reason: 'native-resume' | 'fork';
    readonly parentAttemptId: string;
    readonly parentSessionId: string;
  } | null;
  readonly plannedAction: {
    readonly kind: 'native-resume' | 'fork';
    readonly actionKey: string;
    readonly sourceAttemptId: string;
    readonly sourceSessionId: string;
    readonly plannedContext: StoredContext;
  } | null;
  readonly cancellation: { readonly idempotencyKey: string; readonly fingerprint: string } | null;
}

export interface ExecutionReservation {
  readonly execution: TaskExecutionView; readonly created: boolean;
  readonly providerRepair?: PlannedProviderRepair;
}

export interface PlannedProviderRepair {
  readonly kind: 'native-resume' | 'fork'; readonly parentContext: StoredContext;
  readonly parentSession: StoredProviderSession; readonly plannedContext: StoredContext;
}

export type ProviderActionRepair = {
  readonly execution: TaskExecutionView;
  readonly repair: PlannedProviderRepair | null;
};

export interface NativeResumeReservation extends PlannedProviderRepair {
  readonly execution: TaskExecutionView;
}

export type ProviderForkReservation = NativeResumeReservation;

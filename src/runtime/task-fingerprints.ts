import type { CreateTaskRequest } from '../shared/runtime/runtime-interface';

export function canonicalTaskFingerprint(request: CreateTaskRequest): string {
  return JSON.stringify([
    request.objective,
    request.project,
    request.repository,
    request.baseRef,
    request.provider,
  ]);
}

export function canonicalExecutionFingerprint(taskId: string): string {
  return JSON.stringify([taskId]);
}

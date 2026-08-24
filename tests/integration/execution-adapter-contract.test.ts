import { describe, expect, it } from 'vitest';
import type { TaskView } from '../../src/shared/runtime/runtime-interface';
import type {
  ExecutionAdapter,
  ExecutionLaunchPlan,
  PrivateExecutionBinding,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  FakeClaudeCodeExecutionAdapter,
  FakeGenericCliExecutionAdapter,
} from './runtime-test-fakes';

const CONTRACT_ADAPTERS = [
  { name: 'in-memory shell', provider: 'shell' as const,
    create: () => new FakeGenericCliExecutionAdapter(), capabilities: { resume: false, fork: false } },
  { name: 'Claude-like', provider: 'claude' as const,
    create: () => new FakeClaudeCodeExecutionAdapter(), capabilities: { resume: true, fork: true } },
];

describe.each(CONTRACT_ADAPTERS)('$name execution adapter contract', (entry) => {
  it('discovers capabilities and observes exact live, lost, and unknown bindings', async () => {
    const adapter = entry.create();
    const plan = newPlan(entry.provider);
    expect(await adapter.capabilities(plan.plannedContext.task)).toEqual(entry.capabilities);
    const active = await adapter.launch(plan);
    expect(active.context).toMatchObject({
      id: plan.plannedContext.identities.contextId,
      worktreeId: plan.plannedContext.identities.worktreeId,
      processId: plan.plannedContext.identities.processId,
      ptyId: plan.plannedContext.identities.ptyId,
    });
    expect(active.providerSession?.capabilities ?? { resume: false, fork: false })
      .toEqual(entry.capabilities);
    const binding = bindingFor(plan, active);
    await expect(adapter.observe(binding)).resolves.toBe('live');
    adapter.lose(plan.plannedContext.task.id);
    await expect(adapter.observe(binding)).resolves.toBe('lost');
    await expect(adapter.observe({ ...binding, context: { ...binding.context, id: 'unknown' } }))
      .resolves.toBe('unknown');
  });
});

function newPlan(provider: TaskView['provider']): Extract<ExecutionLaunchPlan, { kind: 'new' }> {
  const task: TaskView = {
    id: `contract-${provider}`, objective: 'Exercise the adapter contract.',
    project: 'Hariari', repository: 'fake-checkout', baseRef: 'main', provider,
    createdAt: '2026-08-24T10:00:00.000Z',
  };
  return {
    kind: 'new',
    nativeSessionId: provider === 'claude' ? '00000000-0000-4000-8000-000000000001' : null,
    plannedContext: {
      task, run: { id: 'run-1', number: 1 }, attempt: { id: 'attempt-1', number: 1 },
      identities: { contextId: 'context-1', worktreeId: 'worktree-1',
        processId: 'process-1', ptyId: 'pty-1' },
      onOutput: () => undefined, onExit: () => undefined,
    },
  };
}

function bindingFor(
  plan: Extract<ExecutionLaunchPlan, { kind: 'new' }>,
  active: Awaited<ReturnType<ExecutionAdapter['launch']>>,
): PrivateExecutionBinding {
  return {
    task: plan.plannedContext.task,
    run: plan.plannedContext.run,
    attempt: plan.plannedContext.attempt,
    context: active.context,
    providerSession: active.providerSession && {
      id: 'provider-session-1', provider: plan.plannedContext.task.provider,
      nativeSessionId: active.providerSession.nativeSessionId,
      taskId: plan.plannedContext.task.id, attemptId: plan.plannedContext.attempt.id,
      executionContextId: active.context.id, capabilities: active.providerSession.capabilities,
      parentId: null, lineage: 'new',
      context: active.context,
    },
  };
}

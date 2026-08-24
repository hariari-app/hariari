import {
  GenericCliExecutionError,
  type ActiveExecution,
  type ExecutionAdapter,
  type ExecutionLaunchPlan,
  type ExecutionObservation,
  type ExecutionRecoveryObservation,
  type PrivateExecutionBinding,
} from './generic-cli-execution-adapter';
import type { ProviderSessionCapabilities, TaskView } from '../shared/runtime/runtime-interface';

export interface ProviderExecutionAdapters {
  readonly shell: ExecutionAdapter;
  readonly claude: ExecutionAdapter;
}

/** Routes the two concrete provider adapters without inventing provider-generic session semantics. */
export class ProviderExecutionAdapterRouter implements ExecutionAdapter {
  constructor(private readonly adapters: ProviderExecutionAdapters) {}

  capabilities(task: TaskView): Promise<ProviderSessionCapabilities> {
    return this.adapterFor(task.provider).capabilities(task);
  }

  observe(binding: PrivateExecutionBinding): Promise<ExecutionObservation> {
    return this.adapterFor(binding.task.provider).observe(binding);
  }

  observeRecovery(binding: PrivateExecutionBinding): Promise<ExecutionRecoveryObservation> {
    return this.adapterFor(binding.task.provider).observeRecovery(binding);
  }

  launch(plan: ExecutionLaunchPlan): Promise<ActiveExecution> {
    return this.adapterFor(plan.plannedContext.task.provider).launch(plan);
  }

  private adapterFor(provider: TaskView['provider']): ExecutionAdapter {
    if (provider === 'shell') return this.adapters.shell;
    if (provider === 'claude') return this.adapters.claude;
    throw new GenericCliExecutionError('process-start-failed');
  }
}

import {
  GenericCliExecutionError,
  type ActiveExecution,
  type ExecutionAdapter,
  type ExecutionStartRequest,
} from './generic-cli-execution-adapter';

export interface ProviderExecutionAdapters {
  readonly shell: ExecutionAdapter;
  readonly claude: ExecutionAdapter;
}

/** Routes the two concrete provider adapters without inventing provider-generic session semantics. */
export class ProviderExecutionAdapterRouter implements ExecutionAdapter {
  constructor(private readonly adapters: ProviderExecutionAdapters) {}

  start(request: ExecutionStartRequest): Promise<ActiveExecution> {
    if (request.task.provider === 'shell') return this.adapters.shell.start(request);
    if (request.task.provider === 'claude') return this.adapters.claude.start(request);
    throw new GenericCliExecutionError('process-start-failed');
  }
}

import { resolveRuntimeEndpoint, type RuntimeEndpointOptions } from '../../runtime/endpoint';
import type { RuntimeEndpointPort } from './runtime-ports';

export class LocalRuntimeEndpointPort implements RuntimeEndpointPort {
  constructor(
    private readonly runtimeDirectory: string,
    private readonly options: RuntimeEndpointOptions = {},
  ) {}

  async resolve() {
    return resolveRuntimeEndpoint(this.runtimeDirectory, this.options);
  }
}

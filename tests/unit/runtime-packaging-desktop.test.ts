import { describe, expect, it, vi } from 'vitest';
import { createDesktopRuntimeInterface } from '../../src/main/runtime/desktop-runtime';
import { FakeRuntimeEnvironment } from '../integration/runtime-test-fakes';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/workspace',
    getVersion: () => '0.6.8',
    isPackaged: false,
  },
}));

describe('Desktop Runtime composition', () => {
  it('provides deterministic port injection without changing the public interface', async () => {
    const environment = new FakeRuntimeEnvironment();

    const runtime = createDesktopRuntimeInterface({
      runtimeVersion: '0.6.8',
      clients: environment.clients,
      endpoints: environment.endpoints,
      tokens: environment.tokens,
      processes: environment.processes,
      leases: environment.leases,
      artifacts: environment.artifacts,
      now: environment.now,
      delay: environment.delay,
    });

    await expect(runtime.connectOrStart()).resolves.toMatchObject({
      state: 'connected',
      health: { buildId: 'build-19' },
    });
    expect(environment.launchCount).toBe(1);
  });
});

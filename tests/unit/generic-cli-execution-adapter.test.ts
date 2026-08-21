import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalGenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';
import {
  createDisposableGitRepository,
  type DisposableGitRepository,
} from '../test-common/disposable-git-repository';

const repositories: DisposableGitRepository[] = [];

describe('Local Generic CLI execution adapter', () => {
  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.dispose();
  });

  it('owns one idempotent PTY stop and settles only after node-pty reports exit', async () => {
    const repository = createRepository();
    const pty = new FakePty();
    const adapter = new LocalGenericCliExecutionAdapter({
      runtimeDirectory: path.join(repository.path, 'runtime'),
      pty: { spawn: () => pty },
    });
    const execution = await adapter.start(startRequest(repository.path));
    let settled = false;
    const firstStop = execution.stop().then(() => {
      settled = true;
    });
    const secondStop = execution.stop();

    expect(pty.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);

    pty.exit(143);
    await Promise.all([firstStop, secondStop]);

    expect(settled).toBe(true);
    expect(pty.kill).toHaveBeenCalledOnce();
  });
});

function createRepository(): DisposableGitRepository {
  const repository = createDisposableGitRepository({
    temporaryPrefix: 'hariari-generic-cli-adapter-',
    readmeContents: '# Generic CLI adapter\n',
    commitMessage: 'fixture',
    authorName: 'Runtime Test',
    authorEmail: 'runtime@example.test',
  });
  repositories.push(repository);
  return repository;
}

function startRequest(repository: string) {
  return {
    task: {
      id: 'task-1',
      objective: 'Exercise PTY cancellation.',
      project: 'Hariari',
      repository,
      baseRef: 'HEAD',
      provider: 'shell' as const,
      createdAt: '2026-08-21T10:00:00.000Z',
    },
    run: { id: 'run-1', number: 1 },
    attempt: { id: 'attempt-1', number: 1 },
    identities: {
      contextId: 'context-1',
      worktreeId: 'worktree-1',
      processId: 'process-1',
      ptyId: 'pty-1',
    },
    onOutput: () => undefined,
    onExit: () => undefined,
  };
}

class FakePty {
  readonly pid = 42;
  readonly kill = vi.fn();
  private exitListener: ((event: { readonly exitCode: number }) => void) | null = null;

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onExit(listener: (event: { readonly exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener;
    return { dispose: () => undefined };
  }

  exit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

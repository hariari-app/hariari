import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalGenericCliExecutionAdapter } from '../../src/runtime/generic-cli-execution-adapter';

const directories: string[] = [];

describe('Local Generic CLI execution adapter', () => {
  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  it('owns one idempotent PTY stop and settles only after node-pty reports exit', async () => {
    const repository = createRepository();
    const pty = new FakePty();
    const adapter = new LocalGenericCliExecutionAdapter({
      runtimeDirectory: path.join(repository, 'runtime'),
      pty: { spawn: () => pty },
    });
    const execution = await adapter.start(startRequest(repository));
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

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-generic-cli-adapter-'));
  directories.push(root);
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'runtime@example.test'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), '# Generic CLI adapter\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'pipe' });
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

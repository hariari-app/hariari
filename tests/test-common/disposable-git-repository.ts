import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DisposableGitRepositoryOptions {
  readonly temporaryPrefix: string;
  readonly readmeContents: string;
  readonly commitMessage: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface DisposableGitRepository {
  readonly root: string;
  readonly path: string;
  readonly baseCommit: string;
  dispose(): void;
}

export function createDisposableGitRepository(
  options: DisposableGitRepositoryOptions,
): DisposableGitRepository {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.temporaryPrefix));
  const repository = path.join(root, 'repository');
  try {
    fs.mkdirSync(repository);
    const baseCommit = initializeRepository(repository, options);
    return {
      root,
      path: repository,
      baseCommit,
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function initializeRepository(repository: string, options: DisposableGitRepositoryOptions): string {
  execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', options.authorEmail], {
    cwd: repository,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', options.authorName], {
    cwd: repository,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(repository, 'README.md'), options.readmeContents);
  execFileSync('git', ['add', 'README.md'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', options.commitMessage], {
    cwd: repository,
    stdio: 'pipe',
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

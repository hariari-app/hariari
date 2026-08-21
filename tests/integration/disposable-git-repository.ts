import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DisposableGitRepositoryOptions {
  readonly roots: string[];
  readonly temporaryPrefix: string;
  readonly readmeContents: string;
  readonly commitMessage: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

export function createDisposableGitRepository(options: DisposableGitRepositoryOptions): {
  readonly path: string;
  readonly baseCommit: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.temporaryPrefix));
  options.roots.push(root);
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
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
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  return { path: repository, baseCommit };
}

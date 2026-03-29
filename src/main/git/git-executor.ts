import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

export function isGitRepo(projectPath: string): boolean {
  try {
    return fs.existsSync(path.join(projectPath, '.git'));
  } catch {
    return false;
  }
}

export function runGit(projectPath: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: projectPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024, // 5MB
        encoding: 'utf-8',
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error ? (error as { code: number }).code : 0;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
        });
      },
    );
  });
}

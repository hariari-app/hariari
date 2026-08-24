import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
  PrivateExecutionBinding,
} from './generic-cli-execution-adapter';

/** Reads local Git/filesystem facts without granting recovery mutation authority. */
export async function observeLocalRecovery(
  binding: PrivateExecutionBinding,
  baseline: ExecutionRecoveryObservation,
  worktreeRoot: string,
): Promise<ExecutionRecoveryObservation> {
  const worktreePath = path.join(worktreeRoot, binding.context.worktreeId);
  const worktree = await observeWorktree(worktreePath);
  const branch = await observeBranch(binding, worktreePath, worktree.state === 'active');
  const orphans = await observeOrphanBranches(binding);
  return {
    resources: [...baseline.resources.map((resource) => {
      if (resource.kind === 'worktree') return worktree;
      if (resource.kind === 'branch') return branch;
      return resource;
    }), ...orphans],
  };
}

async function observeOrphanBranches(
  binding: PrivateExecutionBinding,
): Promise<readonly ExecutionResourceObservation[]> {
  const prefix = `hariari/task-${binding.task.id}/`;
  const branches = await git(binding.task.repository, [
    'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`,
  ]);
  if (!branches.ok || branches.stdout.length === 0) return [];
  return branches.stdout.split('\n')
    .filter((branch) => branch !== binding.context.branchName)
    .slice(0, 15)
    .map(() => ({ ...healthy('branch'), expected: false }));
}

async function observeWorktree(worktreePath: string): Promise<ExecutionResourceObservation> {
  try {
    const stats = await fs.promises.lstat(worktreePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return changed('worktree');
    const root = await git(worktreePath, ['rev-parse', '--show-toplevel']);
    if (!root.ok) return unknown('worktree');
    const expected = await fs.promises.realpath(worktreePath);
    const observed = await fs.promises.realpath(root.stdout);
    return observed === expected ? healthy('worktree') : changed('worktree');
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? missing('worktree') : unknown('worktree');
  }
}

async function observeBranch(
  binding: PrivateExecutionBinding,
  worktreePath: string,
  worktreePresent: boolean,
): Promise<ExecutionResourceObservation> {
  const reference = `refs/heads/${binding.context.branchName}`;
  if (!worktreePresent) return observeRepositoryBranch(binding, reference);
  const branch = await git(worktreePath, ['branch', '--show-current']);
  if (!branch.ok || branch.stdout.length === 0) return unknown('branch');
  const ancestry = await git(worktreePath, [
    'merge-base', '--is-ancestor', binding.context.baseCommit, 'HEAD',
  ]);
  return {
    ...healthy('branch'),
    identity: branch.stdout === binding.context.branchName ? 'matching' : 'different',
    fingerprint: ancestry.ok ? 'matching' : 'changed',
  };
}

async function observeRepositoryBranch(
  binding: PrivateExecutionBinding,
  reference: string,
): Promise<ExecutionResourceObservation> {
  const branch = await git(binding.task.repository, ['show-ref', '--verify', reference]);
  if (!branch.ok) return missing('branch');
  const ancestry = await git(binding.task.repository, [
    'merge-base', '--is-ancestor', binding.context.baseCommit, reference,
  ]);
  return { ...healthy('branch'), fingerprint: ancestry.ok ? 'matching' : 'changed' };
}

function git(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      resolve({ ok: error === null, stdout: stdout.trim() });
    });
  });
}

function healthy(kind: 'worktree' | 'branch'): ExecutionResourceObservation {
  return { kind, expected: true, state: 'active', identity: 'matching',
    fingerprint: 'matching', copies: 1, adoptable: false };
}

function changed(kind: 'worktree' | 'branch'): ExecutionResourceObservation {
  return { ...healthy(kind), identity: 'different' };
}

function missing(kind: 'worktree' | 'branch'): ExecutionResourceObservation {
  return { kind, expected: true, state: 'absent', identity: 'matching',
    fingerprint: 'matching', copies: 0, adoptable: false };
}

function unknown(kind: 'worktree' | 'branch'): ExecutionResourceObservation {
  return { kind, expected: true, state: 'unknown', identity: 'unknown',
    fingerprint: 'unknown', copies: 0, adoptable: false };
}

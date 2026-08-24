import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
  PrivateExecutionBinding,
} from './generic-cli-execution-adapter';
import { observeRecoveryOwnership } from './local-recovery-markers';

/** Reads local Git/filesystem facts without granting recovery mutation authority. */
export async function observeLocalRecovery(
  binding: PrivateExecutionBinding,
  baseline: ExecutionRecoveryObservation,
  worktreeRoot: string,
): Promise<ExecutionRecoveryObservation> {
  const worktreePath = path.join(worktreeRoot, binding.context.worktreeId);
  const worktree = await observeWorktree(worktreePath);
  const branch = await observeBranch(binding, worktreePath, worktree.state === 'active');
  const ownership = await observeRecoveryOwnership(path.dirname(worktreeRoot), binding, baseline);
  const orphanWorktrees = await observeOrphanWorktrees(binding, worktreeRoot);
  const adoptableBranches = new Set(
    orphanWorktrees.flatMap((orphan) => orphan.branchName ? [orphan.branchName] : []),
  );
  const orphanBranches = await observeOrphanBranches(binding, adoptableBranches);
  return {
    resources: [...ownership.resources.map((resource) => {
      if (resource.kind === 'worktree') return worktree;
      if (resource.kind === 'branch') return branch;
      return resource;
    }), ...orphanWorktrees.map((orphan) => orphan.resource), ...orphanBranches],
  };
}

async function observeOrphanBranches(
  binding: PrivateExecutionBinding,
  adoptableBranches: ReadonlySet<string>,
): Promise<readonly ExecutionResourceObservation[]> {
  const prefix = `hariari/task-${binding.task.id}/`;
  const branches = await git(binding.task.repository, [
    'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`,
  ]);
  if (!branches.ok) return [unknown('branch', false)];
  if (branches.stdout.length === 0) return [];
  return Promise.all(branches.stdout.split('\n')
    .filter((candidate) => candidate !== binding.context.branchName)
    .slice(0, 16)
    .map(async (candidate) => {
      const ancestry = await git(binding.task.repository, [
        'merge-base', '--is-ancestor', binding.context.baseCommit, candidate,
      ]);
      return { ...healthy('branch'), expected: false,
        fingerprint: ancestry.ok ? 'matching' as const : 'changed' as const,
        adoptable: ancestry.ok && adoptableBranches.has(candidate) };
    }));
}

interface OrphanWorktreeObservation {
  readonly branchName: string | null;
  readonly resource: ExecutionResourceObservation;
}

async function observeOrphanWorktrees(
  binding: PrivateExecutionBinding,
  worktreeRoot: string,
): Promise<readonly OrphanWorktreeObservation[]> {
  let entries: readonly fs.Dirent[];
  try {
    entries = await fs.promises.readdir(worktreeRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
    return [{ branchName: null, resource: unknown('worktree', false) }];
  }
  return Promise.all(entries
    .filter((entry) => entry.name !== binding.context.worktreeId)
    .slice(0, 16)
    .map((entry) => observeOrphanWorktree(binding, worktreeRoot, entry)));
}

async function observeOrphanWorktree(
  binding: PrivateExecutionBinding,
  worktreeRoot: string,
  entry: fs.Dirent,
): Promise<OrphanWorktreeObservation> {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return { branchName: null, resource: unknown('worktree', false) };
  }
  const candidatePath = path.join(worktreeRoot, entry.name);
  const root = await git(candidatePath, ['rev-parse', '--show-toplevel']);
  const branch = await git(candidatePath, ['branch', '--show-current']);
  const ancestry = await git(candidatePath, [
    'merge-base', '--is-ancestor', binding.context.baseCommit, 'HEAD',
  ]);
  const expectedPrefix = `hariari/task-${binding.task.id}/`;
  const safe = root.ok && branch.ok && ancestry.ok && branch.stdout.startsWith(expectedPrefix) &&
    await sameRealPath(candidatePath, root.stdout);
  if (!safe) return { branchName: null, resource: unknown('worktree', false) };
  return {
    branchName: branch.stdout,
    resource: { ...healthy('worktree'), expected: false, adoptable: true },
  };
}

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return await fs.promises.realpath(left) === await fs.promises.realpath(right);
  } catch {
    return false;
  }
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

function unknown(
  kind: 'worktree' | 'branch',
  expected = true,
): ExecutionResourceObservation {
  return { kind, expected, state: 'unknown', identity: 'unknown',
    fingerprint: 'unknown', copies: 0, adoptable: false };
}

import fs from 'node:fs';
import path from 'node:path';
import { isGitRepo, runGit } from './git-executor';
import type { GitFileChange, GitStatusResult, GitDiffResult, GitStageGroup, GitFileStatus, GitLogEntry, GitLogResult, GitAheadBehind } from '../../shared/git-types';

function parseStatusLine(line: string): GitFileChange | null {
  if (line.length < 4) return null;

  const index = line[0];  // staged status
  const worktree = line[1]; // unstaged status
  const filePath = line.slice(3).trim();

  if (!filePath) return null;

  // Handle renames: "R  old -> new"
  let finalPath = filePath;
  let oldPath: string | undefined;
  const renameMatch = filePath.match(/^(.+) -> (.+)$/);
  if (renameMatch) {
    oldPath = renameMatch[1];
    finalPath = renameMatch[2];
  }

  // Staged changes
  if (index !== ' ' && index !== '?') {
    const status = mapStatus(index);
    if (status) {
      return { path: finalPath, status, group: 'staged', oldPath };
    }
  }

  // Unstaged changes
  if (worktree !== ' ' && worktree !== '?') {
    const status = mapStatus(worktree);
    if (status) {
      return { path: finalPath, status, group: 'unstaged', oldPath };
    }
  }

  // Untracked
  if (index === '?' && worktree === '?') {
    return { path: finalPath, status: 'untracked', group: 'untracked' };
  }

  return null;
}

function mapStatus(code: string): GitFileStatus | null {
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'added'; // copied
    default: return null;
  }
}

export async function getGitStatus(projectPath: string): Promise<GitStatusResult> {
  if (!isGitRepo(projectPath)) {
    return { changes: [], branch: '', isRepo: false };
  }

  const [statusResult, branchResult] = await Promise.all([
    runGit(projectPath, ['status', '--porcelain=v1', '-uall']),
    runGit(projectPath, ['branch', '--show-current']),
  ]);

  const changes: GitFileChange[] = [];
  const seenPaths = new Map<string, GitFileChange>();

  for (const line of statusResult.stdout.split('\n')) {
    if (!line) continue;

    const index = line[0];
    const worktree = line[1];
    const filePath = line.slice(3).trim();
    if (!filePath) continue;

    let finalPath = filePath;
    let oldPath: string | undefined;
    const renameMatch = filePath.match(/^(.+) -> (.+)$/);
    if (renameMatch) {
      oldPath = renameMatch[1];
      finalPath = renameMatch[2];
    }

    // Staged change
    if (index !== ' ' && index !== '?') {
      const status = mapStatus(index);
      if (status) {
        changes.push({ path: finalPath, status, group: 'staged', oldPath });
      }
    }

    // Unstaged change
    if (worktree !== ' ' && worktree !== '?') {
      const status = mapStatus(worktree);
      if (status) {
        changes.push({ path: finalPath, status, group: 'unstaged', oldPath });
      }
    }

    // Untracked
    if (index === '?' && worktree === '?') {
      changes.push({ path: finalPath, status: 'untracked', group: 'untracked' });
    }
  }

  return {
    changes,
    branch: branchResult.stdout.trim(),
    isRepo: true,
  };
}

export async function getGitDiff(
  projectPath: string,
  filePath: string,
  group: GitStageGroup,
): Promise<GitDiffResult> {
  const fullPath = path.join(projectPath, filePath);
  const result: GitDiffResult = {
    originalContent: '',
    modifiedContent: '',
    filePath,
    isNewFile: false,
    isDeleted: false,
    isBinary: false,
  };

  if (group === 'untracked') {
    // New untracked file — show all content as added
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (isBinaryContent(content)) {
        return { ...result, isBinary: true };
      }
      return { ...result, modifiedContent: content, isNewFile: true };
    } catch {
      return result;
    }
  }

  // Get original content from HEAD
  const headResult = await runGit(projectPath, ['show', `HEAD:${filePath}`]);
  const originalContent = headResult.exitCode === 0 ? headResult.stdout : '';
  const isNewFile = headResult.exitCode !== 0;

  let modifiedContent: string;

  if (group === 'staged') {
    // Staged: compare HEAD vs index
    const indexResult = await runGit(projectPath, ['show', `:${filePath}`]);
    modifiedContent = indexResult.exitCode === 0 ? indexResult.stdout : '';
  } else {
    // Unstaged: compare HEAD vs working tree
    try {
      modifiedContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      // File deleted in working tree
      return { ...result, originalContent, isDeleted: true };
    }
  }

  if (isBinaryContent(originalContent) || isBinaryContent(modifiedContent)) {
    return { ...result, isBinary: true };
  }

  return {
    originalContent,
    modifiedContent,
    filePath,
    isNewFile,
    isDeleted: false,
    isBinary: false,
  };
}

export async function getFileAtRef(
  projectPath: string,
  filePath: string,
  ref: string,
): Promise<string> {
  const result = await runGit(projectPath, ['show', `${ref}:${filePath}`]);
  return result.exitCode === 0 ? result.stdout : '';
}

function isBinaryContent(content: string): boolean {
  const check = content.slice(0, 8192);
  return check.includes('\0');
}

export async function gitUnstage(projectPath: string, filePath: string): Promise<{ success: boolean; error?: string }> {
  const result = await runGit(projectPath, ['reset', 'HEAD', '--', filePath]);
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr };
}

export async function gitStageAll(projectPath: string): Promise<{ success: boolean; error?: string }> {
  const result = await runGit(projectPath, ['add', '-A']);
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr };
}

export async function gitUnstageAll(projectPath: string): Promise<{ success: boolean; error?: string }> {
  const result = await runGit(projectPath, ['reset', 'HEAD']);
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr };
}

export async function gitDiscardAll(projectPath: string): Promise<{ success: boolean; error?: string }> {
  const result = await runGit(projectPath, ['checkout', '--', '.']);
  return result.exitCode === 0 ? { success: true } : { success: false, error: result.stderr };
}

export async function gitCommit(
  projectPath: string,
  message: string,
  amend: boolean = false,
): Promise<{ success: boolean; hash?: string; error?: string }> {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  const result = await runGit(projectPath, args);
  if (result.exitCode !== 0) return { success: false, error: result.stderr };
  const hashMatch = result.stdout.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
  return { success: true, hash: hashMatch?.[1] };
}

export async function getGitLog(projectPath: string, maxCount: number = 50): Promise<GitLogResult> {
  if (!isGitRepo(projectPath)) return { entries: [], branchName: '' };

  const format = '%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x00%D';
  const [logResult, branchResult] = await Promise.all([
    runGit(projectPath, ['log', '--all', `--max-count=${maxCount}`, `--format=${format}`]),
    runGit(projectPath, ['branch', '--show-current']),
  ]);

  const entries: GitLogEntry[] = [];
  for (const line of logResult.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\0');
    if (parts.length < 7) continue;
    entries.push({
      hash: parts[0],
      shortHash: parts[1],
      message: parts[2],
      author: parts[3],
      date: parts[4],
      parentHashes: parts[5] ? parts[5].split(' ').filter(Boolean) : [],
      refs: parts[6] ? parts[6].split(', ').filter(Boolean).map((r) => r.replace(/^HEAD -> /, '')) : [],
    });
  }

  return { entries, branchName: branchResult.stdout.trim() };
}

export async function gitPull(projectPath: string): Promise<{ success: boolean; output?: string; error?: string }> {
  // Use longer timeout for network operations
  const result = await runGit(projectPath, ['pull']);
  return result.exitCode === 0
    ? { success: true, output: result.stdout }
    : { success: false, error: result.stderr || result.stdout };
}

export async function gitPush(projectPath: string, setUpstream: boolean = false): Promise<{ success: boolean; error?: string }> {
  const args = ['push'];
  if (setUpstream) {
    const branchResult = await runGit(projectPath, ['branch', '--show-current']);
    const branch = branchResult.stdout.trim();
    if (branch) args.push('-u', 'origin', branch);
  }
  const result = await runGit(projectPath, args);
  return result.exitCode === 0
    ? { success: true }
    : { success: false, error: result.stderr || result.stdout };
}

export async function getAheadBehind(projectPath: string): Promise<GitAheadBehind> {
  const result = await runGit(projectPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (result.exitCode !== 0) {
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
  const parts = result.stdout.trim().split(/\s+/);
  return {
    behind: parseInt(parts[0] ?? '0', 10) || 0,
    ahead: parseInt(parts[1] ?? '0', 10) || 0,
    hasUpstream: true,
  };
}

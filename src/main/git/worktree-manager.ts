import path from 'node:path';
import fs from 'node:fs';
import type { AgentType } from '../../shared/agent-types';
import type { WorktreeInfo, WorktreeMergeResult, WorktreeDiffSummary, WorktreeDiffFile } from '../../shared/worktree-types';
import { runGit, isGitRepo } from './git-executor';

const WORKTREE_DIR = '.hariari-worktrees';

export class WorktreeManager {
  private readonly worktrees = new Map<string, WorktreeInfo>();

  async createWorktree(
    projectPath: string,
    agentId: string,
    agentType: AgentType,
  ): Promise<WorktreeInfo | null> {
    if (!isGitRepo(projectPath)) return null;

    const shortId = agentId.slice(0, 8);
    const branchName = `hariari/${agentType}-${shortId}`;
    const worktreeBase = path.join(projectPath, WORKTREE_DIR);
    const worktreePath = path.join(worktreeBase, shortId);

    try {
      // Ensure .hariari-worktrees is in .gitignore
      await this.ensureGitignore(projectPath);

      // Ensure worktree base directory exists
      fs.mkdirSync(worktreeBase, { recursive: true });

      // Get current branch as base
      const baseBranch = await this.getCurrentBranch(projectPath);

      // Delete stale branch if it exists (from crashed session)
      await runGit(projectPath, ['branch', '-D', branchName]);

      // Create the worktree
      const result = await runGit(projectPath, [
        'worktree', 'add', worktreePath, '-b', branchName,
      ]);

      if (result.exitCode !== 0) {
        console.error('[WorktreeManager] Failed to create worktree:', result.stderr);
        return null;
      }

      const info: WorktreeInfo = {
        agentId,
        worktreePath,
        branchName,
        baseBranch,
        projectPath,
      };

      this.worktrees.set(agentId, info);
      return info;
    } catch (error) {
      console.error('[WorktreeManager] Error creating worktree:', error);
      return null;
    }
  }

  async removeWorktree(agentId: string): Promise<void> {
    const info = this.worktrees.get(agentId);
    if (!info) return;

    try {
      // Force remove the worktree
      await runGit(info.projectPath, ['worktree', 'remove', '--force', info.worktreePath]);

      // Check if branch was merged; if not, keep it (preserve work)
      const mergeCheck = await runGit(info.projectPath, [
        'branch', '--merged', info.baseBranch,
      ]);
      const isMerged = mergeCheck.stdout.includes(info.branchName);

      if (isMerged) {
        await runGit(info.projectPath, ['branch', '-d', info.branchName]);
      }
    } catch {
      // Best-effort cleanup — worktree dir may already be gone
      try {
        fs.rmSync(info.worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    this.worktrees.delete(agentId);
  }

  async mergeWorktree(agentId: string): Promise<WorktreeMergeResult> {
    const info = this.worktrees.get(agentId);
    if (!info) {
      return { success: false, mergedBranch: '', error: 'Worktree not found' };
    }

    try {
      // First, commit any uncommitted changes in the worktree
      await runGit(info.worktreePath, ['add', '-A']);
      await runGit(info.worktreePath, [
        'commit', '-m', `hariari: agent ${info.agentId.slice(0, 8)} changes`,
        '--allow-empty',
      ]);

      // Try merge with --no-commit first to detect conflicts
      const mergeCheck = await runGit(info.projectPath, [
        'merge', '--no-commit', '--no-ff', info.branchName,
      ]);

      if (mergeCheck.exitCode !== 0) {
        // Abort the failed merge
        await runGit(info.projectPath, ['merge', '--abort']);

        const conflicts = this.parseConflicts(mergeCheck.stdout + mergeCheck.stderr);
        return {
          success: false,
          mergedBranch: info.branchName,
          conflicts,
          error: 'Merge conflicts detected',
        };
      }

      // Commit the merge
      await runGit(info.projectPath, [
        'commit', '-m', `Merge ${info.branchName} into ${info.baseBranch}`,
      ]);

      // Cleanup worktree and branch
      await this.removeWorktree(agentId);

      return { success: true, mergedBranch: info.branchName };
    } catch (error) {
      return {
        success: false,
        mergedBranch: info.branchName,
        error: error instanceof Error ? error.message : 'Unknown merge error',
      };
    }
  }

  async getDiffSummary(agentId: string): Promise<WorktreeDiffSummary | null> {
    const info = this.worktrees.get(agentId);
    if (!info) return null;

    try {
      // Stage all changes in the worktree for accurate diff
      await runGit(info.worktreePath, ['add', '-A']);

      const stat = await runGit(info.projectPath, [
        'diff', '--stat', `${info.baseBranch}...${info.branchName}`,
      ]);

      const nameStatus = await runGit(info.projectPath, [
        'diff', '--name-status', `${info.baseBranch}...${info.branchName}`,
      ]);

      const numstat = await runGit(info.projectPath, [
        'diff', '--numstat', `${info.baseBranch}...${info.branchName}`,
      ]);

      const files = this.parseNameStatus(nameStatus.stdout, numstat.stdout);
      const totals = this.parseTotals(stat.stdout);

      return {
        filesChanged: files.length,
        insertions: totals.insertions,
        deletions: totals.deletions,
        files,
      };
    } catch {
      return null;
    }
  }

  async getDiffForFile(
    agentId: string,
    filePath: string,
  ): Promise<{ original: string; modified: string } | null> {
    const info = this.worktrees.get(agentId);
    if (!info) return null;

    try {
      const original = await runGit(info.projectPath, [
        'show', `${info.baseBranch}:${filePath}`,
      ]);
      const modified = await runGit(info.projectPath, [
        'show', `${info.branchName}:${filePath}`,
      ]);

      return {
        original: original.exitCode === 0 ? original.stdout : '',
        modified: modified.exitCode === 0 ? modified.stdout : '',
      };
    } catch {
      return null;
    }
  }

  getWorktreeInfo(agentId: string): WorktreeInfo | undefined {
    return this.worktrees.get(agentId);
  }

  hasWorktree(agentId: string): boolean {
    return this.worktrees.has(agentId);
  }

  async disposeAll(): Promise<void> {
    for (const agentId of [...this.worktrees.keys()]) {
      await this.removeWorktree(agentId);
    }
  }

  private async getCurrentBranch(projectPath: string): Promise<string> {
    const result = await runGit(projectPath, ['branch', '--show-current']);
    const branch = result.stdout.trim();
    if (branch) return branch;

    // Detached HEAD — use commit hash
    const head = await runGit(projectPath, ['rev-parse', 'HEAD']);
    return head.stdout.trim().slice(0, 12);
  }

  private async ensureGitignore(projectPath: string): Promise<void> {
    const gitignorePath = path.join(projectPath, '.gitignore');
    try {
      const content = fs.existsSync(gitignorePath)
        ? fs.readFileSync(gitignorePath, 'utf-8')
        : '';
      if (!content.includes(WORKTREE_DIR)) {
        const newline = content.endsWith('\n') || content === '' ? '' : '\n';
        fs.appendFileSync(gitignorePath, `${newline}${WORKTREE_DIR}/\n`);
      }
    } catch { /* ignore — gitignore is best-effort */ }
  }

  private parseConflicts(output: string): string[] {
    const conflicts: string[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/CONFLICT.*:\s*(.+)/);
      if (match) conflicts.push(match[1].trim());
    }
    return conflicts;
  }

  private parseNameStatus(nameStatus: string, numstat: string): WorktreeDiffFile[] {
    const numstatMap = new Map<string, { ins: number; del: number }>();
    for (const line of numstat.split('\n')) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        numstatMap.set(parts[2], {
          ins: parseInt(parts[0]) || 0,
          del: parseInt(parts[1]) || 0,
        });
      }
    }

    const files: WorktreeDiffFile[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const [statusChar, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      if (!filePath) continue;

      const stats = numstatMap.get(filePath) ?? { ins: 0, del: 0 };
      const status = statusChar === 'A' ? 'added'
        : statusChar === 'D' ? 'deleted'
        : statusChar?.startsWith('R') ? 'renamed'
        : 'modified';

      files.push({
        path: filePath,
        status: status as WorktreeDiffFile['status'],
        insertions: stats.ins,
        deletions: stats.del,
      });
    }
    return files;
  }

  private parseTotals(statOutput: string): { insertions: number; deletions: number } {
    const lastLine = statOutput.trim().split('\n').pop() ?? '';
    const insMatch = lastLine.match(/(\d+) insertion/);
    const delMatch = lastLine.match(/(\d+) deletion/);
    return {
      insertions: insMatch ? parseInt(insMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0,
    };
  }
}

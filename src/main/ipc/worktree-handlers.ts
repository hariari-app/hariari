import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { WorktreeManager } from '../git/worktree-manager';

export function registerWorktreeHandlers(worktreeManager: WorktreeManager): void {
  registerWorktreeDiffHandler(worktreeManager);
  registerWorktreeDiffFileHandler(worktreeManager);
  registerWorktreeMergeHandler(worktreeManager);
  registerWorktreeCleanupHandler(worktreeManager);
  registerWorktreeInfoHandler(worktreeManager);
}

function registerWorktreeDiffHandler(worktreeManager: WorktreeManager): void {
  ipcMain.handle(IPC_CHANNELS.WORKTREE_DIFF, (_event, agentId: unknown) =>
    typeof agentId === 'string' ? worktreeManager.getDiffSummary(agentId) : null,
  );
}

function registerWorktreeDiffFileHandler(worktreeManager: WorktreeManager): void {
  ipcMain.handle(IPC_CHANNELS.WORKTREE_DIFF_FILE, (_event, raw: unknown) =>
    handleWorktreeDiffFile(worktreeManager, raw),
  );
}

function handleWorktreeDiffFile(worktreeManager: WorktreeManager, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as { agentId: string; filePath: string };
  if (typeof request.agentId !== 'string' || typeof request.filePath !== 'string') return null;
  return worktreeManager.getDiffForFile(request.agentId, request.filePath);
}

function registerWorktreeMergeHandler(worktreeManager: WorktreeManager): void {
  ipcMain.handle(IPC_CHANNELS.WORKTREE_MERGE, (_event, agentId: unknown) =>
    handleWorktreeMerge(worktreeManager, agentId),
  );
}

function handleWorktreeMerge(worktreeManager: WorktreeManager, agentId: unknown): unknown {
  if (typeof agentId !== 'string') {
    return { success: false, mergedBranch: '', error: 'Invalid agent ID' };
  }
  return worktreeManager.mergeWorktree(agentId);
}

function registerWorktreeCleanupHandler(worktreeManager: WorktreeManager): void {
  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP, (_event, agentId: unknown) =>
    handleWorktreeCleanup(worktreeManager, agentId),
  );
}

async function handleWorktreeCleanup(
  worktreeManager: WorktreeManager,
  agentId: unknown,
): Promise<void> {
  if (typeof agentId !== 'string') return;
  await worktreeManager.removeWorktree(agentId);
}

function registerWorktreeInfoHandler(worktreeManager: WorktreeManager): void {
  ipcMain.handle(IPC_CHANNELS.WORKTREE_INFO, (_event, agentId: unknown) =>
    typeof agentId === 'string' ? (worktreeManager.getWorktreeInfo(agentId) ?? null) : null,
  );
}

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

export function registerGitHandlers(): void {
  registerGitStatusHandler();
  registerGitDiffHandler();
  registerGitShowHandler();
  registerGitDiscardHandler();
  registerGitStageHandler();
  registerGitPullHandler();
  registerGitPushHandler();
  registerGitAheadBehindHandler();
  registerGitUnstageHandler();
  registerGitStageAllHandler();
  registerGitUnstageAllHandler();
  registerGitDiscardAllHandler();
  registerGitCommitHandler();
  registerGitLogHandler();
}

function registerGitStatusHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, raw: unknown) => handleGitStatus(raw));
}

async function handleGitStatus(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { getGitStatus } = await import('../git/git-service');
    return await getGitStatus(raw);
  } catch (error) {
    console.error('[IPC][git:status]', error);
    return { error: 'git_status_failed' };
  }
}

function registerGitDiffHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_DIFF, (_event, raw: unknown) => handleGitDiff(raw));
}

async function handleGitDiff(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitDiffRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { getGitDiff } = await import('../git/git-service');
    return await getGitDiff(request.projectPath, request.filePath, request.group);
  } catch (error) {
    console.error('[IPC][git:diff]', error);
    return { error: 'git_diff_failed' };
  }
}

function registerGitShowHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_SHOW, (_event, raw: unknown) => handleGitShow(raw));
}

async function handleGitShow(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitShowRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { getFileAtRef } = await import('../git/git-service');
    return { content: await getFileAtRef(request.projectPath, request.filePath, request.ref) };
  } catch (error) {
    console.error('[IPC][git:show]', error);
    return { error: 'git_show_failed' };
  }
}

function registerGitDiscardHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_DISCARD, (_event, raw: unknown) => handleGitDiscard(raw));
}

async function handleGitDiscard(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitFileRequest(raw);
    if (!request) return { error: 'invalid_request' };
    return await runGitCommand(
      request.projectPath,
      ['checkout', '--', request.filePath],
      'discard_failed',
    );
  } catch (error) {
    console.error('[IPC][git:discard]', error);
    return { error: 'discard_failed' };
  }
}

function registerGitStageHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_STAGE, (_event, raw: unknown) => handleGitStage(raw));
}

async function handleGitStage(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitFileRequest(raw);
    if (!request) return { error: 'invalid_request' };
    return await runGitCommand(request.projectPath, ['add', request.filePath], 'stage_failed');
  } catch (error) {
    console.error('[IPC][git:stage]', error);
    return { error: 'stage_failed' };
  }
}

function registerGitPullHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_PULL, (_event, raw: unknown) => handleGitPull(raw));
}

async function handleGitPull(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { gitPull } = await import('../git/git-service');
    return await gitPull(raw);
  } catch (error) {
    console.error('[IPC][git:pull]', error);
    return { error: 'pull_failed' };
  }
}

function registerGitPushHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, (_event, raw: unknown) => handleGitPush(raw));
}

async function handleGitPush(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitPushRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { gitPush } = await import('../git/git-service');
    return await gitPush(request.projectPath, request.setUpstream);
  } catch (error) {
    console.error('[IPC][git:push]', error);
    return { error: 'push_failed' };
  }
}

function registerGitAheadBehindHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_AHEAD_BEHIND, (_event, raw: unknown) =>
    handleGitAheadBehind(raw),
  );
}

async function handleGitAheadBehind(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { getAheadBehind } = await import('../git/git-service');
    return await getAheadBehind(raw);
  } catch (error) {
    console.error('[IPC][git:ahead-behind]', error);
    return { error: 'ahead_behind_failed' };
  }
}

function registerGitUnstageHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE, (_event, raw: unknown) => handleGitUnstage(raw));
}

async function handleGitUnstage(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitFileRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { gitUnstage } = await import('../git/git-service');
    return await gitUnstage(request.projectPath, request.filePath);
  } catch (error) {
    console.error('[IPC][git:unstage]', error);
    return { error: 'unstage_failed' };
  }
}

function registerGitStageAllHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_STAGE_ALL, (_event, raw: unknown) => handleGitStageAll(raw));
}

async function handleGitStageAll(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { gitStageAll } = await import('../git/git-service');
    return await gitStageAll(raw);
  } catch (error) {
    console.error('[IPC][git:stage-all]', error);
    return { error: 'stage_all_failed' };
  }
}

function registerGitUnstageAllHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE_ALL, (_event, raw: unknown) => handleGitUnstageAll(raw));
}

async function handleGitUnstageAll(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { gitUnstageAll } = await import('../git/git-service');
    return await gitUnstageAll(raw);
  } catch (error) {
    console.error('[IPC][git:unstage-all]', error);
    return { error: 'unstage_all_failed' };
  }
}

function registerGitDiscardAllHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_DISCARD_ALL, (_event, raw: unknown) => handleGitDiscardAll(raw));
}

async function handleGitDiscardAll(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const { gitDiscardAll } = await import('../git/git-service');
    return await gitDiscardAll(raw);
  } catch (error) {
    console.error('[IPC][git:discard-all]', error);
    return { error: 'discard_all_failed' };
  }
}

function registerGitCommitHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, (_event, raw: unknown) => handleGitCommit(raw));
}

async function handleGitCommit(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitCommitRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { gitCommit } = await import('../git/git-service');
    return await gitCommit(request.projectPath, request.message, request.amend);
  } catch (error) {
    console.error('[IPC][git:commit]', error);
    return { error: 'commit_failed' };
  }
}

function registerGitLogHandler(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_LOG, (_event, raw: unknown) => handleGitLog(raw));
}

async function handleGitLog(raw: unknown): Promise<unknown> {
  try {
    const request = parseGitLogRequest(raw);
    if (!request) return { error: 'invalid_request' };
    const { getGitLog } = await import('../git/git-service');
    return await getGitLog(request.projectPath, request.maxCount);
  } catch (error) {
    console.error('[IPC][git:log]', error);
    return { error: 'log_failed' };
  }
}

function parseGitDiffRequest(raw: unknown): {
  projectPath: string;
  filePath: string;
  group: 'staged' | 'unstaged' | 'untracked';
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (
    typeof request.projectPath !== 'string' ||
    typeof request.filePath !== 'string' ||
    typeof request.group !== 'string'
  ) {
    return null;
  }
  return {
    projectPath: request.projectPath,
    filePath: request.filePath,
    group: request.group as 'staged' | 'unstaged' | 'untracked',
  };
}

function parseGitShowRequest(raw: unknown): {
  projectPath: string;
  filePath: string;
  ref: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (
    typeof request.projectPath !== 'string' ||
    typeof request.filePath !== 'string' ||
    typeof request.ref !== 'string'
  ) {
    return null;
  }
  return { projectPath: request.projectPath, filePath: request.filePath, ref: request.ref };
}

function parseGitFileRequest(raw: unknown): { projectPath: string; filePath: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (typeof request.projectPath !== 'string' || typeof request.filePath !== 'string') return null;
  return { projectPath: request.projectPath, filePath: request.filePath };
}

function parseGitPushRequest(raw: unknown): { projectPath: string; setUpstream: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (typeof request.projectPath !== 'string') return null;
  return { projectPath: request.projectPath, setUpstream: request.setUpstream === true };
}

function parseGitCommitRequest(raw: unknown): {
  projectPath: string;
  message: string;
  amend: boolean;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (typeof request.projectPath !== 'string' || typeof request.message !== 'string') return null;
  return {
    projectPath: request.projectPath,
    message: request.message,
    amend: request.amend === true,
  };
}

function parseGitLogRequest(raw: unknown): { projectPath: string; maxCount: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (typeof request.projectPath !== 'string') return null;
  return {
    projectPath: request.projectPath,
    maxCount: typeof request.maxCount === 'number' ? request.maxCount : 50,
  };
}

async function runGitCommand(
  projectPath: string,
  args: string[],
  fallbackError: string,
): Promise<unknown> {
  const { runGit } = await import('../git/git-executor');
  const result = await runGit(projectPath, args);
  return result.exitCode === 0 ? { success: true } : { error: result.stderr || fallbackError };
}

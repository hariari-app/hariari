import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

function parseSearchResults(output: string, projectPath: string, isRipgrep: boolean): unknown[] {
  const results: unknown[] = [];
  const pathPrefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;

    let filePath: string;
    let lineNumber: number;
    let lineContent: string;
    let matchStart = 0;

    if (isRipgrep) {
      const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
      if (!match) continue;
      filePath = match[1];
      lineNumber = parseInt(match[2], 10);
      matchStart = parseInt(match[3], 10) - 1;
      lineContent = match[4];
    } else {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      filePath = match[1];
      lineNumber = parseInt(match[2], 10);
      lineContent = match[3];
    }

    if (filePath.startsWith(pathPrefix)) {
      filePath = filePath.slice(pathPrefix.length);
    }

    results.push({ filePath, lineNumber, lineContent: lineContent.trim(), matchStart, matchEnd: matchStart + 1 });
    if (results.length >= 200) break;
  }

  return results;
}

export function registerGitHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { getGitStatus } = await import('../git/git-service');
      return await getGitStatus(raw);
    } catch (error) {
      console.error('[IPC][git:status]', error);
      return { error: 'git_status_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DIFF, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string' || typeof req.group !== 'string') {
        return { error: 'invalid_request' };
      }
      const { getGitDiff } = await import('../git/git-service');
      return await getGitDiff(req.projectPath, req.filePath, req.group as 'staged' | 'unstaged' | 'untracked');
    } catch (error) {
      console.error('[IPC][git:diff]', error);
      return { error: 'git_diff_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_SHOW, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string' || typeof req.ref !== 'string') {
        return { error: 'invalid_request' };
      }
      const { getFileAtRef } = await import('../git/git-service');
      const content = await getFileAtRef(req.projectPath, req.filePath, req.ref);
      return { content };
    } catch (error) {
      console.error('[IPC][git:show]', error);
      return { error: 'git_show_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DISCARD, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string') {
        return { error: 'invalid_request' };
      }
      const { runGit } = await import('../git/git-executor');
      const result = await runGit(req.projectPath, ['checkout', '--', req.filePath]);
      return result.exitCode === 0 ? { success: true } : { error: result.stderr || 'discard_failed' };
    } catch (error) {
      console.error('[IPC][git:discard]', error);
      return { error: 'discard_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STAGE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string') {
        return { error: 'invalid_request' };
      }
      const { runGit } = await import('../git/git-executor');
      const result = await runGit(req.projectPath, ['add', req.filePath]);
      return result.exitCode === 0 ? { success: true } : { error: result.stderr || 'stage_failed' };
    } catch (error) {
      console.error('[IPC][git:stage]', error);
      return { error: 'stage_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PULL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitPull } = await import('../git/git-service');
      return await gitPull(raw);
    } catch (error) {
      console.error('[IPC][git:pull]', error);
      return { error: 'pull_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string') return { error: 'invalid_request' };
      const { gitPush } = await import('../git/git-service');
      return await gitPush(req.projectPath, req.setUpstream === true);
    } catch (error) {
      console.error('[IPC][git:push]', error);
      return { error: 'push_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_AHEAD_BEHIND, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { getAheadBehind } = await import('../git/git-service');
      return await getAheadBehind(raw);
    } catch (error) {
      console.error('[IPC][git:ahead-behind]', error);
      return { error: 'ahead_behind_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string') return { error: 'invalid_request' };
      const { gitUnstage } = await import('../git/git-service');
      return await gitUnstage(req.projectPath, req.filePath);
    } catch (error) {
      console.error('[IPC][git:unstage]', error);
      return { error: 'unstage_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STAGE_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitStageAll } = await import('../git/git-service');
      return await gitStageAll(raw);
    } catch (error) {
      console.error('[IPC][git:stage-all]', error);
      return { error: 'stage_all_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitUnstageAll } = await import('../git/git-service');
      return await gitUnstageAll(raw);
    } catch (error) {
      console.error('[IPC][git:unstage-all]', error);
      return { error: 'unstage_all_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DISCARD_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitDiscardAll } = await import('../git/git-service');
      return await gitDiscardAll(raw);
    } catch (error) {
      console.error('[IPC][git:discard-all]', error);
      return { error: 'discard_all_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.message !== 'string') return { error: 'invalid_request' };
      const { gitCommit } = await import('../git/git-service');
      return await gitCommit(req.projectPath, req.message, req.amend === true);
    } catch (error) {
      console.error('[IPC][git:commit]', error);
      return { error: 'commit_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LOG, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string') return { error: 'invalid_request' };
      const maxCount = typeof req.maxCount === 'number' ? req.maxCount : 50;
      const { getGitLog } = await import('../git/git-service');
      return await getGitLog(req.projectPath, maxCount);
    } catch (error) {
      console.error('[IPC][git:log]', error);
      return { error: 'log_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return [];
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.query !== 'string') return [];
      if (!req.query.trim()) return [];

      const maxResults = typeof req.maxResults === 'number' ? req.maxResults : 100;
      const { execFile } = await import('node:child_process');

      return new Promise<unknown[]>((resolve) => {
        const rgArgs = [
          '--line-number', '--column', '--no-heading',
          '--max-count', String(maxResults),
          '--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist', '--glob', '!out',
          '--', req.query as string, req.projectPath as string,
        ];

        execFile('rg', rgArgs, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (_rgErr, rgOut) => {
          if (rgOut && rgOut.trim()) {
            resolve(parseSearchResults(rgOut, req.projectPath as string, true));
            return;
          }

          const grepArgs = [
            '-rn',
            '--exclude-dir=node_modules', '--exclude-dir=.git',
            '--exclude-dir=dist', '--exclude-dir=out',
            '--exclude-dir=__pycache__', '--exclude-dir=.cache',
            req.query as string, req.projectPath as string,
          ];

          execFile('grep', grepArgs, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (_grepErr, grepOut) => {
            if (grepOut && grepOut.trim()) {
              resolve(parseSearchResults(grepOut, req.projectPath as string, false));
            } else {
              resolve([]);
            }
          });
        });
      });
    } catch (error) {
      console.error('[IPC][file:search]', error);
      return [];
    }
  });
}

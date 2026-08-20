import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/constants';
import { isCliAgentType } from '../../shared/agent-types';
import type { AgentManager } from '../agent/agent-manager';
import { saveScrollback, loadScrollback, deleteScrollback } from '../scrollback-store';
import { getSkillsManifest } from '../skills/skills-manifest';
import { installSkills, loadInstalled, uninstallSkill } from '../skills/skills-installer';
import { detectProjectLanguages } from '../skills/language-detector';

const ALLOWED_COMMANDS = new Set([
  'claude',
  'gemini',
  'codex',
  'pi',
  'opencode',
  'cline',
  'copilot',
  'amp',
  'cn',
  'cursor-agent',
  'crush',
  'qwen',
]);
const VALID_SKILL_ID = /^[a-z0-9-]+$/;

export function registerAgentToolingHandlers(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_CHECK_INSTALLED, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { installed: false };
      if (
        !ALLOWED_COMMANDS.has(raw) ||
        raw.includes('/') ||
        raw.includes('\\') ||
        raw.includes('..')
      ) {
        return { installed: false };
      }
      const { execFile } = await import('node:child_process');
      const nodePath = await import('node:path');
      const nodeFs = await import('node:fs');

      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const pathSep = isWin ? ';' : ':';

      const home = isWin
        ? process.env.USERPROFILE || process.env.HOME || ''
        : process.env.HOME || '';
      const extraPaths: string[] = [];

      if (isWin) {
        const appData = process.env.APPDATA || nodePath.join(home, 'AppData', 'Roaming');
        const localAppData = process.env.LOCALAPPDATA || nodePath.join(home, 'AppData', 'Local');
        extraPaths.push(
          nodePath.join(appData, 'npm'),
          nodePath.join(localAppData, 'Programs', 'Python', 'Python3*', 'Scripts'),
          nodePath.join(home, '.cargo', 'bin'),
          nodePath.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
          nodePath.join(home, 'scoop', 'shims'),
        );
        const nvmHome = process.env.NVM_HOME || nodePath.join(appData, 'nvm');
        const nvmSymlink =
          process.env.NVM_SYMLINK || nodePath.join(home, 'AppData', 'Roaming', 'nvm', 'current');
        if (nodeFs.existsSync(nvmSymlink)) {
          extraPaths.unshift(nvmSymlink);
        } else if (nodeFs.existsSync(nvmHome)) {
          extraPaths.unshift(nvmHome);
        }
      } else {
        if (isMac) {
          extraPaths.push('/opt/homebrew/bin', '/opt/homebrew/sbin');
        }
        extraPaths.push(
          '/usr/local/bin',
          '/usr/local/sbin',
          nodePath.join(home, '.local', 'bin'),
          nodePath.join(home, '.cargo', 'bin'),
        );
        const nvmDir = process.env.NVM_DIR || nodePath.join(home, '.nvm');
        try {
          const versionsDir = nodePath.join(nvmDir, 'versions', 'node');
          if (nodeFs.existsSync(versionsDir)) {
            const versions = nodeFs.readdirSync(versionsDir).sort().reverse();
            if (versions.length > 0) {
              extraPaths.unshift(nodePath.join(versionsDir, versions[0], 'bin'));
            }
          }
        } catch {
          // nvm not installed
        }
      }

      const enrichedPath = [...extraPaths, process.env.PATH || ''].join(pathSep);
      const env = { ...process.env, PATH: enrichedPath };
      const lookupCmd = isWin ? 'where.exe' : 'which';

      return new Promise<{ installed: boolean; version?: string }>((resolve) => {
        execFile(lookupCmd, [raw], { timeout: 5000, env }, (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve({ installed: false });
          } else {
            execFile(raw, ['--version'], { timeout: 5000, env }, (vErr, vOut) => {
              const version = vErr ? undefined : vOut.trim().split('\n')[0];
              resolve({ installed: true, version });
            });
          }
        });
      });
    } catch {
      return { installed: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_INSTALL, async (event, raw: unknown) => {
    try {
      if (!isCliAgentType(raw)) {
        return { success: false, error: 'Invalid agent type' };
      }

      const { AGENT_INSTALL_INFO } = await import('../../shared/agent-install-info');
      const info = AGENT_INSTALL_INFO[raw as keyof typeof AGENT_INSTALL_INFO];
      if (!info) {
        return { success: false, error: 'No install info for agent' };
      }

      const installCommand = info.installCommand;
      const agentType = raw;
      const win = BrowserWindow.fromWebContents(event.sender);

      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWin ? ['/c', installCommand] : ['-c', installCommand];

      const home = isWin
        ? process.env.USERPROFILE || process.env.HOME || ''
        : process.env.HOME || '';
      const extraPaths: string[] = [];

      if (isWin) {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        extraPaths.push(
          path.join(appData, 'npm'),
          path.join(home, '.cargo', 'bin'),
          path.join(home, 'scoop', 'shims'),
        );
        const nvmSymlink = process.env.NVM_SYMLINK || path.join(appData, 'nvm', 'current');
        if (fs.existsSync(nvmSymlink)) extraPaths.unshift(nvmSymlink);
      } else {
        if (process.platform === 'darwin') {
          extraPaths.push('/opt/homebrew/bin', '/opt/homebrew/sbin');
        }
        extraPaths.push(
          '/usr/local/bin',
          '/usr/local/sbin',
          path.join(home, '.local', 'bin'),
          path.join(home, '.cargo', 'bin'),
        );
        const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
        try {
          const versionsDir = path.join(nvmDir, 'versions', 'node');
          if (fs.existsSync(versionsDir)) {
            const versions = fs.readdirSync(versionsDir).sort().reverse();
            if (versions.length > 0) {
              extraPaths.unshift(path.join(versionsDir, versions[0], 'bin'));
            }
          }
        } catch {
          // nvm not installed
        }
      }

      const pathSep = isWin ? ';' : ':';
      const enrichedPath = [...extraPaths, process.env.PATH || ''].join(pathSep);
      const env = { ...process.env, PATH: enrichedPath };

      const { spawn: spawnChild } = await import('node:child_process');

      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        const child = spawnChild(shell, shellArgs, {
          env,
          cwd: home,
          timeout: 120_000,
        });

        const sendOutput = (data: string) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.AGENT_INSTALL_OUTPUT, { agentType, data });
          }
        };

        const onWindowClosed = () => {
          try {
            child.kill();
          } catch {
            // already exited
          }
        };
        if (win) win.once('closed', onWindowClosed);

        child.stdout?.on('data', (chunk: Buffer) => sendOutput(chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => sendOutput(chunk.toString()));

        child.on('close', (code) => {
          if (win && !win.isDestroyed()) win.removeListener('closed', onWindowClosed);
          if (code === 0) {
            sendOutput(`\n✓ ${info.displayName} installed successfully.\n`);
            resolve({ success: true });
          } else {
            sendOutput(`\n✗ Install failed (exit code ${code}).\n`);
            resolve({ success: false, error: `Exit code ${code}` });
          }
        });

        child.on('error', (err) => {
          sendOutput(`\n✗ Error: ${err.message}\n`);
          resolve({ success: false, error: err.message });
        });
      });
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_MANIFEST, async () => {
    return getSkillsManifest();
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALL, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object')
      return { results: [], summary: { installed: 0, failed: 0, skipped: 0 } };
    const req = raw as { skillIds: string[]; targetAgents: string[] };
    if (!Array.isArray(req.skillIds) || !Array.isArray(req.targetAgents)) {
      return { results: [], summary: { installed: 0, failed: 0, skipped: 0 } };
    }
    const safeSkillIds = req.skillIds.filter(
      (id): id is string => typeof id === 'string' && VALID_SKILL_ID.test(id),
    );
    const safeTargetAgents = req.targetAgents.filter(isCliAgentType);
    return installSkills({ skillIds: safeSkillIds, targetAgents: safeTargetAgents });
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALLED, async () => {
    return loadInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_UNINSTALL, async (_event, skillId: unknown) => {
    if (typeof skillId !== 'string' || !VALID_SKILL_ID.test(skillId))
      return { error: 'Invalid skill ID' };
    return uninstallSkill(skillId);
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_DETECT_LANGS, async (_event, projectPath: unknown) => {
    if (typeof projectPath !== 'string') return [];
    return detectProjectLanguages(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_DETECT_PROJECTS, async () => {
    const home = os.homedir();
    const searchDirs = [
      path.join(home, 'projects'),
      path.join(home, 'code'),
      path.join(home, 'dev'),
      path.join(home, 'src'),
      path.join(home, 'repos'),
      path.join(home, 'Documents', 'GitHub'),
      path.join(home, 'workspace'),
    ];

    const results: Array<{ name: string; path: string; mtime: number }> = [];
    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (fs.existsSync(path.join(fullPath, '.git'))) {
            const stat = fs.statSync(fullPath);
            results.push({ name: entry.name, path: fullPath, mtime: stat.mtimeMs });
          }
        }
      } catch {
        // skip inaccessible directories
      }
    }

    return results
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)
      .map(({ name, path: projectPath }) => ({ name, path: projectPath }));
  });

  const worktreeManager = agentManager.getWorktreeManager();

  ipcMain.handle(IPC_CHANNELS.WORKTREE_DIFF, async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return null;
    return worktreeManager.getDiffSummary(agentId);
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_DIFF_FILE, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return null;
    const { agentId, filePath } = raw as { agentId: string; filePath: string };
    if (typeof agentId !== 'string' || typeof filePath !== 'string') return null;
    return worktreeManager.getDiffForFile(agentId, filePath);
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_MERGE, async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string')
      return { success: false, mergedBranch: '', error: 'Invalid agent ID' };
    return worktreeManager.mergeWorktree(agentId);
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_CLEANUP, async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return;
    await worktreeManager.removeWorktree(agentId);
  });

  ipcMain.handle(IPC_CHANNELS.WORKTREE_INFO, async (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') return null;
    return worktreeManager.getWorktreeInfo(agentId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_SAVE, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const { sessionId, data } = raw as { sessionId: string; data: string };
    if (typeof sessionId !== 'string' || typeof data !== 'string') return;
    await saveScrollback(sessionId, data);
  });

  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_LOAD, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return null;
    return loadScrollback(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_DELETE, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return;
    await deleteScrollback(sessionId);
  });
}

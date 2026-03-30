import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppState } from '../../shared/ipc-types';
import type { AgentManager } from '../agent/agent-manager';
import type { PtyManager } from '../pty/pty-manager';
import type { StateManager } from '../state/state-manager';
import type { ProjectManager } from '../project/project-manager';
import type { NotificationManager } from '../notification/notification-manager';
import { saveScrollback, loadScrollback, deleteScrollback } from '../scrollback-store';
import { getSkillsManifest } from '../skills/skills-manifest';
import { installSkills, loadInstalled, uninstallSkill } from '../skills/skills-installer';
import { detectProjectLanguages } from '../skills/language-detector';
import {
  validateSessionId,
  validateWriteRequest,
  validateResizeRequest,
  validateKillRequest,
  validateAgentSpawnRequest,
  validateAgentId,
  validateOptionalAgentId,
  validateProjectId,
  validateProjectCreateRequest,
  validateProjectUpdateRequest,
  validateProjectWorkspaceState,
} from './validators';

const MAX_AGENTS = 20;

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
      // rg format: filepath:line:col:content
      const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
      if (!match) continue;
      filePath = match[1];
      lineNumber = parseInt(match[2], 10);
      matchStart = parseInt(match[3], 10) - 1;
      lineContent = match[4];
    } else {
      // grep format: filepath:line:content
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      filePath = match[1];
      lineNumber = parseInt(match[2], 10);
      lineContent = match[3];
    }

    // Make path relative
    if (filePath.startsWith(pathPrefix)) {
      filePath = filePath.slice(pathPrefix.length);
    }

    results.push({ filePath, lineNumber, lineContent: lineContent.trim(), matchStart, matchEnd: matchStart + 1 });
    if (results.length >= 200) break;
  }

  return results;
}

export function registerIpcHandlers(
  agentManager: AgentManager,
  ptyManager: PtyManager,
  stateManager: StateManager,
  projectManager: ProjectManager,
  notificationManager?: NotificationManager,
): void {
  ipcMain.handle(IPC_CHANNELS.PTY_WRITE, (_event, raw: unknown) => {
    try {
      const request = validateWriteRequest(raw);
      ptyManager.write(request.sessionId, request.data);
      // Clear needs-input status when user sends data
      agentManager.clearNeedsInputForSession(request.sessionId);
    } catch (error) {
      console.error('[IPC][pty:write]', error);
      return { error: 'pty_write_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_RESIZE, (_event, raw: unknown) => {
    try {
      const request = validateResizeRequest(raw);
      ptyManager.resize(request.sessionId, request.cols, request.rows);
    } catch (error) {
      console.error('[IPC][pty:resize]', error);
      return { error: 'pty_resize_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_KILL, (_event, raw: unknown) => {
    try {
      const request = validateKillRequest(raw);
      ptyManager.kill(request.sessionId);
    } catch (error) {
      console.error('[IPC][pty:kill]', error);
      return { error: 'pty_kill_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, async (_event, raw: unknown) => {
    try {
      if (agentManager.listAgents().length >= MAX_AGENTS) {
        return { error: 'max_agents_reached' };
      }
      const request = validateAgentSpawnRequest(raw);
      return await agentManager.spawnAgent(request);
    } catch (error) {
      console.error('[IPC][agent:spawn]', error);
      return { error: 'agent_spawn_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_KILL, async (_event, raw: unknown) => {
    try {
      const agentId = validateAgentId(raw);
      await agentManager.killAgent(agentId);
    } catch (error) {
      console.error('[IPC][agent:kill]', error);
      return { error: 'agent_kill_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, () => {
    try {
      return agentManager.listAgents();
    } catch (error) {
      console.error('[IPC][agent:list]', error);
      return { error: 'agent_list_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (_event, raw: unknown) => {
    try {
      const agentId = validateOptionalAgentId(raw);
      return await agentManager.getRecorder().getRecordings(agentId);
    } catch (error) {
      console.error('[IPC][session:list]', error);
      return { error: 'session_list_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, raw: unknown) => {
    try {
      const agentId = validateAgentId(raw);
      const recordings = await agentManager.getRecorder().getRecordings(agentId);
      return recordings;
    } catch (error) {
      console.error('[IPC][session:get]', error);
      return { error: 'session_get_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.STATE_LOAD, () => {
    try {
      return stateManager.loadState();
    } catch (error) {
      console.error('[IPC][state:load]', error);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.STATE_SAVE, (_event, raw: unknown) => {
    try {
      const validated = stateManager.validateAndParse(raw);
      if (!validated) {
        return { error: 'invalid_state' };
      }
      stateManager.saveState(validated);
    } catch (error) {
      console.error('[IPC][state:save]', error);
      return { error: 'state_save_failed' };
    }
  });

  // Project handlers
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => {
    try {
      return projectManager.listProjects();
    } catch (error) {
      console.error('[IPC][project:list]', error);
      return { error: 'project_list_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_event, raw: unknown) => {
    try {
      const request = validateProjectCreateRequest(raw);
      return projectManager.createProject(request);
    } catch (error) {
      console.error('[IPC][project:create]', error);
      return { error: error instanceof Error ? error.message : 'project_create_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_REMOVE, (_event, raw: unknown) => {
    try {
      const projectId = validateProjectId(raw);
      projectManager.removeProject(projectId);
    } catch (error) {
      console.error('[IPC][project:remove]', error);
      return { error: 'project_remove_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_event, raw: unknown) => {
    try {
      const request = validateProjectUpdateRequest(raw);
      return projectManager.updateProject(request);
    } catch (error) {
      console.error('[IPC][project:update]', error);
      return { error: 'project_update_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_PICK_DIR, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Project Directory',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (error) {
      console.error('[IPC][project:pick-dir]', error);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_STATE_LOAD, (_event, raw: unknown) => {
    try {
      const projectId = validateProjectId(raw);
      return stateManager.loadProjectState(projectId);
    } catch (error) {
      console.error('[IPC][project:state:load]', error);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_STATE_SAVE, (_event, raw: unknown) => {
    try {
      const validated = validateProjectWorkspaceState(raw);
      if (!validated) {
        return { error: 'invalid_project_state' };
      }
      stateManager.saveProjectState(validated);
    } catch (error) {
      console.error('[IPC][project:state:save]', error);
      return { error: 'project_state_save_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.path !== 'string' || typeof req.content !== 'string') {
        return { error: 'invalid_request' };
      }
      // Safety: only write within home directory
      const resolved = path.resolve(req.path);
      const home = os.homedir();
      if (!resolved.startsWith(home + path.sep) && resolved !== home) {
        return { error: 'path_outside_home' };
      }
      fs.writeFileSync(resolved, req.content, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('[IPC][file:write]', error);
      return { error: 'write_failed' };
    }
  });

  // NOTE: keybindings and settings handlers are registered early in index.ts
  // to avoid race conditions with the renderer.

  // Voice transcription handler (runs in main process to bypass CSP)
  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      const provider = req.provider as string;
      const apiKey = req.apiKey as string;
      const audioBase64 = req.audioBase64 as string;
      if (!provider || !apiKey || !audioBase64) return { error: 'missing_fields' };

      const audioBuffer = Buffer.from(audioBase64, 'base64');

      let url: string;
      let model: string;
      if (provider === 'groq') {
        url = 'https://api.groq.com/openai/v1/audio/transcriptions';
        model = 'whisper-large-v3-turbo';
      } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/audio/transcriptions';
        model = 'whisper-1';
      } else {
        return { error: 'unsupported_provider_for_ipc' };
      }

      // Build multipart form data manually for Node.js fetch
      const boundary = '----VibeIDEBoundary' + Date.now();
      const parts: Buffer[] = [];

      // File part
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`
      ));
      parts.push(audioBuffer);
      parts.push(Buffer.from('\r\n'));

      // Model part
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
      ));

      // Language part
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`
      ));

      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[IPC][voice:transcribe] ${provider} API error ${response.status}:`, errText);
        return { error: `${provider}_api_error_${response.status}` };
      }

      const result = await response.json() as Record<string, unknown>;
      return { text: (result.text as string)?.trim() ?? '' };
    } catch (error) {
      console.error('[IPC][voice:transcribe]', error);
      return { error: 'transcription_failed' };
    }
  });

  // Voice LLM formatter (runs in main process to bypass CSP)
  ipcMain.handle(IPC_CHANNELS.VOICE_FORMAT_LLM, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      const provider = req.provider as string;
      const apiKey = req.apiKey as string;
      const messages = req.messages as Array<{ role: string; content: string }>;
      if (!provider || !apiKey || !messages) return { error: 'missing_fields' };

      let url: string;
      let model: string;

      if (provider === 'groq') {
        url = 'https://api.groq.com/openai/v1/chat/completions';
        model = 'llama-3.1-8b-instant';
      } else if (provider === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        model = 'gpt-4o-mini';
      } else {
        return { error: 'unsupported_provider' };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[IPC][voice:format-llm] ${provider} error ${response.status}:`, errText);
        return { error: `llm_error_${response.status}` };
      }

      const result = await response.json() as Record<string, unknown>;
      const choices = result.choices as Array<{ message: { content: string } }>;
      const text = choices?.[0]?.message?.content?.trim() ?? '';
      return { text };
    } catch (error) {
      console.error('[IPC][voice:format-llm]', error);
      return { error: 'format_failed' };
    }
  });

  // Notification handlers
  // File handlers
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIR, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const resolved = path.resolve(raw);
      if (!resolved.startsWith(os.homedir() + path.sep)) {
        return { error: 'path_outside_home' };
      }
      const fsp = await import('node:fs/promises');
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      const result = entries
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 500)
        .map((e) => ({
          name: e.name,
          path: path.join(resolved, e.name),
          isDirectory: e.isDirectory(),
        }));
      return result;
    } catch (error) {
      console.error('[IPC][file:list-dir]', error);
      return { error: 'list_dir_failed' };
    }
  });

  // Git operations
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
    } catch (error) { console.error('[IPC][git:pull]', error); return { error: 'pull_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string') return { error: 'invalid_request' };
      const { gitPush } = await import('../git/git-service');
      return await gitPush(req.projectPath, req.setUpstream === true);
    } catch (error) { console.error('[IPC][git:push]', error); return { error: 'push_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_AHEAD_BEHIND, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { getAheadBehind } = await import('../git/git-service');
      return await getAheadBehind(raw);
    } catch (error) { console.error('[IPC][git:ahead-behind]', error); return { error: 'ahead_behind_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.filePath !== 'string') return { error: 'invalid_request' };
      const { gitUnstage } = await import('../git/git-service');
      return await gitUnstage(req.projectPath, req.filePath);
    } catch (error) { console.error('[IPC][git:unstage]', error); return { error: 'unstage_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STAGE_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitStageAll } = await import('../git/git-service');
      return await gitStageAll(raw);
    } catch (error) { console.error('[IPC][git:stage-all]', error); return { error: 'stage_all_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitUnstageAll } = await import('../git/git-service');
      return await gitUnstageAll(raw);
    } catch (error) { console.error('[IPC][git:unstage-all]', error); return { error: 'unstage_all_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DISCARD_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const { gitDiscardAll } = await import('../git/git-service');
      return await gitDiscardAll(raw);
    } catch (error) { console.error('[IPC][git:discard-all]', error); return { error: 'discard_all_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.message !== 'string') return { error: 'invalid_request' };
      const { gitCommit } = await import('../git/git-service');
      return await gitCommit(req.projectPath, req.message, req.amend === true);
    } catch (error) { console.error('[IPC][git:commit]', error); return { error: 'commit_failed' }; }
  });

  ipcMain.handle(IPC_CHANNELS.GIT_LOG, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string') return { error: 'invalid_request' };
      const maxCount = typeof req.maxCount === 'number' ? req.maxCount : 50;
      const { getGitLog } = await import('../git/git-service');
      return await getGitLog(req.projectPath, maxCount);
    } catch (error) { console.error('[IPC][git:log]', error); return { error: 'log_failed' }; }
  });

  // Cross-file search (ripgrep or grep)
  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return [];
      const req = raw as Record<string, unknown>;
      if (typeof req.projectPath !== 'string' || typeof req.query !== 'string') return [];
      if (!req.query.trim()) return [];

      const maxResults = typeof req.maxResults === 'number' ? req.maxResults : 100;
      const { execFile } = await import('node:child_process');

      // Try ripgrep first, fall back to grep
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

          // Fallback to grep
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

  // Agent install detection
  const ALLOWED_COMMANDS = new Set(['claude', 'gemini', 'codex', 'aider', 'opencode',
    'cline', 'copilot', 'amp', 'cn', 'cursor-agent', 'crush', 'qwen']);

  ipcMain.handle(IPC_CHANNELS.AGENT_CHECK_INSTALLED, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { installed: false };
      // Whitelist: reject any command not in the allowed set, or containing path separators
      if (!ALLOWED_COMMANDS.has(raw) || raw.includes('/') || raw.includes('..')) {
        return { installed: false };
      }
      const { execFile } = await import('node:child_process');
      const nodePath = await import('node:path');
      const nodeFs = await import('node:fs');

      // Build enriched PATH (Electron GUI apps don't inherit shell PATH on macOS)
      const home = process.env.HOME || '';
      const extraPaths = [
        '/opt/homebrew/bin', '/opt/homebrew/sbin',
        '/usr/local/bin', '/usr/local/sbin',
        nodePath.join(home, '.local/bin'),
        nodePath.join(home, '.cargo/bin'),
      ];
      const nvmDir = process.env.NVM_DIR || nodePath.join(home, '.nvm');
      try {
        const versionsDir = nodePath.join(nvmDir, 'versions', 'node');
        if (nodeFs.existsSync(versionsDir)) {
          const versions = nodeFs.readdirSync(versionsDir).sort().reverse();
          if (versions.length > 0) {
            extraPaths.unshift(nodePath.join(versionsDir, versions[0], 'bin'));
          }
        }
      } catch { /* nvm not installed */ }

      const enrichedPath = [...extraPaths, process.env.PATH || ''].join(':');
      const env = { ...process.env, PATH: enrichedPath };

      return new Promise<{ installed: boolean; version?: string }>((resolve) => {
        execFile('which', [raw], { timeout: 5000, env }, (error, stdout) => {
          if (error || !stdout.trim()) {
            resolve({ installed: false });
          } else {
            // Try to get version
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

  // Recursive file listing (respects .gitignore patterns)
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_ALL, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const rootPath = raw;
      const results: string[] = [];
      const MAX_FILES = 5000;

      // Load .gitignore patterns
      const ignorePatterns = new Set([
        'node_modules', '.git', 'dist', 'out', 'build', '.next',
        '__pycache__', '.pytest_cache', 'target', '.cache',
        'coverage', '.nyc_output', '.turbo', '.vercel',
        'vendor', 'venv', '.venv', 'env',
      ]);

      try {
        const gitignorePath = path.join(rootPath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
          const content = fs.readFileSync(gitignorePath, 'utf-8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              ignorePatterns.add(trimmed.replace(/\/$/, '').replace(/^\//,''));
            }
          }
        }
      } catch { /* ignore */ }

      const walk = (dir: string, depth: number) => {
        if (results.length >= MAX_FILES || depth > 15) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as fs.Dirent[];
        } catch { return; }

        for (const entry of entries) {
          if (results.length >= MAX_FILES) break;
          if (entry.name.startsWith('.')) continue;
          if (ignorePatterns.has(entry.name)) continue;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (entry.isFile()) {
            results.push(path.relative(rootPath, fullPath));
          }
        }
      };

      walk(rootPath, 0);
      return results.sort();
    } catch (error) {
      console.error('[IPC][file:list-all]', error);
      return { error: 'list_all_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const resolvedRead = path.resolve(raw);
      if (!resolvedRead.startsWith(os.homedir() + path.sep)) {
        return { error: 'path_outside_home' };
      }
      const fsp = await import('node:fs/promises');
      const MAX_FILE_SIZE = 512 * 1024; // 512 KB
      const stat = await fsp.stat(resolvedRead);
      if (!stat.isFile()) return { error: 'not_a_file' };
      const truncated = stat.size > MAX_FILE_SIZE;
      const handle = await fsp.open(resolvedRead, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_SIZE));
      await handle.read(buffer, 0, buffer.length, 0);
      await handle.close();
      return {
        path: resolvedRead,
        content: buffer.toString('utf-8'),
        truncated,
      };
    } catch (error) {
      console.error('[IPC][file:read]', error);
      return { error: 'read_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NOTIFY, (event, raw: unknown) => {
    if (!notificationManager) return;
    if (typeof raw !== 'object' || raw === null) return;
    const req = raw as Record<string, unknown>;
    if (typeof req.title !== 'string' || typeof req.body !== 'string') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    notificationManager.show(
      {
        title: req.title,
        body: req.body,
        urgency: (req.urgency as 'low' | 'normal' | 'critical') ?? 'normal',
      },
      win,
    );
  });

  ipcMain.handle(IPC_CHANNELS.NOTIFY_SET_ENABLED, (_event, raw: unknown) => {
    if (!notificationManager) return;
    if (typeof raw !== 'boolean') return;
    notificationManager.setEnabled(raw);
  });

  // Skills

  ipcMain.handle(IPC_CHANNELS.SKILLS_MANIFEST, async () => {
    return getSkillsManifest();
  });

  const VALID_SKILL_ID = /^[a-z0-9-]+$/;
  const KNOWN_AGENTS = new Set<string>(['claude', 'gemini', 'codex', 'aider', 'opencode',
    'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen']);

  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALL, async (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return { results: [], summary: { installed: 0, failed: 0, skipped: 0 } };
    const req = raw as { skillIds: string[]; targetAgents: string[] };
    if (!Array.isArray(req.skillIds) || !Array.isArray(req.targetAgents)) {
      return { results: [], summary: { installed: 0, failed: 0, skipped: 0 } };
    }
    // Validate each element: skillIds must match safe identifier pattern, targetAgents must be known
    const safeSkillIds = req.skillIds.filter((id): id is string => typeof id === 'string' && VALID_SKILL_ID.test(id));
    const safeTargetAgents = req.targetAgents.filter((a): a is string => typeof a === 'string' && KNOWN_AGENTS.has(a));
    return installSkills({ skillIds: safeSkillIds, targetAgents: safeTargetAgents as any });
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALLED, async () => {
    return loadInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_UNINSTALL, async (_event, skillId: unknown) => {
    if (typeof skillId !== 'string' || !/^[a-z0-9-]+$/.test(skillId)) return { error: 'Invalid skill ID' };
    return uninstallSkill(skillId);
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_DETECT_LANGS, async (_event, projectPath: unknown) => {
    if (typeof projectPath !== 'string') return [];
    return detectProjectLanguages(projectPath);
  });

  // Onboarding: detect git projects in common directories
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
      } catch { /* skip inaccessible directories */ }
    }

    return results
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)
      .map(({ name, path: p }) => ({ name, path: p }));
  });

  // Worktree operations
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
    if (typeof agentId !== 'string') return { success: false, mergedBranch: '', error: 'Invalid agent ID' };
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

  // Scrollback persistence

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

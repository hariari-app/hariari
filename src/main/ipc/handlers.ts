import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentManager } from '../agent/agent-manager';
import type { PtyManager } from '../pty/pty-manager';
import type { StateManager } from '../state/state-manager';
import type { ProjectManager } from '../project/project-manager';
import type { NotificationManager } from '../notification/notification-manager';
import { registerAgentToolingHandlers } from './agent-tooling-handlers';
import { registerGitHandlers } from './git-handlers';
import {
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
import { registerVoiceHandlers } from './voice-handlers';

const MAX_AGENTS = 20;

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

  registerVoiceHandlers();

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
      fs.writeFileSync(resolved, req.content, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('[IPC][file:write]', error);
      return { error: 'write_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_request' };
      const resolved = path.resolve(raw);
      fs.mkdirSync(resolved, { recursive: true });
      return { success: true };
    } catch (error) {
      console.error('[IPC][file:mkdir]', error);
      return { error: 'mkdir_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'object' || raw === null) return { error: 'invalid_request' };
      const req = raw as Record<string, unknown>;
      if (typeof req.oldPath !== 'string' || typeof req.newPath !== 'string') {
        return { error: 'invalid_request' };
      }
      const resolvedOld = path.resolve(req.oldPath);
      const resolvedNew = path.resolve(req.newPath);
      // Ensure destination directory exists
      fs.mkdirSync(path.dirname(resolvedNew), { recursive: true });
      fs.renameSync(resolvedOld, resolvedNew);
      return { success: true };
    } catch (error) {
      console.error('[IPC][file:rename]', error);
      return { error: 'rename_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_request' };
      const resolved = path.resolve(raw);
      fs.rmSync(resolved, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      console.error('[IPC][file:delete]', error);
      return { error: 'delete_failed' };
    }
  });

  // NOTE: keybindings and settings handlers are registered early in index.ts
  // to avoid race conditions with the renderer.

  // Notification handlers
  // File handlers
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIR, async (_event, raw: unknown) => {
    try {
      if (typeof raw !== 'string') return { error: 'invalid_path' };
      const resolved = path.resolve(raw);
      const fsp = await import('node:fs/promises');
      const entries = await fsp.readdir(resolved, { withFileTypes: true });
      const result = entries
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

  registerGitHandlers();

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

  registerAgentToolingHandlers(agentManager);
}

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { AgentStatus } from '../shared/agent-types';

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  appVersion: APP_VERSION,
  pty: {
    spawn: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, request),
    write: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_WRITE, request),
    resize: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_RESIZE, request),
    kill: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL, request),
    onData: (callback: (event: { sessionId: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; data: string }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
      };
    },
  },
  agent: {
    checkInstalled: (command: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_CHECK_INSTALLED, command),
    spawn: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SPAWN, request),
    kill: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_KILL, agentId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST),
    onStatus: (callback: (event: { agentId: string; status: AgentStatus }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; status: AgentStatus }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATUS, handler);
      };
    },
    onExit: (callback: (event: { agentId: string; exitCode: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; exitCode: number }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_EXIT, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_EXIT, handler);
      };
    },
    onVersion: (callback: (event: { agentId: string; version: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; version: string }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_VERSION, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.AGENT_VERSION, handler); };
    },
    onAvailabilityChanged: (callback: (availability: Record<string, boolean>) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Record<string, boolean>) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_AVAILABILITY_CHANGED, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.AGENT_AVAILABILITY_CHANGED, handler); };
    },
  },
  project: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
    create: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, request),
    remove: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE, projectId),
    update: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, request),
    pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_PICK_DIR),
    loadState: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_STATE_LOAD, projectId),
    saveState: (state: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_STATE_SAVE, state),
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    zoomIn: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ZOOM_IN),
    zoomOut: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ZOOM_OUT),
    zoomReset: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_ZOOM_RESET),
    popoutFile: (projectPath: string, filePath?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_POPOUT_FILE, { projectPath, filePath }),
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_LOAD),
    save: (settings: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),
  },
  keybindings: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.KEYBINDINGS_LOAD),
    save: (overrides: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KEYBINDINGS_SAVE, overrides),
  },
  voice: {
    transcribe: (request: { provider: string; apiKey: string; audioBase64: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, request),
    formatLLM: (request: { provider: string; apiKey: string; messages: Array<{ role: string; content: string }> }) =>
      ipcRenderer.invoke(IPC_CHANNELS.VOICE_FORMAT_LLM, request),
  },
  git: {
    status: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, projectPath),
    diff: (request: { projectPath: string; filePath: string; group: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, request),
    show: (request: { projectPath: string; filePath: string; ref: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_SHOW, request),
    discard: (request: { projectPath: string; filePath: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD, request),
    stage: (request: { projectPath: string; filePath: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, request),
    unstage: (request: { projectPath: string; filePath: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, request),
    stageAll: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE_ALL, projectPath),
    unstageAll: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE_ALL, projectPath),
    discardAll: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD_ALL, projectPath),
    commit: (request: { projectPath: string; message: string; amend?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, request),
    log: (request: { projectPath: string; maxCount?: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_LOG, request),
    pull: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, projectPath),
    push: (request: { projectPath: string; setUpstream?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, request),
    aheadBehind: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_AHEAD_BEHIND, projectPath),
  },
  file: {
    listDir: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIR, dirPath),
    listAll: (rootPath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_ALL, rootPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, { path: filePath, content }),
    search: (request: { projectPath: string; query: string; maxResults?: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_SEARCH, request),
  },
  notify: {
    show: (request: { title: string; body: string; urgency?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTIFY, request),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_SET_ENABLED, enabled),
  },
  session: {
    list: (agentId?: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, agentId),
  },
  state: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.STATE_LOAD),
    save: (state: unknown) => ipcRenderer.invoke(IPC_CHANNELS.STATE_SAVE, state),
  },
  clipboard: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_READ),
    readImage: () => ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_READ_IMAGE) as Promise<string | null>,
    write: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_WRITE, text),
  },
  onboarding: {
    detectProjects: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_DETECT_PROJECTS),
  },
  skills: {
    manifest: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_MANIFEST),
    install: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALL, request),
    installed: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALLED),
    uninstall: (skillId: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_UNINSTALL, skillId),
    detectLanguages: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DETECT_LANGS, projectPath),
  },
  worktree: {
    diff: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_DIFF, agentId),
    diffFile: (request: { agentId: string; filePath: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_DIFF_FILE, request),
    merge: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE, agentId),
    cleanup: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP, agentId),
    info: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_INFO, agentId),
  },
  scrollback: {
    save: (sessionId: string, data: string) => ipcRenderer.invoke(IPC_CHANNELS.SCROLLBACK_SAVE, { sessionId, data }),
    load: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SCROLLBACK_LOAD, sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SCROLLBACK_DELETE, sessionId),
  },
  update: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
    onStatus: (callback: (status: { state: string; version?: string; progress?: number; error?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: { state: string; version?: string; progress?: number; error?: string }) =>
        callback(status);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, handler);
      };
    },
  },
});

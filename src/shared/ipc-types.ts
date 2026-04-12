import type { AgentConfig, AgentInfo, AgentStatus, AgentType } from './agent-types';
import type { LayoutNode } from './layout-types';
import type { SessionRecording } from './session-types';

export interface PtySpawnRequest {
  readonly agentId: string;
  readonly config: AgentConfig;
}

export interface PtySpawnResponse {
  readonly sessionId: string;
}

export interface PtyWriteRequest {
  readonly sessionId: string;
  readonly data: string;
}

export interface PtyResizeRequest {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyKillRequest {
  readonly sessionId: string;
}

export interface PtyDataEvent {
  readonly sessionId: string;
  readonly data: string;
}

export interface AgentSpawnRequest {
  readonly type: AgentType;
  readonly projectId: string;
  readonly cwd?: string;
  readonly label?: string;
  readonly useWorktree?: boolean;
}

export interface AgentStatusEvent {
  readonly agentId: string;
  readonly status: AgentStatus;
}

export interface AgentExitEvent {
  readonly agentId: string;
  readonly exitCode: number;
}

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pinned: boolean;
  readonly lastActiveAt: number;
  readonly createdAt: number;
}

export interface ProjectCreateRequest {
  readonly path: string;
  readonly name?: string;
}

export interface ProjectUpdateRequest {
  readonly id: string;
  readonly name?: string;
  readonly pinned?: boolean;
}

export interface ProjectWorkspaceState {
  readonly projectId: string;
  readonly layout: LayoutNode | null;
  readonly agents: ReadonlyArray<{
    readonly type: AgentType;
    readonly cwd: string;
    readonly label?: string;
  }>;
}

export interface AppState {
  readonly window: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly isMaximized: boolean;
  };
  readonly activeProjectId: string | null;
  readonly sidebarCollapsed: boolean;
  readonly layout: LayoutNode | null;
  readonly agents: ReadonlyArray<{
    readonly type: AgentType;
    readonly cwd: string;
    readonly label?: string;
  }>;
}

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly size?: number;
}

export interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface FileSearchResult {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}

export interface UpdateStatus {
  readonly state: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-available' | 'error';
  readonly version?: string;
  readonly progress?: number;
  readonly error?: string;
  readonly downloadUrl?: string;
}

export interface HariariApi {
  platform: NodeJS.Platform;
  appVersion: string;
  pty: {
    spawn(request: PtySpawnRequest): Promise<PtySpawnResponse>;
    write(request: PtyWriteRequest): Promise<void>;
    resize(request: PtyResizeRequest): Promise<void>;
    kill(request: PtyKillRequest): Promise<void>;
    onData(callback: (event: PtyDataEvent) => void): () => void;
  };
  agent: {
    checkInstalled(command: string): Promise<{ installed: boolean; version?: string }>;
    install(agentType: string): Promise<{ success: boolean; error?: string }>;
    onInstallOutput(callback: (event: { agentType: string; data: string }) => void): () => void;
    spawn(request: AgentSpawnRequest): Promise<AgentInfo>;
    kill(agentId: string): Promise<void>;
    list(): Promise<AgentInfo[]>;
    onStatus(callback: (event: AgentStatusEvent) => void): () => void;
    onExit(callback: (event: AgentExitEvent) => void): () => void;
    onVersion(callback: (event: { agentId: string; version: string }) => void): () => void;
    onAvailabilityChanged(callback: (availability: Record<string, boolean>) => void): () => void;
  };
  project: {
    list(): Promise<ProjectInfo[]>;
    create(request: ProjectCreateRequest): Promise<ProjectInfo>;
    remove(projectId: string): Promise<void>;
    update(request: ProjectUpdateRequest): Promise<ProjectInfo>;
    pickDirectory(): Promise<string | null>;
    loadState(projectId: string): Promise<ProjectWorkspaceState | null>;
    saveState(state: ProjectWorkspaceState): Promise<void>;
  };
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    zoomIn(): Promise<void>;
    zoomOut(): Promise<void>;
    zoomReset(): Promise<void>;
    popoutFile(projectPath: string, filePath?: string): Promise<void>;
    popoutEditor(projectPath: string, branchName?: string): Promise<void>;
  };
  settings: {
    load(): Promise<Record<string, unknown>>;
    save(settings: Record<string, unknown>): Promise<void>;
  };
  keybindings: {
    load(): Promise<Record<string, string>>;
    save(overrides: Record<string, string>): Promise<void>;
  };
  voice: {
    transcribe(request: { provider: string; audioBase64: string }): Promise<{ text?: string; error?: string }>;
    formatLLM(request: { provider: string; messages: Array<{ role: string; content: string }> }): Promise<{ text?: string; error?: string }>;
  };
  git: {
    status(projectPath: string): Promise<import('./git-types').GitStatusResult>;
    diff(request: { projectPath: string; filePath: string; group: string }): Promise<import('./git-types').GitDiffResult>;
    show(request: { projectPath: string; filePath: string; ref: string }): Promise<{ content: string }>;
    discard(request: { projectPath: string; filePath: string }): Promise<{ success?: boolean; error?: string }>;
    stage(request: { projectPath: string; filePath: string }): Promise<{ success?: boolean; error?: string }>;
    unstage(request: { projectPath: string; filePath: string }): Promise<{ success?: boolean; error?: string }>;
    stageAll(projectPath: string): Promise<{ success?: boolean; error?: string }>;
    unstageAll(projectPath: string): Promise<{ success?: boolean; error?: string }>;
    discardAll(projectPath: string): Promise<{ success?: boolean; error?: string }>;
    commit(request: { projectPath: string; message: string; amend?: boolean }): Promise<{ success?: boolean; hash?: string; error?: string }>;
    log(request: { projectPath: string; maxCount?: number }): Promise<import('./git-types').GitLogResult>;
    pull(projectPath: string): Promise<{ success?: boolean; output?: string; error?: string }>;
    push(request: { projectPath: string; setUpstream?: boolean }): Promise<{ success?: boolean; error?: string }>;
    aheadBehind(projectPath: string): Promise<import('./git-types').GitAheadBehind>;
  };
  file: {
    listDir(dirPath: string): Promise<FileEntry[]>;
    listAll(rootPath: string): Promise<string[]>;
    read(filePath: string): Promise<FileContent>;
    write(filePath: string, content: string): Promise<{ success?: boolean; error?: string }>;
    mkdir(dirPath: string): Promise<{ success?: boolean; error?: string }>;
    rename(oldPath: string, newPath: string): Promise<{ success?: boolean; error?: string }>;
    delete(filePath: string): Promise<{ success?: boolean; error?: string }>;
    search(request: { projectPath: string; query: string; maxResults?: number }): Promise<FileSearchResult[]>;
  };
  notify: {
    show(request: { title: string; body: string; urgency?: 'low' | 'normal' | 'critical' }): Promise<void>;
    setEnabled(enabled: boolean): Promise<void>;
  };
  session: {
    list(agentId?: string): Promise<SessionRecording[]>;
  };
  state: {
    load(): Promise<AppState | null>;
    save(state: AppState): Promise<void>;
  };
  scrollback: {
    save(sessionId: string, data: string): Promise<void>;
    load(sessionId: string): Promise<string | null>;
    delete(sessionId: string): Promise<void>;
  };
  clipboard: {
    read(): Promise<string>;
    readImage(): Promise<string | null>;
    write(text: string): Promise<void>;
    onTriggerPaste(handler: () => void): () => void;
  };
  onboarding: {
    detectProjects(): Promise<Array<{ name: string; path: string }>>;
  };
  skills: {
    manifest(): Promise<import('./skills-types').SkillManifest>;
    install(request: import('./skills-types').SkillInstallRequest): Promise<import('./skills-types').SkillsInstallResponse>;
    installed(): Promise<readonly import('./skills-types').InstalledSkillRecord[]>;
    uninstall(skillId: string): Promise<{ success?: boolean; error?: string }>;
    detectLanguages(projectPath: string): Promise<readonly string[]>;
  };
  worktree: {
    diff(agentId: string): Promise<import('./worktree-types').WorktreeDiffSummary | null>;
    diffFile(request: { agentId: string; filePath: string }): Promise<{ original: string; modified: string } | null>;
    merge(agentId: string): Promise<import('./worktree-types').WorktreeMergeResult>;
    cleanup(agentId: string): Promise<void>;
    info(agentId: string): Promise<import('./worktree-types').WorktreeInfo | null>;
  };
  update: {
    check(): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
    onStatus(callback: (status: UpdateStatus) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
}

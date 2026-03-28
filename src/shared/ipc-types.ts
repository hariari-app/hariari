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

export interface VibeIDEApi {
  pty: {
    spawn(request: PtySpawnRequest): Promise<PtySpawnResponse>;
    write(request: PtyWriteRequest): Promise<void>;
    resize(request: PtyResizeRequest): Promise<void>;
    kill(request: PtyKillRequest): Promise<void>;
    onData(callback: (event: PtyDataEvent) => void): () => void;
  };
  agent: {
    spawn(request: AgentSpawnRequest): Promise<AgentInfo>;
    kill(agentId: string): Promise<void>;
    list(): Promise<AgentInfo[]>;
    onStatus(callback: (event: AgentStatusEvent) => void): () => void;
    onExit(callback: (event: AgentExitEvent) => void): () => void;
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
    transcribe(request: { provider: string; apiKey: string; audioBase64: string }): Promise<{ text?: string; error?: string }>;
    formatLLM(request: { provider: string; apiKey: string; messages: Array<{ role: string; content: string }> }): Promise<{ text?: string; error?: string }>;
  };
  file: {
    listDir(dirPath: string): Promise<FileEntry[]>;
    listAll(rootPath: string): Promise<string[]>;
    read(filePath: string): Promise<FileContent>;
    write(filePath: string, content: string): Promise<{ success?: boolean; error?: string }>;
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
}

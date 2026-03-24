import type { AgentConfig, AgentInfo, AgentStatus, AgentType } from './agent-types';

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
}

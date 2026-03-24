export type AgentType = 'claude' | 'gemini' | 'codex' | 'shell' | 'custom';
export type AgentStatus = 'starting' | 'running' | 'stopped' | 'error';

export const SPAWNABLE_AGENT_TYPES = new Set<AgentType>(['claude', 'gemini', 'codex', 'shell']);

export interface AgentConfig {
  readonly type: AgentType;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly label?: string;
}

export interface AgentInfo {
  readonly id: string;
  readonly config: AgentConfig;
  readonly status: AgentStatus;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly pid?: number;
}

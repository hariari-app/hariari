export type AgentType = 'claude' | 'gemini' | 'codex' | 'pi' | 'opencode' | 'cline' | 'copilot' | 'amp' | 'continue' | 'cursor' | 'crush' | 'qwen' | 'shell' | 'custom';
export type AgentStatus = 'starting' | 'running' | 'needs-input' | 'idle' | 'complete' | 'error' | 'stopped';

export const SPAWNABLE_AGENT_TYPES = new Set<AgentType>(['claude', 'gemini', 'codex', 'pi', 'opencode', 'cline', 'copilot', 'amp', 'continue', 'cursor', 'crush', 'qwen', 'shell']);

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
  readonly projectId: string;
  readonly config: AgentConfig;
  readonly status: AgentStatus;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly pid?: number;
  readonly version?: string;
  readonly worktree?: {
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseBranch: string;
  };
}

export interface AgentAvailability {
  readonly claude: boolean;
  readonly gemini: boolean;
  readonly codex: boolean;
  readonly pi: boolean;
  readonly opencode: boolean;
  readonly cline: boolean;
  readonly copilot: boolean;
  readonly amp: boolean;
  readonly continue: boolean;
  readonly cursor: boolean;
  readonly crush: boolean;
  readonly qwen: boolean;
}

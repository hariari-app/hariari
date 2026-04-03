import type { AgentInfo } from './agent-types';

export interface PreviewAgent {
  readonly agentInfo: AgentInfo;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectPath: string;
}

export const ACTIVE_STATUSES = new Set(['running', 'needs-input', 'idle', 'starting']);

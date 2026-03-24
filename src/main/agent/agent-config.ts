import type { AgentConfig, AgentType } from '../../shared/agent-types';

const AGENT_DEFAULTS: Record<Exclude<AgentType, 'custom'>, Omit<AgentConfig, 'cwd'>> = {
  claude: { type: 'claude', command: 'claude', args: [], label: 'Claude Code' },
  gemini: { type: 'gemini', command: 'gemini', args: [], label: 'Gemini CLI' },
  codex: { type: 'codex', command: 'codex', args: [], label: 'Codex' },
  shell: {
    type: 'shell',
    command: process.env.SHELL || '/bin/bash',
    args: [],
    label: 'Shell',
  },
};

export function getDefaultAgentConfig(type: AgentType, cwd: string): AgentConfig {
  if (type === 'custom') {
    throw new Error('Custom agent type requires explicit configuration');
  }

  return { ...AGENT_DEFAULTS[type], cwd };
}

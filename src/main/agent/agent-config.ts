import type { AgentConfig, AgentType } from '../../shared/agent-types';

const AGENT_DEFAULTS: Record<Exclude<AgentType, 'custom'>, Omit<AgentConfig, 'cwd'>> = {
  claude: { type: 'claude', command: 'claude', args: [], label: 'Claude Code' },
  gemini: { type: 'gemini', command: 'gemini', args: [], label: 'Gemini CLI' },
  codex: { type: 'codex', command: 'codex', args: [], label: 'Codex' },
  pi: { type: 'pi', command: 'pi', args: [], label: 'Pi' },
  opencode: { type: 'opencode', command: 'opencode', args: [], label: 'OpenCode' },
  cline: { type: 'cline', command: 'cline', args: [], label: 'Cline' },
  copilot: { type: 'copilot', command: 'copilot', args: [], label: 'Copilot CLI' },
  amp: { type: 'amp', command: 'amp', args: [], label: 'Amp' },
  continue: { type: 'continue', command: 'cn', args: [], label: 'Continue' },
  cursor: { type: 'cursor', command: 'cursor-agent', args: [], label: 'Cursor CLI' },
  crush: { type: 'crush', command: 'crush', args: [], label: 'Crush' },
  qwen: { type: 'qwen', command: 'qwen', args: [], label: 'Qwen Code' },
  shell: {
    type: 'shell',
    command: process.platform === 'win32'
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash'),
    args: [],
    label: 'Shell',
  },
};

export function getDefaultAgentConfig(type: AgentType, cwd: string): AgentConfig {
  if (type === 'custom') {
    throw new Error('Custom agent type requires explicit configuration');
  }

  const config = { ...AGENT_DEFAULTS[type], cwd };

  // On Windows, globally-installed npm CLIs are .cmd batch scripts.
  // node-pty uses CreateProcessW which cannot execute .cmd files directly.
  // Wrap via cmd.exe /c so cmd.exe resolves the command from PATH.
  if (process.platform === 'win32' && type !== 'shell') {
    config.args = ['/c', config.command, ...config.args];
    config.command = 'cmd.exe';
  }

  return config;
}

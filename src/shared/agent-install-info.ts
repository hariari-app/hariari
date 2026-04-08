import type { AgentType } from './agent-types';

export interface AgentInstallInfo {
  readonly command: string;
  readonly displayName: string;
  readonly installCommand: string;
  readonly docsUrl: string;
  readonly description: string;
}

export const AGENT_INSTALL_INFO: Partial<Record<AgentType, AgentInstallInfo>> = {
  claude: {
    command: 'claude',
    displayName: 'Claude Code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    description: 'Anthropic\'s AI coding agent for the terminal',
  },
  gemini: {
    command: 'gemini',
    displayName: 'Gemini CLI',
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    description: 'Google\'s AI coding agent',
  },
  codex: {
    command: 'codex',
    displayName: 'Codex CLI',
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
    description: 'OpenAI\'s coding agent',
  },
  pi: {
    command: 'pi',
    displayName: 'Pi',
    installCommand: 'npm install -g @mariozechner/pi-coding-agent',
    docsUrl: 'https://pi.dev',
    description: 'Minimal terminal coding harness — extensible via TypeScript',
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
    installCommand: 'npm install -g opencode-ai@latest',
    docsUrl: 'https://opencode.ai/docs/',
    description: 'Terminal-based AI coding agent with TUI',
  },
  cline: {
    command: 'cline',
    displayName: 'Cline CLI',
    installCommand: 'npm install -g cline',
    docsUrl: 'https://cline.bot',
    description: 'AI agent control plane for your terminal',
  },
  amp: {
    command: 'amp',
    displayName: 'Amp',
    installCommand: 'npm install -g @sourcegraph/amp@latest',
    docsUrl: 'https://sourcegraph.com/amp',
    description: 'Sourcegraph\'s agentic coding assistant',
  },
  continue: {
    command: 'cn',
    displayName: 'Continue',
    installCommand: 'npm install -g @continuedev/cli',
    docsUrl: 'https://docs.continue.dev/cli/overview',
    description: 'Open-source AI code assistant — same engine as the IDE extension',
  },
  qwen: {
    command: 'qwen',
    displayName: 'Qwen Code',
    installCommand: 'npm install -g qwen-code',
    docsUrl: 'https://github.com/QwenLM/qwen-code',
    description: 'Alibaba\'s AI coding agent — 1,000 free requests/day',
  },
};

import type { AgentType } from './agent-types';

export interface AgentInstallInfo {
  readonly command: string;
  readonly displayName: string;
  readonly installCommand: string;
  readonly docsUrl: string;
  readonly description: string;
}

type Platform = 'darwin' | 'win32' | 'linux';

interface PlatformCommands {
  readonly npm: string;
  readonly mac?: string;
  readonly win?: string;
}

function getPlatform(): Platform {
  if (typeof window !== 'undefined' && 'api' in window) {
    return (window as { api: { platform: Platform } }).api.platform;
  }
  if (typeof process !== 'undefined') {
    return process.platform as Platform;
  }
  return 'linux';
}

function pick(commands: PlatformCommands): string {
  const platform = getPlatform();
  if (platform === 'darwin' && commands.mac) return commands.mac;
  if (platform === 'win32' && commands.win) return commands.win;
  return commands.npm;
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
    installCommand: 'npm install -g @anthropic-ai/gemini-cli',
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
  aider: {
    command: 'aider',
    displayName: 'Aider',
    installCommand: 'pip install aider-chat',
    docsUrl: 'https://aider.chat/',
    description: 'AI pair programming in your terminal — supports 100+ LLMs',
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
  copilot: {
    command: 'copilot',
    displayName: 'GitHub Copilot CLI',
    installCommand: pick({
      npm: 'npm install -g @github/copilot',
      win: 'winget install GitHub.cli && gh extension install github/gh-copilot',
    }),
    docsUrl: 'https://docs.github.com/en/copilot',
    description: 'GitHub\'s AI coding assistant for the terminal',
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
  cursor: {
    command: 'cursor-agent',
    displayName: 'Cursor CLI',
    installCommand: pick({
      npm: 'curl https://cursor.com/install -fsS | bash',
      win: 'powershell -c "irm https://cursor.com/install.ps1 | iex"',
    }),
    docsUrl: 'https://cursor.com/cli',
    description: 'Cursor\'s AI coding agent for the terminal',
  },
  crush: {
    command: 'crush',
    displayName: 'Crush',
    installCommand: 'go install github.com/charmbracelet/crush@latest',
    docsUrl: 'https://github.com/charmbracelet/crush',
    description: 'Charmbracelet\'s terminal AI agent with Bubble Tea TUI',
  },
  qwen: {
    command: 'qwen',
    displayName: 'Qwen Code',
    installCommand: pick({
      npm: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh | bash',
      win: 'powershell -c "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.ps1 | iex"',
    }),
    docsUrl: 'https://github.com/QwenLM/qwen-code',
    description: 'Alibaba\'s AI coding agent — 1,000 free requests/day',
  },
};

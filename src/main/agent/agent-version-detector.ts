import { execFile } from 'child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentType, AgentAvailability } from '../../shared/agent-types';

const CLI_COMMANDS: Partial<Record<AgentType, string>> = {
  claude: 'claude',
  gemini: 'gemini',
  codex: 'codex',
  pi: 'pi',
  opencode: 'opencode',
  cline: 'cline',
  copilot: 'copilot',
  amp: 'amp',
  continue: 'cn',
  cursor: 'cursor-agent',
  crush: 'crush',
  qwen: 'qwen',
};

const VERSION_TIMEOUT_MS = 5000;
const WHICH_TIMEOUT_MS = 3000;

// Electron GUI apps on macOS don't inherit shell PATH.
// Build an enriched PATH with common tool locations.
function getEnrichedEnv(): Record<string, string | undefined> {
  const home = process.env.HOME || '';
  const extraPaths = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
  ];

  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  try {
    const versionsDir = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(versionsDir)) {
      const versions = fs.readdirSync(versionsDir).sort().reverse();
      if (versions.length > 0) {
        extraPaths.unshift(path.join(versionsDir, versions[0], 'bin'));
      }
    }
  } catch { /* nvm not installed */ }

  return {
    ...process.env,
    PATH: [...extraPaths, process.env.PATH || ''].join(':'),
  };
}

export function detectVersion(type: AgentType): Promise<string | null> {
  const cmd = CLI_COMMANDS[type];
  if (!cmd) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: getEnrichedEnv() }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const firstLine = stdout.trim().split('\n')[0] ?? '';
      const match = firstLine.match(/v?(\d+\.\d+[\d.]*)/);
      resolve(match ? match[1] : firstLine.slice(0, 50) || null);
    });
  });
}

function checkCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [cmd], { timeout: WHICH_TIMEOUT_MS, env: getEnrichedEnv() }, (err) => {
      resolve(!err);
    });
  });
}

export async function checkAvailability(): Promise<AgentAvailability> {
  const [claude, gemini, codex, pi, opencode, cline, copilot, amp, cn, cursor, crush, qwen] = await Promise.all([
    checkCommand('claude'),
    checkCommand('gemini'),
    checkCommand('codex'),
    checkCommand('pi'),
    checkCommand('opencode'),
    checkCommand('cline'),
    checkCommand('copilot'),
    checkCommand('amp'),
    checkCommand('cn'),
    checkCommand('cursor-agent'),
    checkCommand('crush'),
    checkCommand('qwen'),
  ]);
  return { claude, gemini, codex, pi, opencode, cline, copilot, amp, continue: cn, cursor, crush, qwen };
}

export function startPeriodicCheck(
  callback: (availability: AgentAvailability) => void,
  intervalMs = 30_000,
): () => void {
  let previous: AgentAvailability = { claude: false, gemini: false, codex: false, pi: false, opencode: false, cline: false, copilot: false, amp: false, continue: false, cursor: false, crush: false, qwen: false };

  const check = async () => {
    const current = await checkAvailability();
    const changed = (Object.keys(current) as Array<keyof AgentAvailability>).some(
      (k) => current[k] !== previous[k],
    );
    if (changed) {
      previous = current;
      callback(current);
    }
  };

  check();
  const timer = setInterval(check, intervalMs);
  return () => clearInterval(timer);
}

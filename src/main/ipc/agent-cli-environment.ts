import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_AGENT_COMMANDS = new Set([
  'claude',
  'gemini',
  'codex',
  'pi',
  'opencode',
  'cline',
  'copilot',
  'amp',
  'cn',
  'cursor-agent',
  'crush',
  'qwen',
]);

export function isAllowedAgentCommand(value: string): boolean {
  return (
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    ALLOWED_AGENT_COMMANDS.has(value)
  );
}

export function buildAgentCommandEnv(): NodeJS.ProcessEnv {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pathEntries =
    process.platform === 'win32'
      ? getWindowsPathEntries(resolveHomeDir())
      : getPosixPathEntries(resolveHomeDir());
  return { ...process.env, PATH: [...pathEntries, process.env.PATH || ''].join(pathSep) };
}

export function resolveHomeDir(): string {
  return process.platform === 'win32'
    ? process.env.USERPROFILE || process.env.HOME || ''
    : process.env.HOME || '';
}

export function getLookupCommand(): string {
  return process.platform === 'win32' ? 'where.exe' : 'which';
}

function getWindowsPathEntries(home: string): string[] {
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const entries = [
    path.join(appData, 'npm'),
    path.join(localAppData, 'Programs', 'Python', 'Python3*', 'Scripts'),
    path.join(home, '.cargo', 'bin'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
    path.join(home, 'scoop', 'shims'),
  ];
  prependExisting(entries, process.env.NVM_SYMLINK || path.join(appData, 'nvm', 'current'));
  prependExisting(entries, process.env.NVM_HOME || path.join(appData, 'nvm'));
  return entries;
}

function getPosixPathEntries(home: string): string[] {
  const entries = [
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];
  if (process.platform === 'darwin') {
    entries.unshift('/opt/homebrew/sbin');
    entries.unshift('/opt/homebrew/bin');
  }
  prependExisting(entries, resolveLatestNvmBin(home));
  return entries;
}

function resolveLatestNvmBin(home: string): string | null {
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    if (!fs.existsSync(versionsDir)) return null;
    const version = fs.readdirSync(versionsDir).sort().reverse()[0];
    return version ? path.join(versionsDir, version, 'bin') : null;
  } catch {
    return null;
  }
}

function prependExisting(entries: string[], candidate: string | null): void {
  if (candidate && fs.existsSync(candidate)) {
    entries.unshift(candidate);
  }
}

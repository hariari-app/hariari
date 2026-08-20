import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

const ONBOARDING_SEARCH_DIRS = [
  'projects',
  'code',
  'dev',
  'src',
  'repos',
  path.join('Documents', 'GitHub'),
  'workspace',
];

export function registerOnboardingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_DETECT_PROJECTS, () => detectOnboardingProjects());
}

async function detectOnboardingProjects(): Promise<Array<{ name: string; path: string }>> {
  const home = os.homedir();
  const results = ONBOARDING_SEARCH_DIRS.flatMap((dir) => collectProjects(path.join(home, dir)));
  return results
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 10)
    .map(({ name, path: projectPath }) => ({ name, path: projectPath }));
}

function collectProjects(dir: string): Array<{ name: string; path: string; mtime: number }> {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .flatMap((entry) => readProjectEntry(dir, entry.name));
  } catch {
    return [];
  }
}

function readProjectEntry(
  parentDir: string,
  entryName: string,
): Array<{ name: string; path: string; mtime: number }> {
  const fullPath = path.join(parentDir, entryName);
  if (!fs.existsSync(path.join(fullPath, '.git'))) return [];
  const stat = fs.statSync(fullPath);
  return [{ name: entryName, path: fullPath, mtime: stat.mtimeMs }];
}

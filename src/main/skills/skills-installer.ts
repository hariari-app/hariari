// Skills installer — downloads from GitHub releases and copies to agent config dirs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import https from 'node:https';
import type { AgentType } from '../../shared/agent-types';
import type { SkillInstallRequest, SkillsInstallResponse, SkillInstallResult, InstalledSkillRecord } from '../../shared/skills-types';
import { getSkillsManifest } from './skills-manifest';

const SKILLS_DIR = path.join(homedir(), '.hariari', 'skills');
const INSTALLED_JSON = path.join(SKILLS_DIR, 'installed.json');

const REPO_OWNER = 'hariari-app';
const REPO_NAME = 'AISkills';
const BRANCH = 'main';

// Agent config directories where skills get copied
const AGENT_SKILL_DIRS: Partial<Record<AgentType, string>> = {
  claude: path.join(homedir(), '.claude', 'skills'),
  codex: path.join(homedir(), '.codex', 'skills'),
  gemini: path.join(homedir(), '.gemini', 'rules'),
  pi: path.join(homedir(), '.pi', 'skills'),
  cursor: path.join(homedir(), '.cursor', 'rules'),
  copilot: path.join(homedir(), '.copilot', 'skills'),
  amp: path.join(homedir(), '.amp', 'skills'),
  continue: path.join(homedir(), '.continue', 'skills'),
  crush: path.join(homedir(), '.crush', 'skills'),
  qwen: path.join(homedir(), '.qwen', 'skills'),
};

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

const ALLOWED_REDIRECT_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com']);

function isAllowedRedirect(location: string | undefined): location is string {
  if (!location) return false;
  try {
    const parsed = new URL(location);
    return parsed.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
const MAX_RECURSION_DEPTH = 5;
const MAX_FILES_PER_SKILL = 50;

function fetchRaw(filePath: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${filePath}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!isAllowedRedirect(location)) {
          reject(new Error(`Redirect to disallowed host rejected for ${filePath}`));
          return;
        }
        https.get(location, (redirectRes) => {
          let data = '';
          let size = 0;
          redirectRes.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_FILE_SIZE) { redirectRes.destroy(); reject(new Error(`File too large: ${filePath}`)); return; }
            data += chunk;
          });
          redirectRes.on('end', () => resolve(data));
          redirectRes.on('error', reject);
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${filePath}`));
        return;
      }
      let data = '';
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_SIZE) { res.destroy(); reject(new Error(`File too large: ${filePath}`)); return; }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchDirectory(dirPath: string): Promise<Array<{ name: string; path: string; type: string }>> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${dirPath}?ref=${BRANCH}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Hariari', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
      if (res.statusCode === 403) {
        reject(new Error('GitHub API rate limit exceeded. Try again later.'));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching directory ${dirPath}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const items = JSON.parse(data);
          if (Array.isArray(items)) {
            resolve(items.map((i: { name: string; path: string; type: string }) => ({
              name: i.name, path: i.path, type: i.type,
            })));
          } else if (items.name && items.path && items.type) {
            resolve([{ name: items.name, path: items.path, type: items.type }]);
          } else {
            resolve([]);
          }
        } catch { resolve([]); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function installSkillFiles(archivePath: string, targetDir: string, depth = 0, fileCount = { n: 0 }): Promise<void> {
  if (depth > MAX_RECURSION_DEPTH || fileCount.n > MAX_FILES_PER_SKILL) return;
  const items = await fetchDirectory(archivePath);

  for (const item of items) {
    if (fileCount.n > MAX_FILES_PER_SKILL) break;
    const safeName = path.basename(item.name);
    if (!safeName || safeName.startsWith('.')) continue;
    if (item.type === 'file') {
      fileCount.n++;
      const content = await fetchRaw(item.path);
      const destPath = path.join(targetDir, safeName);
      await fs.writeFile(destPath, content, 'utf-8');
    } else if (item.type === 'dir') {
      const subDir = path.join(targetDir, safeName);
      await ensureDir(subDir);
      await installSkillFiles(item.path, subDir, depth + 1, fileCount);
    }
  }
}

export async function installSkills(request: SkillInstallRequest): Promise<SkillsInstallResponse> {
  const manifest = getSkillsManifest();
  const results: SkillInstallResult[] = [];

  await ensureDir(SKILLS_DIR);

  for (const skillId of request.skillIds) {
    const skill = manifest.skills.find((s) => s.id === skillId);
    if (!skill) {
      results.push({ skillId, status: 'skipped', error: 'Skill not found in manifest' });
      continue;
    }

    try {
      // Download to hariari cache
      const cacheDir = path.join(SKILLS_DIR, 'cache', skill.id);
      await ensureDir(cacheDir);
      await installSkillFiles(skill.archivePath, cacheDir);

      // Copy to each target agent directory
      for (const agentType of request.targetAgents) {
        if (!skill.targetAgents.includes(agentType)) continue;
        const agentDir = AGENT_SKILL_DIRS[agentType];
        if (!agentDir) continue;

        const destDir = path.join(agentDir, skill.id);
        await ensureDir(destDir);

        // Copy all files from cache to agent dir
        await copyDir(cacheDir, destDir);
      }

      results.push({ skillId, status: 'installed' });
    } catch (error) {
      results.push({
        skillId,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Update installed.json
  await updateInstalledRecord(results, manifest.version, request.targetAgents.map(String));

  const installed = results.filter((r) => r.status === 'installed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return { results, summary: { installed, failed, skipped } };
}

async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function updateInstalledRecord(results: readonly SkillInstallResult[], version: string, targetAgents: readonly string[]): Promise<void> {
  try {
    const existing = await loadInstalled();
    const now = Date.now();
    const newRecords = results
      .filter((r) => r.status === 'installed')
      .map((r) => ({
        skillId: r.skillId,
        version,
        installedAt: now,
        targetAgents: [...targetAgents],
      }));

    // Merge: update existing, add new
    const merged = [...existing.filter((e) => !newRecords.some((n) => n.skillId === e.skillId)), ...newRecords];
    await fs.writeFile(INSTALLED_JSON, JSON.stringify(merged, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

export async function loadInstalled(): Promise<InstalledSkillRecord[]> {
  try {
    const data = await fs.readFile(INSTALLED_JSON, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function uninstallSkill(skillId: string): Promise<{ success?: boolean; error?: string }> {
  try {
    const cacheDir = path.join(SKILLS_DIR, 'cache', skillId);
    await fs.rm(cacheDir, { recursive: true, force: true });

    // Remove from agent dirs
    for (const agentDir of Object.values(AGENT_SKILL_DIRS)) {
      if (!agentDir) continue;
      const destDir = path.join(agentDir, skillId);
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    }

    // Update installed.json
    const existing = await loadInstalled();
    const filtered = existing.filter((e) => e.skillId !== skillId);
    await fs.writeFile(INSTALLED_JSON, JSON.stringify(filtered, null, 2), 'utf-8');

    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

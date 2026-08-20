import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { isCliAgentType } from '../../shared/agent-types';
import { detectProjectLanguages } from '../skills/language-detector';
import { getSkillsManifest } from '../skills/skills-manifest';
import { installSkills, loadInstalled, uninstallSkill } from '../skills/skills-installer';

const VALID_SKILL_ID = /^[a-z0-9-]+$/;

export function registerSkillsHandlers(): void {
  registerSkillsManifestHandler();
  registerSkillsInstallHandler();
  registerSkillsInstalledHandler();
  registerSkillsUninstallHandler();
  registerSkillsDetectLangsHandler();
}

function registerSkillsManifestHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_MANIFEST, async () => getSkillsManifest());
}

function registerSkillsInstallHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALL, (_event, raw: unknown) => handleSkillsInstall(raw));
}

async function handleSkillsInstall(raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return emptySkillsInstallSummary();
  const request = raw as { skillIds: string[]; targetAgents: string[] };
  if (!Array.isArray(request.skillIds) || !Array.isArray(request.targetAgents)) {
    return emptySkillsInstallSummary();
  }
  const skillIds = request.skillIds.filter(isValidSkillId);
  const targetAgents = request.targetAgents.filter(isCliAgentType);
  return installSkills({ skillIds, targetAgents });
}

function registerSkillsInstalledHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_INSTALLED, async () => loadInstalled());
}

function registerSkillsUninstallHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_UNINSTALL, (_event, skillId: unknown) =>
    handleSkillsUninstall(skillId),
  );
}

async function handleSkillsUninstall(skillId: unknown): Promise<unknown> {
  if (typeof skillId !== 'string' || !VALID_SKILL_ID.test(skillId)) {
    return { error: 'Invalid skill ID' };
  }
  return uninstallSkill(skillId);
}

function registerSkillsDetectLangsHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_DETECT_LANGS, (_event, projectPath: unknown) =>
    handleSkillsDetectLangs(projectPath),
  );
}

function handleSkillsDetectLangs(projectPath: unknown): Promise<readonly string[]> | [] {
  return typeof projectPath === 'string' ? detectProjectLanguages(projectPath) : [];
}

function isValidSkillId(id: unknown): id is string {
  return typeof id === 'string' && VALID_SKILL_ID.test(id);
}

function emptySkillsInstallSummary(): {
  results: never[];
  summary: { installed: number; failed: number; skipped: number };
} {
  return { results: [], summary: { installed: 0, failed: 0, skipped: 0 } };
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProjectInfo, ProjectCreateRequest, ProjectUpdateRequest } from '../../shared/ipc-types';

const MAX_PROJECTS = 50;

function isValidProjectList(data: unknown): data is ProjectInfo[] {
  if (!Array.isArray(data)) return false;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  for (const item of data) {
    if (typeof item !== 'object' || item === null) return false;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || !UUID_RE.test(p.id)) return false;
    if (typeof p.name !== 'string' || p.name.length === 0) return false;
    if (typeof p.path !== 'string' || p.path.length === 0) return false;
    if (typeof p.pinned !== 'boolean') return false;
    if (typeof p.lastActiveAt !== 'number') return false;
    if (typeof p.createdAt !== 'number') return false;
  }
  return true;
}

function sortProjects(projects: readonly ProjectInfo[]): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}

export class ProjectManager {
  private readonly configDir: string;
  private readonly projectsPath: string;
  private readonly workspacesDir: string;
  private projects: ProjectInfo[] = [];

  constructor() {
    this.configDir = path.join(os.homedir(), '.hariari');
    this.projectsPath = path.join(this.configDir, 'projects.json');
    this.workspacesDir = path.join(this.configDir, 'workspaces');
    this.loadProjects();
  }

  listProjects(): ProjectInfo[] {
    return sortProjects(this.projects);
  }

  validateDirectories(): { valid: ProjectInfo[]; missing: ProjectInfo[] } {
    const valid: ProjectInfo[] = [];
    const missing: ProjectInfo[] = [];
    for (const project of this.projects) {
      try {
        if (fs.existsSync(project.path) && fs.statSync(project.path).isDirectory()) {
          valid.push(project);
        } else {
          missing.push(project);
        }
      } catch {
        missing.push(project);
      }
    }
    return { valid, missing };
  }

  createProject(request: ProjectCreateRequest): ProjectInfo {
    if (this.projects.length >= MAX_PROJECTS) {
      throw new Error('Maximum number of projects reached');
    }

    const resolvedPath = path.resolve(request.path);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
      throw new Error(`Directory does not exist: ${resolvedPath}`);
    }

    const existing = this.projects.find((p) => p.path === resolvedPath);
    if (existing) {
      throw new Error(`Project already exists for path: ${resolvedPath}`);
    }

    const now = Date.now();
    const project: ProjectInfo = {
      id: randomUUID(),
      name: request.name || path.basename(resolvedPath),
      path: resolvedPath,
      pinned: false,
      lastActiveAt: now,
      createdAt: now,
    };

    this.projects = [...this.projects, project];
    this.persistProjects();
    return project;
  }

  removeProject(projectId: string): void {
    const index = this.projects.findIndex((p) => p.id === projectId);
    if (index === -1) {
      throw new Error(`Project not found: ${projectId}`);
    }

    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.persistProjects();

    // Clean up workspace state file
    const workspacePath = path.join(this.workspacesDir, `${projectId}.json`);
    try {
      if (fs.existsSync(workspacePath)) {
        fs.unlinkSync(workspacePath);
      }
    } catch {
      // Non-critical cleanup failure
    }
  }

  updateProject(request: ProjectUpdateRequest): ProjectInfo {
    const existing = this.projects.find((p) => p.id === request.id);
    if (!existing) {
      throw new Error(`Project not found: ${request.id}`);
    }

    const updated: ProjectInfo = {
      ...existing,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
    };

    this.projects = this.projects.map((p) => (p.id === request.id ? updated : p));
    this.persistProjects();
    return updated;
  }

  touchProject(projectId: string): void {
    const existing = this.projects.find((p) => p.id === projectId);
    if (!existing) return;

    const updated: ProjectInfo = { ...existing, lastActiveAt: Date.now() };
    this.projects = this.projects.map((p) => (p.id === projectId ? updated : p));
    this.persistProjects();
  }

  getProject(projectId: string): ProjectInfo | undefined {
    return this.projects.find((p) => p.id === projectId);
  }

  private loadProjects(): void {
    try {
      if (!fs.existsSync(this.projectsPath)) {
        this.projects = [];
        return;
      }
      const raw = fs.readFileSync(this.projectsPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isValidProjectList(parsed)) {
        console.warn('[ProjectManager] Invalid projects file, starting fresh');
        this.projects = [];
        return;
      }
      this.projects = parsed;
    } catch (error) {
      console.error('[ProjectManager] Failed to load projects:', error);
      this.projects = [];
    }
  }

  private persistProjects(): void {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      const tmpPath = `${this.projectsPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.projects, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.projectsPath);
    } catch (error) {
      console.error('[ProjectManager] Failed to persist projects:', error);
    }
  }
}

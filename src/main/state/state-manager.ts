import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppState, ProjectWorkspaceState } from '../../shared/ipc-types';
import type { LayoutNode } from '../../shared/layout-types';
import type { AgentType } from '../../shared/agent-types';

import { SPAWNABLE_AGENT_TYPES } from '../../shared/agent-types';

function isValidLayoutNode(node: unknown): node is LayoutNode {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;

  const SAFE_ID_RE = /^[0-9a-f-]{36}$/i;

  if (n.type === 'leaf') {
    return typeof n.id === 'string' && SAFE_ID_RE.test(n.id as string) &&
      typeof n.sessionId === 'string';
  }

  if (n.type === 'split') {
    return (
      typeof n.id === 'string' &&
      (n.direction === 'horizontal' || n.direction === 'vertical') &&
      typeof n.ratio === 'number' &&
      n.ratio >= 0 &&
      n.ratio <= 1 &&
      Array.isArray(n.children) &&
      n.children.length === 2 &&
      isValidLayoutNode(n.children[0]) &&
      isValidLayoutNode(n.children[1])
    );
  }

  return false;
}

function isValidAppState(data: unknown): data is AppState {
  if (typeof data !== 'object' || data === null) return false;
  const s = data as Record<string, unknown>;

  // Validate window bounds
  if (typeof s.window !== 'object' || s.window === null) return false;
  const w = s.window as Record<string, unknown>;
  if (
    typeof w.x !== 'number' ||
    typeof w.y !== 'number' ||
    typeof w.width !== 'number' ||
    typeof w.height !== 'number' ||
    typeof w.isMaximized !== 'boolean'
  ) {
    return false;
  }
  if (w.width < 100 || w.height < 100 || w.width > 10000 || w.height > 10000) {
    return false;
  }

  // Validate activeProjectId (nullable string)
  if (s.activeProjectId !== undefined && s.activeProjectId !== null && typeof s.activeProjectId !== 'string') {
    return false;
  }

  // Validate sidebarCollapsed (optional boolean)
  if (s.sidebarCollapsed !== undefined && typeof s.sidebarCollapsed !== 'boolean') {
    return false;
  }

  // Validate layout (nullable)
  if (s.layout !== null && !isValidLayoutNode(s.layout)) return false;

  // Validate agents array
  if (!Array.isArray(s.agents)) return false;
  for (const agent of s.agents) {
    if (typeof agent !== 'object' || agent === null) return false;
    const a = agent as Record<string, unknown>;
    if (!SPAWNABLE_AGENT_TYPES.has(a.type as AgentType)) return false;
    if (typeof a.cwd !== 'string') return false;
    if (a.label !== undefined && typeof a.label !== 'string') return false;
  }

  return true;
}

export class StateManager {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly workspacesDir: string;

  constructor() {
    this.stateDir = path.join(os.homedir(), '.hariari');
    this.statePath = path.join(this.stateDir, 'state.json');
    this.workspacesDir = path.join(this.stateDir, 'workspaces');
  }

  getStatePath(): string {
    return this.statePath;
  }

  loadState(): AppState | null {
    try {
      if (!fs.existsSync(this.statePath)) {
        return null;
      }
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isValidAppState(parsed)) {
        console.warn('[StateManager] Invalid state file, ignoring');
        return null;
      }
      return parsed;
    } catch (error) {
      console.error('[StateManager] Failed to load state:', error);
      return null;
    }
  }

  validateAndParse(raw: unknown): AppState | null {
    if (!isValidAppState(raw)) return null;
    return raw;
  }

  saveState(state: AppState): void {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmpPath = `${this.statePath}.tmp`;
      const data = JSON.stringify(state, null, 2);
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, this.statePath);
    } catch (error) {
      console.error('[StateManager] Failed to save state:', error);
    }
  }

  loadProjectState(projectId: string): ProjectWorkspaceState | null {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(projectId)) return null;

    try {
      const filePath = path.join(this.workspacesDir, `${projectId}.json`);
      if (!fs.existsSync(filePath)) return null;

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;

      const s = parsed as Record<string, unknown>;
      if (s.projectId !== projectId) return null;

      return parsed as ProjectWorkspaceState;
    } catch (error) {
      console.error('[StateManager] Failed to load project state:', error);
      return null;
    }
  }

  saveProjectState(state: { projectId: string; layout: unknown; agents: unknown[] }): void {
    try {
      fs.mkdirSync(this.workspacesDir, { recursive: true });
      const filePath = path.join(this.workspacesDir, `${state.projectId}.json`);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      console.error('[StateManager] Failed to save project state:', error);
    }
  }
}

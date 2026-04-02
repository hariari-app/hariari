import { ProjectWorkspace } from './project-workspace';
import { SinglePreview } from '../preview/single-preview';
import type { ProjectInfo } from '../../../shared/ipc-types';
import type { AgentInfo, AgentType } from '../../../shared/agent-types';
import type { PreviewAgent } from '../../../shared/preview-types';
import { ACTIVE_STATUSES } from '../../../shared/preview-types';

export type WorkspaceChangeCallback = (projectId: string | null) => void;

export class WorkspaceSwitcher {
  private readonly workspaceHost: HTMLElement;
  private readonly workspaces = new Map<string, ProjectWorkspace>();
  private activeProjectId: string | null = null;
  private lastActiveProjectId: string | null = null;
  private readonly onWorkspaceChange: WorkspaceChangeCallback;
  readonly singlePreview: SinglePreview;
  private inSinglePreview = false;
  private projectNames = new Map<string, string>();

  constructor(workspaceHost: HTMLElement, onWorkspaceChange: WorkspaceChangeCallback) {
    this.workspaceHost = workspaceHost;
    this.onWorkspaceChange = onWorkspaceChange;

    this.singlePreview = new SinglePreview(
      (sessionId, container) => {
        // Find which workspace owns this session and reattach its terminal
        for (const ws of this.workspaces.values()) {
          const panel = ws.terminalManager.getTerminal(sessionId);
          if (panel) {
            ws.terminalManager.createTerminal(sessionId, container);
            return;
          }
        }
      },
      (sessionId) => {
        // Focus the xterm terminal so it receives keyboard input
        for (const ws of this.workspaces.values()) {
          if (ws.terminalManager.getTerminal(sessionId)) {
            ws.terminalManager.focusTerminal(sessionId);
            return;
          }
        }
      },
      () => {
        // fitAll across all workspace terminal managers
        for (const ws of this.workspaces.values()) {
          ws.terminalManager.fitAll();
        }
      },
      () => this.collectPreviewAgents(),
    );
    workspaceHost.appendChild(this.singlePreview.containerEl);
  }

  isInSinglePreview(): boolean {
    return this.inSinglePreview;
  }

  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  getActiveWorkspace(): ProjectWorkspace | null {
    if (!this.activeProjectId) return null;
    return this.workspaces.get(this.activeProjectId) ?? null;
  }

  /** Returns the focused terminal's sessionId in any mode (normal or Single Preview). */
  getFocusedSessionId(): string | null {
    if (this.inSinglePreview) {
      return this.singlePreview.getFocusedSessionId();
    }
    const workspace = this.getActiveWorkspace();
    if (!workspace) return null;
    return workspace.layoutManager.getFocusedSessionId();
  }

  getWorkspace(projectId: string): ProjectWorkspace | undefined {
    return this.workspaces.get(projectId);
  }

  getAllWorkspaces(): ProjectWorkspace[] {
    return Array.from(this.workspaces.values());
  }

  updateProjectNames(projects: ReadonlyArray<ProjectInfo>): void {
    this.projectNames.clear();
    for (const p of projects) {
      this.projectNames.set(p.id, p.name);
    }
  }

  async switchTo(project: ProjectInfo): Promise<ProjectWorkspace> {
    // Exit single preview if active
    if (this.inSinglePreview) {
      this.exitSinglePreview();
    }

    // Deactivate current workspace
    if (this.activeProjectId) {
      const current = this.workspaces.get(this.activeProjectId);
      if (current) {
        await current.saveState();
        current.deactivate();
      }
    }

    // Get or create workspace
    let workspace = this.workspaces.get(project.id);
    if (!workspace) {
      workspace = new ProjectWorkspace(project.id, project.path);
      this.workspaceHost.appendChild(workspace.containerEl);
      this.workspaces.set(project.id, workspace);

      // Try to restore saved state, otherwise spawn a default shell
      const restored = await workspace.restoreState();
      if (!restored) {
        await workspace.spawnAgent('shell');
      }
    }

    workspace.activate();
    this.activeProjectId = project.id;
    this.lastActiveProjectId = project.id;
    this.onWorkspaceChange(project.id);

    // Touch project's lastActiveAt
    try {
      await window.api.project.update({ id: project.id });
    } catch {
      // Non-critical
    }

    return workspace;
  }

  async enterSinglePreview(): Promise<void> {
    if (this.inSinglePreview) return;

    // Ensure workspaces exist for all projects with active agents
    await this.hydrateWorkspacesForActiveAgents();

    // Deactivate current workspace
    if (this.activeProjectId) {
      const current = this.workspaces.get(this.activeProjectId);
      if (current) {
        current.deactivate();
      }
      this.lastActiveProjectId = this.activeProjectId;
      this.activeProjectId = null;
    }

    this.inSinglePreview = true;
    this.singlePreview.enter();
    this.onWorkspaceChange(null);
  }

  private async hydrateWorkspacesForActiveAgents(): Promise<void> {
    try {
      const allAgents = await window.api.agent.list();
      if (!Array.isArray(allAgents)) return;

      const projects = await window.api.project.list();
      const projectMap = new Map(projects.map((p) => [p.id, p]));
      this.updateProjectNames(projects);

      // Group active agents by project
      const agentsByProject = new Map<string, AgentInfo[]>();
      for (const agent of allAgents) {
        if (!ACTIVE_STATUSES.has(agent.status)) continue;
        const list = agentsByProject.get(agent.projectId) ?? [];
        list.push(agent);
        agentsByProject.set(agent.projectId, list);
      }

      for (const [projectId, agents] of agentsByProject) {
        if (this.workspaces.has(projectId)) continue;

        const project = projectMap.get(projectId);
        if (!project) continue;

        // Create workspace and adopt existing running agents (no re-spawn)
        const workspace = new ProjectWorkspace(project.id, project.path);
        this.workspaceHost.appendChild(workspace.containerEl);
        this.workspaces.set(project.id, workspace);
        workspace.adoptAgents(agents);
      }
    } catch (error) {
      console.error('[WorkspaceSwitcher] Failed to hydrate workspaces:', error);
    }
  }

  exitSinglePreview(): void {
    if (!this.inSinglePreview) return;

    this.inSinglePreview = false;

    // Reattach terminals for ALL workspaces — not just the last active one.
    // During preview, terminals from every project are moved into the preview
    // container. We must re-render every workspace's layout so xterm DOM
    // elements move back to their project containers.
    this.singlePreview.setOnExit(() => {
      for (const ws of this.workspaces.values()) {
        ws.layoutManager.render();
      }

      if (this.lastActiveProjectId) {
        const workspace = this.workspaces.get(this.lastActiveProjectId);
        if (workspace) {
          workspace.activate();
          this.activeProjectId = this.lastActiveProjectId;
          requestAnimationFrame(() => {
            workspace.terminalManager.fitAll();
          });
        }
      }
    });

    this.singlePreview.exit();

    // Reset the onExit callback
    this.singlePreview.setOnExit(() => {});

    this.onWorkspaceChange(this.activeProjectId);
  }

  async toggleSinglePreview(): Promise<void> {
    if (this.inSinglePreview) {
      this.exitSinglePreview();
    } else {
      await this.enterSinglePreview();
    }
  }

  private collectPreviewAgents(): ReadonlyArray<PreviewAgent> {
    const agents: PreviewAgent[] = [];
    for (const ws of this.workspaces.values()) {
      const projectName = this.projectNames.get(ws.projectId) ?? ws.projectId;
      for (const tracked of ws.getTrackedAgents().values()) {
        if (ACTIVE_STATUSES.has(tracked.info.status)) {
          agents.push({
            agentInfo: tracked.info,
            projectId: ws.projectId,
            projectName,
          });
        }
      }
    }
    // Sort: needs-input first, then by project name, then by agent type
    const statusPriority: Record<string, number> = {
      'needs-input': 0,
      'running': 1,
      'starting': 2,
      'idle': 3,
    };
    agents.sort((a, b) => {
      const pa = statusPriority[a.agentInfo.status] ?? 9;
      const pb = statusPriority[b.agentInfo.status] ?? 9;
      if (pa !== pb) return pa - pb;
      const nameCompare = a.projectName.localeCompare(b.projectName);
      if (nameCompare !== 0) return nameCompare;
      return a.agentInfo.config.type.localeCompare(b.agentInfo.config.type);
    });
    return agents;
  }

  async closeWorkspace(projectId: string): Promise<void> {
    const workspace = this.workspaces.get(projectId);
    if (!workspace) return;

    await workspace.saveState();
    workspace.dispose();
    this.workspaces.delete(projectId);

    // Refresh single preview if active (agents were removed)
    if (this.inSinglePreview) {
      this.singlePreview.refresh();
    }

    if (this.activeProjectId === projectId) {
      // Auto-switch to the next open workspace, or null
      const remaining = Array.from(this.workspaces.keys());
      if (remaining.length > 0) {
        const nextId = remaining[0];
        const nextWorkspace = this.workspaces.get(nextId);
        if (nextWorkspace) {
          nextWorkspace.activate();
          this.activeProjectId = nextId;
          this.onWorkspaceChange(nextId);
          return;
        }
      }
      this.activeProjectId = null;
      this.onWorkspaceChange(null);
    }
  }

  handleAgentStatus(agentId: string, status: string): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.hasAgent(agentId)) {
        workspace.handleAgentStatus(agentId, status as 'running' | 'stopped' | 'error' | 'starting');
        break;
      }
    }
    // Refresh single preview if active
    if (this.inSinglePreview) {
      this.singlePreview.refresh();
    }
  }

  handleAgentExit(agentId: string, exitCode: number): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.hasAgent(agentId)) {
        workspace.handleAgentExit(agentId, exitCode);
        break;
      }
    }
    // Refresh single preview if active
    if (this.inSinglePreview) {
      this.singlePreview.refresh();
    }
  }

  async saveAllStates(): Promise<void> {
    const promises = Array.from(this.workspaces.values()).map((ws) => ws.saveState());
    await Promise.allSettled(promises);
  }

  setThemeAll(name: string): void {
    for (const workspace of this.workspaces.values()) {
      workspace.setThemeAll(name);
    }
  }

  disposeAll(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.dispose();
    }
    this.workspaces.clear();
    this.activeProjectId = null;
    this.singlePreview.dispose();
  }
}

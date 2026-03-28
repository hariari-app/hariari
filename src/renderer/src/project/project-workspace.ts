import { TerminalManager } from '../terminal/terminal-manager';
import { LayoutManager } from '../layout/layout-manager';
import { AgentStatusBar } from '../agent/agent-status-bar';
import type { AgentInfo, AgentType } from '../../../shared/agent-types';
import type { ProjectWorkspaceState } from '../../../shared/ipc-types';
import type { LayoutNode, LeafNode, SplitNode } from '../../../shared/layout-types';
import type { LayoutPreset, PresetTree } from '../layout/layout-presets';

function collectLeafSessionIds(node: LayoutNode): ReadonlyArray<string> {
  if (node.type === 'leaf') return [node.sessionId];
  return [
    ...collectLeafSessionIds(node.children[0]),
    ...collectLeafSessionIds(node.children[1]),
  ];
}

function remapSessionIds(
  node: LayoutNode,
  sessionIdMap: ReadonlyMap<string, string>,
): LayoutNode {
  if (node.type === 'leaf') {
    const newSessionId = sessionIdMap.get(node.sessionId);
    return newSessionId ? { ...node, sessionId: newSessionId } : node;
  }
  const newFirst = remapSessionIds(node.children[0], sessionIdMap);
  const newSecond = remapSessionIds(node.children[1], sessionIdMap);
  if (newFirst === node.children[0] && newSecond === node.children[1]) return node;
  return { ...node, children: [newFirst, newSecond] };
}

export class ProjectWorkspace {
  readonly projectId: string;
  readonly projectPath: string;
  readonly containerEl: HTMLElement;
  readonly terminalManager: TerminalManager;
  readonly layoutManager: LayoutManager;
  private readonly tracked = new Map<string, { readonly info: AgentInfo; readonly statusBar: AgentStatusBar }>();
  private active = false;

  constructor(projectId: string, projectPath: string) {
    this.projectId = projectId;
    this.projectPath = projectPath;

    this.containerEl = document.createElement('div');
    this.containerEl.className = 'terminal-area';
    this.containerEl.style.display = 'none';

    this.terminalManager = new TerminalManager();

    this.layoutManager = new LayoutManager(
      this.containerEl,
      (sessionId, container) => {
        // Mount the agent status bar above the terminal
        const tracked = this.findTrackedBySession(sessionId);
        if (tracked) {
          const existingBar = container.querySelector('.agent-status-bar');
          if (!existingBar) {
            container.prepend(tracked.statusBar.getElement());
          }
        }
        this.terminalManager.createTerminal(sessionId, container);
      },
      (sessionId) => this.terminalManager.removeTerminal(sessionId),
    );
    this.layoutManager.setFitAllCallback(() => this.terminalManager.fitAll());
  }

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
    this.containerEl.style.display = '';
    requestAnimationFrame(() => {
      this.terminalManager.fitAll();
    });
  }

  deactivate(): void {
    this.active = false;
    this.containerEl.style.display = 'none';
  }

  async spawnAgent(type: AgentType, direction?: 'horizontal' | 'vertical'): Promise<AgentInfo | null> {
    try {
      const info: AgentInfo = await window.api.agent.spawn({
        type,
        projectId: this.projectId,
        cwd: this.projectPath,
      });

      const statusBar = new AgentStatusBar(info, () => {
        this.killAgent(info.id);
      });
      this.tracked.set(info.id, { info, statusBar });

      if (this.layoutManager.getLayoutTree() === null) {
        this.layoutManager.setRoot(info.sessionId);
      } else {
        const focusedId = this.layoutManager.getFocusedLeafId();
        if (focusedId) {
          this.layoutManager.splitPane(focusedId, direction ?? 'horizontal', info.sessionId);
        }
      }

      return info;
    } catch (error) {
      console.error('[ProjectWorkspace] Failed to spawn agent:', error);
      return null;
    }
  }

  async applyPreset(preset: LayoutPreset): Promise<boolean> {
    try {
      // Kill all existing agents first
      const agentIds = Array.from(this.tracked.keys());
      for (const agentId of agentIds) {
        await this.killAgent(agentId);
      }

      // Spawn agents for each slot
      const sessionIds: string[] = [];
      for (const slot of preset.slots) {
        const info: AgentInfo = await window.api.agent.spawn({
          type: slot.type,
          projectId: this.projectId,
          cwd: this.projectPath,
          label: slot.label,
        });

        // Check for IPC error response
        if ('error' in (info as unknown as Record<string, unknown>)) {
          console.error('[ProjectWorkspace] Agent spawn returned error:', info);
          return false;
        }

        const statusBar = new AgentStatusBar(info, () => {
          this.killAgent(info.id);
        });
        this.tracked.set(info.id, { info, statusBar });
        sessionIds.push(info.sessionId);
      }

      // Build layout tree from preset
      const presetTree = preset.buildTree(sessionIds);
      const layoutTree = this.presetTreeToLayout(presetTree, sessionIds);
      this.layoutManager.restoreLayout(layoutTree);

      return true;
    } catch (error) {
      console.error('[ProjectWorkspace] Failed to apply preset:', error);
      return false;
    }
  }

  private presetTreeToLayout(tree: PresetTree, sessionIds: readonly string[]): LayoutNode {
    if (tree.type === 'leaf') {
      const leaf: LeafNode = {
        type: 'leaf',
        id: crypto.randomUUID(),
        sessionId: sessionIds[tree.slotIndex],
      };
      return leaf;
    }

    const split: SplitNode = {
      type: 'split',
      id: crypto.randomUUID(),
      direction: tree.direction,
      ratio: tree.ratio,
      children: [
        this.presetTreeToLayout(tree.children[0], sessionIds),
        this.presetTreeToLayout(tree.children[1], sessionIds),
      ],
    };
    return split;
  }

  async killAgent(agentId: string): Promise<void> {
    try {
      await window.api.agent.kill(agentId);
      const tracked = this.tracked.get(agentId);
      if (tracked) {
        const leaf = this.layoutManager.findLeafBySessionId(tracked.info.sessionId);
        if (leaf) {
          this.layoutManager.closePane(leaf.id);
        }
        tracked.statusBar.dispose();
        this.tracked.delete(agentId);
      }
    } catch (error) {
      console.error('[ProjectWorkspace] Failed to kill agent:', error);
    }
  }

  handleAgentStatus(agentId: string, status: AgentInfo['status']): void {
    const tracked = this.tracked.get(agentId);
    if (!tracked) return;
    const updatedInfo: AgentInfo = { ...tracked.info, status };
    this.tracked.set(agentId, { ...tracked, info: updatedInfo });
    tracked.statusBar.updateStatus(status);
  }

  handleAgentExit(agentId: string, exitCode: number): void {
    const tracked = this.tracked.get(agentId);
    if (!tracked) return;
    const exitStatus = exitCode === 0 ? 'complete' : 'error';
    const updatedInfo: AgentInfo = { ...tracked.info, status: exitStatus };
    this.tracked.set(agentId, { ...tracked, info: updatedInfo });
    tracked.statusBar.updateStatus(exitStatus);
  }

  hasAgent(agentId: string): boolean {
    return this.tracked.has(agentId);
  }

  private findTrackedBySession(sessionId: string): { readonly info: AgentInfo; readonly statusBar: AgentStatusBar } | undefined {
    for (const tracked of this.tracked.values()) {
      if (tracked.info.sessionId === sessionId) return tracked;
    }
    return undefined;
  }

  getTrackedAgents(): ReadonlyMap<string, { readonly info: AgentInfo }> {
    return this.tracked;
  }

  async saveState(): Promise<void> {
    const layout = this.layoutManager.getLayoutTree();
    const agents = Array.from(this.tracked.values()).map((t) => ({
      type: t.info.config.type,
      cwd: t.info.config.cwd,
      ...(t.info.config.label ? { label: t.info.config.label } : {}),
    }));

    const state: ProjectWorkspaceState = {
      projectId: this.projectId,
      layout,
      agents,
    };

    try {
      await window.api.project.saveState(state);
    } catch (error) {
      console.error('[ProjectWorkspace] Failed to save state:', error);
    }
  }

  async restoreState(): Promise<boolean> {
    try {
      const state = await window.api.project.loadState(this.projectId);
      if (!state || !state.layout || state.agents.length === 0) return false;

      const savedLeafSessionIds = collectLeafSessionIds(state.layout);
      const sessionIdMap = new Map<string, string>();

      for (let i = 0; i < state.agents.length; i++) {
        const agentDef = state.agents[i];
        const info = await window.api.agent.spawn({
          type: agentDef.type,
          projectId: this.projectId,
          cwd: agentDef.cwd || this.projectPath,
          label: agentDef.label,
        });

        const statusBar = new AgentStatusBar(info, () => {
          this.killAgent(info.id);
        });
        this.tracked.set(info.id, { info, statusBar });

        if (i < savedLeafSessionIds.length) {
          sessionIdMap.set(savedLeafSessionIds[i], info.sessionId);
        }
      }

      const remappedLayout = remapSessionIds(state.layout, sessionIdMap);
      this.layoutManager.restoreLayout(remappedLayout);
      return true;
    } catch (error) {
      console.error('[ProjectWorkspace] Failed to restore state:', error);
      return false;
    }
  }

  focusTerminal(sessionId: string): void {
    this.terminalManager.focusTerminal(sessionId);
  }

  setThemeAll(name: string): void {
    this.terminalManager.setThemeAll(name);
  }

  dispose(): void {
    for (const tracked of this.tracked.values()) {
      tracked.statusBar.dispose();
      try {
        window.api.agent.kill(tracked.info.id).catch(() => {});
      } catch {
        // Best-effort cleanup
      }
    }
    this.tracked.clear();
    this.layoutManager.dispose();
    this.terminalManager.disposeAll();
    this.containerEl.remove();
  }
}

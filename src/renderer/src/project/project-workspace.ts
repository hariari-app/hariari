import { TerminalManager } from '../terminal/terminal-manager';
import { LayoutManager } from '../layout/layout-manager';
import { AgentStatusBar } from '../agent/agent-status-bar';
import { WorktreeDiffPanel } from '../agent/worktree-diff-panel';
import { AGENT_INSTALL_INFO } from '../../../shared/agent-install-info';
import { showAgentInstallDialog } from '../ui/agent-install-dialog';
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
  useWorktree = true;

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
        // Create a sub-container for xterm so it doesn't share the
        // same parent as the status bar — xterm.open() modifies its
        // container with absolute-positioned elements that can overlap siblings.
        let termWrapper = container.querySelector('.terminal-wrapper') as HTMLElement | null;
        if (!termWrapper) {
          termWrapper = document.createElement('div');
          termWrapper.className = 'terminal-wrapper';
          container.appendChild(termWrapper);
        }
        const panel = this.terminalManager.createTerminal(sessionId, termWrapper);
        // Show loading state with agent name until first output arrives
        if (tracked) {
          panel.setLoadingInfo(
            tracked.info.config.label ?? tracked.info.config.type,
            tracked.info.config.type,
          );
        }
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
    // Check if agent is installed (skip for shell — always available)
    if (type !== 'shell') {
      const installInfo = AGENT_INSTALL_INFO[type];
      if (installInfo) {
        const check = await window.api.agent.checkInstalled(installInfo.command);
        if (!check.installed) {
          showAgentInstallDialog(type, installInfo);
          return null;
        }
      }
    }

    try {
      const result = await window.api.agent.spawn({
        type,
        projectId: this.projectId,
        cwd: this.projectPath,
        useWorktree: this.useWorktree,
      });

      // Check for IPC error response
      if (!result || ('error' in result) || !result.config) {
        console.error('[ProjectWorkspace] Spawn returned error:', result);
        return null;
      }

      const info: AgentInfo = result;

      const statusBar = new AgentStatusBar(info, {
        onKill: () => this.killAgent(info.id),
        onSplitH: () => this.spawnAgent('shell', 'horizontal'),
        onSplitV: () => this.spawnAgent('shell', 'vertical'),
        onReview: () => this.reviewAgentWorktree(info.id, info.worktree?.branchName ?? ''),
        onMerge: () => this.mergeAgentWorktree(info.id),
        onDiscard: () => this.discardAgentWorktree(info.id),
      });
      this.tracked.set(info.id, { info, statusBar });

      if (this.layoutManager.getLayoutTree() === null) {
        this.layoutManager.setRoot(info.sessionId);
      } else {
        const focusedId = this.layoutManager.getFocusedLeafId()
          ?? this.findFirstLeafId();
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
        // Check if agent is installed before spawning (skip shell)
        if (slot.type !== 'shell') {
          const installInfo = AGENT_INSTALL_INFO[slot.type];
          if (installInfo) {
            const check = await window.api.agent.checkInstalled(installInfo.command);
            if (!check.installed) {
              showAgentInstallDialog(slot.type, installInfo);
              continue; // Skip this agent, proceed with others
            }
          }
        }

        const info: AgentInfo = await window.api.agent.spawn({
          type: slot.type,
          projectId: this.projectId,
          cwd: this.projectPath,
          label: slot.label,
          useWorktree: this.useWorktree,
        });

        // Check for IPC error response
        if ('error' in (info as unknown as Record<string, unknown>)) {
          console.error('[ProjectWorkspace] Agent spawn returned error:', info);
          continue; // Skip this agent, proceed with others
        }

        const statusBar = new AgentStatusBar(info, {
          onKill: () => this.killAgent(info.id),
          onSplitH: () => this.spawnAgent('shell', 'horizontal'),
          onSplitV: () => this.spawnAgent('shell', 'vertical'),
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

  private readonly diffPanel = new WorktreeDiffPanel();

  async reviewAgentWorktree(agentId: string, branchName: string): Promise<void> {
    this.diffPanel.show(agentId, branchName, async (action) => {
      if (action === 'merge') {
        await this.mergeAgentWorktree(agentId);
      } else if (action === 'discard') {
        await this.discardAgentWorktree(agentId);
      }
    });
  }

  async mergeAgentWorktree(agentId: string): Promise<void> {
    try {
      const diff = await window.api.worktree.diff(agentId);
      if (!diff || diff.filesChanged === 0) {
        await window.api.worktree.cleanup(agentId);
        return;
      }

      const result = await window.api.worktree.merge(agentId);
      if (!result.success) {
        console.error('[ProjectWorkspace] Merge failed:', result.error, result.conflicts);
      }
    } catch (error) {
      console.error('[ProjectWorkspace] Merge error:', error);
    }
  }

  async discardAgentWorktree(agentId: string): Promise<void> {
    try {
      await window.api.worktree.cleanup(agentId);
    } catch (error) {
      console.error('[ProjectWorkspace] Discard error:', error);
    }
  }

  private findFirstLeafId(): string | null {
    const tree = this.layoutManager.getLayoutTree();
    if (!tree) return null;
    const findLeaf = (node: LayoutNode): string | null => {
      if (node.type === 'leaf') return node.id;
      return findLeaf(node.children[0]);
    };
    return findLeaf(tree);
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

    // Save scrollback for each terminal (best-effort)
    for (const tracked of this.tracked.values()) {
      try {
        const panel = this.terminalManager.getTerminal(tracked.info.sessionId);
        if (panel) {
          const scrollback = panel.getScrollback();
          if (scrollback) {
            await window.api.scrollback.save(tracked.info.sessionId, scrollback);
          }
        }
      } catch { /* scrollback save is best-effort */ }
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
        const result = await window.api.agent.spawn({
          type: agentDef.type,
          projectId: this.projectId,
          cwd: agentDef.cwd || this.projectPath,
          label: agentDef.label,
        });

        // Skip agents that failed to spawn
        if (!result || ('error' in result) || !result.config) {
          console.warn('[ProjectWorkspace] Failed to restore agent:', agentDef.type, result);
          continue;
        }

        const info: AgentInfo = result;

        const statusBar = new AgentStatusBar(info, {
          onKill: () => this.killAgent(info.id),
          onSplitH: () => this.spawnAgent('shell', 'horizontal'),
          onSplitV: () => this.spawnAgent('shell', 'vertical'),
        });
        this.tracked.set(info.id, { info, statusBar });

        if (i < savedLeafSessionIds.length) {
          sessionIdMap.set(savedLeafSessionIds[i], info.sessionId);
        }
      }

      const remappedLayout = remapSessionIds(state.layout, sessionIdMap);
      this.layoutManager.restoreLayout(remappedLayout);

      // Restore scrollback from old session IDs (best-effort)
      for (const [oldId, newId] of sessionIdMap) {
        try {
          const data = await window.api.scrollback.load(oldId);
          if (data) {
            const panel = this.terminalManager.getTerminal(newId);
            if (panel) panel.loadScrollback(data);
          }
          // Clean up old scrollback file
          await window.api.scrollback.delete(oldId);
        } catch { /* scrollback restore is best-effort */ }
      }

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

import type { AgentInfo, AgentStatus, AgentType } from '../../../shared/agent-types';
import type { TerminalManager } from '../terminal/terminal-manager';
import type { LayoutManager } from '../layout/layout-manager';
import type { AgentList } from './agent-list';
import { AgentStatusBar } from './agent-status-bar';

interface TrackedAgent {
  readonly info: AgentInfo;
  readonly statusBar: AgentStatusBar;
}

export class AgentControls {
  private readonly terminalManager: TerminalManager;
  private readonly layoutManager: LayoutManager;
  private readonly agentList: AgentList;
  private readonly tracked = new Map<string, TrackedAgent>();
  private readonly unsubscribers: Array<() => void> = [];
  private isFirstAgent = true;

  constructor(
    terminalManager: TerminalManager,
    layoutManager: LayoutManager,
    agentList: AgentList,
  ) {
    this.terminalManager = terminalManager;
    this.layoutManager = layoutManager;
    this.agentList = agentList;
  }

  async spawnAgent(type: AgentType, direction?: 'horizontal' | 'vertical'): Promise<void> {
    try {
      const info: AgentInfo = await window.api.agent.spawn({ type });

      const statusBar = new AgentStatusBar(info, () => {
        this.killAgent(info.id);
      });

      this.tracked.set(info.id, { info, statusBar });
      this.agentList.updateAgent(info);

      if (this.isFirstAgent) {
        this.layoutManager.setRoot(info.sessionId);
        this.isFirstAgent = false;
      } else {
        const focusedId = this.layoutManager.getFocusedLeafId();
        if (focusedId) {
          this.layoutManager.splitPane(focusedId, direction ?? 'horizontal', info.sessionId);
        }
      }
    } catch (error) {
      console.error('Failed to spawn agent:', error);
    }
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
        this.agentList.removeAgent(agentId);
      }
    } catch (error) {
      console.error('Failed to kill agent:', error);
    }
  }

  setupEventListeners(): void {
    const unsubStatus = window.api.agent.onStatus((event) => {
      const tracked = this.tracked.get(event.agentId);
      if (tracked) {
        const updatedInfo: AgentInfo = { ...tracked.info, status: event.status as AgentStatus };
        this.tracked.set(event.agentId, { ...tracked, info: updatedInfo });
        tracked.statusBar.updateStatus(event.status as AgentStatus);
        this.agentList.updateAgent(updatedInfo);
      }
    });

    const unsubExit = window.api.agent.onExit((event) => {
      const tracked = this.tracked.get(event.agentId);
      if (tracked) {
        const updatedInfo: AgentInfo = { ...tracked.info, status: 'stopped' };
        this.tracked.set(event.agentId, { ...tracked, info: updatedInfo });
        tracked.statusBar.updateStatus('stopped');
        this.agentList.updateAgent(updatedInfo);
      }
    });

    this.unsubscribers.push(unsubStatus, unsubExit);
  }

  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;
    for (const tracked of this.tracked.values()) {
      tracked.statusBar.dispose();
    }
    this.tracked.clear();
  }
}

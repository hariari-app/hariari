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

  markRestored(): void {
    this.isFirstAgent = false;
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

        if (event.exitCode !== 0) {
          this.showRestartPrompt(event.agentId, {
            exitCode: event.exitCode,
            type: tracked.info.config.type,
            sessionId: tracked.info.sessionId,
          });
        }
      }
    });

    this.unsubscribers.push(unsubStatus, unsubExit);
  }

  private showRestartPrompt(
    agentId: string,
    info: { readonly exitCode: number; readonly type: AgentType; readonly sessionId: string },
  ): void {
    const leaf = this.layoutManager.findLeafBySessionId(info.sessionId);
    if (!leaf) return;

    const leafEl = document.querySelector(`[data-leaf-id="${leaf.id}"]`);
    if (!leafEl) return;

    const overlay = document.createElement('div');
    overlay.className = 'restart-overlay';

    const card = document.createElement('div');
    card.className = 'restart-card';

    const message = document.createElement('p');
    message.className = 'restart-message';
    message.textContent = `Agent exited unexpectedly (code: ${info.exitCode})`;

    const restartBtn = document.createElement('button');
    restartBtn.className = 'restart-btn';
    restartBtn.textContent = 'Restart';
    restartBtn.addEventListener('click', () => {
      overlay.remove();
      this.spawnAgent(info.type).catch((error) => {
        console.error('Failed to restart agent:', error);
      });
    });

    card.appendChild(message);
    card.appendChild(restartBtn);
    overlay.appendChild(card);
    leafEl.appendChild(overlay);
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

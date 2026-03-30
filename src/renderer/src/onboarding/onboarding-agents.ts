// Step 1: Agent detection — scan PATH, show installed/not-installed grid

import type { StepRenderer } from './onboarding-wizard';
import { createAgentIcon } from '../ui/agent-icons';
import { AGENT_INSTALL_INFO } from '../../../shared/agent-install-info';
import { showAgentInstallDialog, setDialogCloseCallback } from '../ui/agent-install-dialog';
import type { AgentType } from '../../../shared/agent-types';

interface AgentRow {
  readonly type: AgentType;
  readonly displayName: string;
  readonly command: string;
}

const AGENT_ORDER: readonly AgentRow[] = [
  { type: 'claude', displayName: 'Claude Code', command: 'claude' },
  { type: 'aider', displayName: 'Aider', command: 'aider' },
  { type: 'gemini', displayName: 'Gemini CLI', command: 'gemini' },
  { type: 'codex', displayName: 'Codex CLI', command: 'codex' },
  { type: 'amp', displayName: 'Amp', command: 'amp' },
  { type: 'opencode', displayName: 'OpenCode', command: 'opencode' },
  { type: 'copilot', displayName: 'Copilot CLI', command: 'copilot' },
  { type: 'cursor', displayName: 'Cursor CLI', command: 'cursor-agent' },
  { type: 'cline', displayName: 'Cline CLI', command: 'cline' },
  { type: 'continue', displayName: 'Continue', command: 'cn' },
  { type: 'crush', displayName: 'Crush', command: 'crush' },
  { type: 'qwen', displayName: 'Qwen Code', command: 'qwen' },
];

const VISIBLE_COUNT = 6;
const RESCAN_DELAY_MS = 3000;
const RESCAN_ATTEMPTS = 5;

export class AgentsStep implements StepRenderer {
  private availability: Record<string, boolean> = {};
  private badgeEls = new Map<string, HTMLElement>();
  private unsubAvailability: (() => void) | null = null;
  private installedCount = 0;
  private countEl: HTMLElement | null = null;
  private pendingAgent: AgentRow | null = null;

  render(container: HTMLElement): void {
    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = 'Your AI Agents';

    const subhead = document.createElement('p');
    subhead.className = 'onboarding-body';
    subhead.textContent = 'We scanned your system for installed CLIs.';

    this.countEl = document.createElement('span');
    this.countEl.className = 'onboarding-agent-count';

    const grid = document.createElement('div');
    grid.className = 'onboarding-agent-grid';

    const collapsedGrid = document.createElement('div');
    collapsedGrid.className = 'onboarding-agent-grid';
    collapsedGrid.style.display = 'none';

    AGENT_ORDER.forEach((agent, i) => {
      const row = this.createAgentRow(agent);
      if (i < VISIBLE_COUNT) {
        grid.appendChild(row);
      } else {
        collapsedGrid.appendChild(row);
      }
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'onboarding-toggle-more';
    toggleBtn.textContent = `Show ${AGENT_ORDER.length - VISIBLE_COUNT} more agents`;
    toggleBtn.addEventListener('click', () => {
      const isHidden = collapsedGrid.style.display === 'none';
      collapsedGrid.style.display = isHidden ? '' : 'none';
      toggleBtn.textContent = isHidden
        ? 'Show fewer agents'
        : `Show ${AGENT_ORDER.length - VISIBLE_COUNT} more agents`;
    });

    const hint = document.createElement('p');
    hint.className = 'onboarding-hint';
    hint.textContent = 'Agents can be installed later from the command palette (Ctrl+Shift+P).';

    container.appendChild(headline);
    container.appendChild(subhead);
    container.appendChild(this.countEl);
    container.appendChild(grid);
    container.appendChild(toggleBtn);
    container.appendChild(collapsedGrid);
    container.appendChild(hint);

    // Initial scan with loading indicator
    if (this.countEl) this.countEl.textContent = 'Scanning for installed agents...';
    this.scanAgents();

    // Listen for availability changes
    this.unsubAvailability = window.api.agent.onAvailabilityChanged((avail) => {
      this.availability = avail;
      this.updateBadges();
    });

    // Re-scan after install dialog closes
    setDialogCloseCallback(() => {
      if (this.pendingAgent) {
        const agent = this.pendingAgent;
        this.pendingAgent = null;
        this.setBadgeLoading(agent.type);
        this.rescanAgent(agent, RESCAN_ATTEMPTS);
      }
    });
  }

  getInstalledCount(): number {
    return this.installedCount;
  }

  cleanup(): void {
    if (this.unsubAvailability) {
      this.unsubAvailability();
      this.unsubAvailability = null;
    }
    setDialogCloseCallback(() => {});
  }

  private async scanAgents(): Promise<void> {
    for (const agent of AGENT_ORDER) {
      try {
        const result = await window.api.agent.checkInstalled(agent.command);
        this.availability[agent.type] = result.installed;
      } catch {
        this.availability[agent.type] = false;
      }
    }
    this.updateBadges();
  }

  private async rescanAgent(agent: AgentRow, attemptsLeft: number): Promise<void> {
    if (attemptsLeft <= 0) {
      this.updateBadges(); // revert to current state
      return;
    }

    await new Promise((r) => setTimeout(r, RESCAN_DELAY_MS));

    try {
      const result = await window.api.agent.checkInstalled(agent.command);
      if (result.installed) {
        this.availability[agent.type] = true;
        this.updateBadges();
        return;
      }
    } catch { /* continue retrying */ }

    // Not found yet — retry (install may still be running)
    this.rescanAgent(agent, attemptsLeft - 1);
  }

  private setBadgeLoading(agentType: string): void {
    const badge = this.badgeEls.get(agentType);
    if (!badge) return;
    badge.className = 'onboarding-agent-checking';
    badge.textContent = 'Checking...';
  }

  private updateBadges(): void {
    this.installedCount = 0;
    for (const agent of AGENT_ORDER) {
      const badge = this.badgeEls.get(agent.type);
      if (!badge) continue;

      const installed = this.availability[agent.type] ?? false;
      if (installed) {
        this.installedCount++;
        badge.className = 'onboarding-agent-installed';
        badge.textContent = '\u2713 Installed';
      } else {
        badge.className = 'onboarding-agent-install-btn';
        badge.textContent = 'Install';
      }
    }
    if (this.countEl) {
      this.countEl.textContent = `${this.installedCount} of ${AGENT_ORDER.length} agents installed`;
    }
  }

  private createAgentRow(agent: AgentRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'onboarding-agent-row';

    const icon = createAgentIcon(agent.type, 20);

    const name = document.createElement('span');
    name.className = 'onboarding-agent-name';
    name.textContent = agent.displayName;

    const badge = document.createElement('button');
    badge.className = 'onboarding-agent-install-btn';
    badge.textContent = 'Install';
    badge.addEventListener('click', () => {
      if (this.availability[agent.type]) return; // already installed
      const info = AGENT_INSTALL_INFO[agent.type];
      if (info) {
        this.pendingAgent = agent;
        showAgentInstallDialog(agent.type, info);
      }
    });

    this.badgeEls.set(agent.type, badge);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(badge);

    return row;
  }
}

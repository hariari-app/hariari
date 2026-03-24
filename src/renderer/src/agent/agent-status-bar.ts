import type { AgentInfo, AgentStatus } from '../../../shared/agent-types';

export class AgentStatusBar {
  private readonly element: HTMLElement;
  private readonly dotEl: HTMLElement;
  private readonly statusTextEl: HTMLElement;
  private readonly uptimeEl: HTMLElement;
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: number;
  private readonly onKill: () => void;

  constructor(agentInfo: AgentInfo, onKill: () => void) {
    this.startedAt = agentInfo.startedAt;
    this.onKill = onKill;

    this.element = document.createElement('div');
    this.element.className = 'agent-status-bar';

    const typeLabel = document.createElement('span');
    typeLabel.className = 'status-bar-type';
    typeLabel.textContent = agentInfo.config.label || agentInfo.config.type;

    this.dotEl = document.createElement('span');
    this.dotEl.className = `status-dot status-${agentInfo.status}`;

    this.statusTextEl = document.createElement('span');
    this.statusTextEl.className = 'status-bar-status';
    this.statusTextEl.textContent = agentInfo.status;

    this.uptimeEl = document.createElement('span');
    this.uptimeEl.className = 'status-bar-uptime';

    const killBtn = document.createElement('button');
    killBtn.className = 'status-bar-kill';
    killBtn.textContent = '\u00d7';
    killBtn.title = 'Kill agent';
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onKill();
    });

    this.element.appendChild(this.dotEl);
    this.element.appendChild(typeLabel);
    this.element.appendChild(this.statusTextEl);
    this.element.appendChild(this.uptimeEl);
    this.element.appendChild(killBtn);

    this.startUptimeCounter();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  updateStatus(status: AgentStatus): void {
    this.dotEl.className = `status-dot status-${status}`;
    this.statusTextEl.textContent = status;

    if (status === 'stopped' || status === 'error') {
      this.stopUptimeCounter();
    }
  }

  dispose(): void {
    this.stopUptimeCounter();
    this.element.remove();
  }

  private startUptimeCounter(): void {
    this.updateUptime();
    this.uptimeInterval = setInterval(() => this.updateUptime(), 1000);
  }

  private stopUptimeCounter(): void {
    if (this.uptimeInterval !== null) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }
  }

  private updateUptime(): void {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    this.uptimeEl.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

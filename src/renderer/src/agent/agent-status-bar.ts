import type { AgentInfo, AgentStatus } from '../../../shared/agent-types';
import { createStatusIndicator, updateStatusIndicator } from '../ui/status-indicator';
import { createAgentIcon } from '../ui/agent-icons';

const STATUS_LABELS: Record<string, string> = {
  'running': 'RUNNING',
  'needs-input': 'NEEDS INPUT',
  'error': 'ERROR',
  'complete': 'COMPLETE',
  'idle': 'IDLE',
  'starting': 'STARTING',
  'stopped': 'STOPPED',
};

export class AgentStatusBar {
  private readonly element: HTMLElement;
  private readonly indicatorEl: HTMLElement;
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

    const agentIcon = createAgentIcon(agentInfo.config.type, 14);

    const typeLabel = document.createElement('span');
    typeLabel.className = 'status-bar-type';
    typeLabel.textContent = agentInfo.config.label || agentInfo.config.type;

    this.indicatorEl = createStatusIndicator(agentInfo.status);

    this.statusTextEl = document.createElement('span');
    this.statusTextEl.className = 'status-bar-status';
    this.statusTextEl.textContent = STATUS_LABELS[agentInfo.status] ?? agentInfo.status;

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

    this.element.appendChild(this.indicatorEl);
    this.element.appendChild(agentIcon);
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
    updateStatusIndicator(this.indicatorEl, status);
    this.statusTextEl.textContent = STATUS_LABELS[status] ?? status;

    // Highlight bar for needs-input and error
    this.element.classList.remove('needs-input', 'status-bar-error', 'status-bar-complete');
    if (status === 'needs-input') {
      this.element.classList.add('needs-input');
    } else if (status === 'error') {
      this.element.classList.add('status-bar-error');
    } else if (status === 'complete') {
      this.element.classList.add('status-bar-complete');
    }

    if (status === 'stopped' || status === 'error' || status === 'complete') {
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

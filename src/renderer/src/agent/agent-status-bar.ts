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

export interface StatusBarCallbacks {
  readonly onKill: () => void;
  readonly onSplitH?: () => void;
  readonly onSplitV?: () => void;
  readonly onMerge?: () => void;
}

export class AgentStatusBar {
  private readonly element: HTMLElement;
  private readonly indicatorEl: HTMLElement;
  private readonly statusTextEl: HTMLElement;
  private readonly uptimeEl: HTMLElement;
  private readonly versionEl: HTMLElement;
  private readonly branchEl: HTMLElement;
  private readonly mergeBtn: HTMLElement;
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt: number;
  private readonly onKill: () => void;

  constructor(agentInfo: AgentInfo, callbacksOrKill: (() => void) | StatusBarCallbacks) {
    const callbacks: StatusBarCallbacks = typeof callbacksOrKill === 'function'
      ? { onKill: callbacksOrKill }
      : callbacksOrKill;
    this.startedAt = agentInfo.startedAt;
    this.onKill = callbacks.onKill;

    this.element = document.createElement('div');
    this.element.className = 'agent-status-bar';

    const agentIcon = createAgentIcon(agentInfo.config.type, 14);

    const typeLabel = document.createElement('span');
    typeLabel.className = 'status-bar-type';
    typeLabel.textContent = agentInfo.config.label || agentInfo.config.type;

    this.versionEl = document.createElement('span');
    this.versionEl.className = 'status-bar-version';
    if (agentInfo.version) {
      this.versionEl.textContent = 'v' + agentInfo.version;
    }

    this.branchEl = document.createElement('span');
    this.branchEl.className = 'status-bar-branch';
    if (agentInfo.worktree) {
      const shortBranch = agentInfo.worktree.branchName.replace('vibeide/', '');
      this.branchEl.textContent = '\u2387 ' + shortBranch;
      this.branchEl.title = agentInfo.worktree.branchName;
    }

    this.mergeBtn = document.createElement('button');
    this.mergeBtn.className = 'status-bar-merge';
    this.mergeBtn.textContent = '\u2934 Merge';
    this.mergeBtn.title = 'Merge agent changes into main branch';
    this.mergeBtn.style.display = 'none';
    this.mergeBtn.setAttribute('aria-label', 'Merge agent worktree');
    this.mergeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onMerge?.();
    });
    this.mergeBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onMerge?.();
      }
    });

    this.indicatorEl = createStatusIndicator(agentInfo.status);

    this.statusTextEl = document.createElement('span');
    this.statusTextEl.className = 'status-bar-status';
    this.statusTextEl.textContent = STATUS_LABELS[agentInfo.status] ?? agentInfo.status;

    this.uptimeEl = document.createElement('span');
    this.uptimeEl.className = 'status-bar-uptime';

    // Split buttons
    const splitH = document.createElement('button');
    splitH.className = 'status-bar-split';
    splitH.textContent = '|\u200A|';
    splitH.title = 'Split horizontal';

    const splitV = document.createElement('button');
    splitV.className = 'status-bar-split';
    splitV.textContent = '\u2014';
    splitV.title = 'Split vertical';

    // Direct click handlers
    splitH.setAttribute('aria-label', 'Split pane horizontally');
    splitH.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onSplitH?.();
    });
    splitH.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onSplitH?.();
      }
    });

    splitV.setAttribute('aria-label', 'Split pane vertically');
    splitV.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onSplitV?.();
    });
    splitV.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onSplitV?.();
      }
    });

    const killBtn = document.createElement('button');
    killBtn.className = 'status-bar-kill';
    killBtn.textContent = '\u00d7';
    killBtn.title = 'Kill agent';
    killBtn.setAttribute('aria-label', 'Kill agent');
    killBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onKill();
    });
    killBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.onKill();
      }
    });

    this.element.appendChild(this.indicatorEl);
    this.element.appendChild(agentIcon);
    this.element.appendChild(typeLabel);
    this.element.appendChild(this.versionEl);
    this.element.appendChild(this.branchEl);
    this.element.appendChild(this.statusTextEl);
    this.element.appendChild(this.uptimeEl);
    this.element.appendChild(this.mergeBtn);
    this.element.appendChild(splitH);
    this.element.appendChild(splitV);
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

    // Show merge button when agent finishes (only if it has a worktree)
    if (this.branchEl.textContent && (status === 'complete' || status === 'stopped')) {
      this.mergeBtn.style.display = '';
    }
  }

  updateVersion(version: string): void {
    this.versionEl.textContent = 'v' + version;
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

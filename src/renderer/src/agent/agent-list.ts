import type { AgentInfo, AgentType } from '../../../shared/agent-types';

interface AgentListCallbacks {
  readonly onAgentSelect: (agentId: string, sessionId: string) => void;
  readonly onAgentSpawn: (type: AgentType) => void;
}

export class AgentList {
  private readonly container: HTMLElement;
  private readonly callbacks: AgentListCallbacks;
  private readonly agents = new Map<string, AgentInfo>();
  private dropdownVisible = false;
  private readonly boundHideDropdown: () => void;

  constructor(container: HTMLElement, callbacks: AgentListCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.boundHideDropdown = () => this.hideDropdown();
    this.render();
  }

  updateAgent(info: AgentInfo): void {
    this.agents.set(info.id, info);
    this.renderList();
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.renderList();
  }

  dispose(): void {
    document.removeEventListener('click', this.boundHideDropdown);
  }

  private render(): void {
    this.container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Agents';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-agent-btn';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    header.appendChild(title);
    header.appendChild(addBtn);
    this.container.appendChild(header);

    const dropdownEl = document.createElement('div');
    dropdownEl.className = 'new-agent-dropdown';
    dropdownEl.style.display = 'none';
    dropdownEl.dataset.dropdown = 'true';

    const agentTypes: Array<{ type: AgentType; label: string }> = [
      { type: 'shell', label: 'Shell' },
      { type: 'claude', label: 'Claude Code' },
      { type: 'gemini', label: 'Gemini CLI' },
      { type: 'codex', label: 'Codex' },
    ];

    for (const { type, label } of agentTypes) {
      const item = document.createElement('div');
      item.className = 'dropdown-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        this.callbacks.onAgentSpawn(type);
        this.hideDropdown();
      });
      dropdownEl.appendChild(item);
    }

    this.container.appendChild(dropdownEl);

    const listEl = document.createElement('div');
    listEl.className = 'agent-list-entries';
    this.container.appendChild(listEl);

    document.addEventListener('click', this.boundHideDropdown);
  }

  private renderList(): void {
    const listEl = this.container.querySelector('.agent-list-entries');
    if (!listEl) return;

    listEl.replaceChildren();

    for (const agent of this.agents.values()) {
      const entry = document.createElement('div');
      entry.className = 'agent-entry';
      entry.addEventListener('click', () => {
        this.callbacks.onAgentSelect(agent.id, agent.sessionId);
      });

      const dot = document.createElement('span');
      dot.className = `status-dot status-${agent.status}`;

      const label = document.createElement('span');
      label.className = 'agent-label';
      label.textContent = agent.config.label || agent.config.type;

      const badge = document.createElement('span');
      badge.className = 'agent-type-badge';
      badge.textContent = agent.config.type;

      entry.appendChild(dot);
      entry.appendChild(label);
      entry.appendChild(badge);
      listEl.appendChild(entry);
    }
  }

  private toggleDropdown(): void {
    this.dropdownVisible = !this.dropdownVisible;
    const dropdown = this.container.querySelector('[data-dropdown]') as HTMLElement;
    if (dropdown) {
      dropdown.style.display = this.dropdownVisible ? 'block' : 'none';
    }
  }

  private hideDropdown(): void {
    this.dropdownVisible = false;
    const dropdown = this.container.querySelector('[data-dropdown]') as HTMLElement;
    if (dropdown) {
      dropdown.style.display = 'none';
    }
  }
}

import type { ProjectInfo } from '../../../shared/ipc-types';
import type { AgentInfo, AgentType } from '../../../shared/agent-types';
import { createStatusIndicator, updateStatusIndicator } from '../ui/status-indicator';
import { createAgentIcon } from '../ui/agent-icons';

export interface ProjectSidebarCallbacks {
  readonly onProjectSelect: (project: ProjectInfo) => void;
  readonly onProjectAdd: () => void;
  readonly onProjectRemove: (projectId: string) => void;
  readonly onProjectRename: (projectId: string, newName: string) => void;
  readonly onProjectPin: (projectId: string, pinned: boolean) => void;
  readonly onAgentSpawn: (projectId: string, type: AgentType) => void;
  readonly onAgentSelect: (agentId: string, sessionId: string) => void;
  readonly onGitChangesClick: (projectPath: string) => void;
  readonly onFileExplorerClick: (projectPath: string) => void;
}

interface ProjectEntry {
  readonly project: ProjectInfo;
  readonly agents: AgentInfo[];
  expanded: boolean;
  notificationCount: number;
  gitChangeCount: number;
  gitChangeFiles: string[];
}

interface ProjectDomRefs {
  readonly wrapper: HTMLElement;
  readonly row: HTMLElement;
  readonly dot: HTMLElement;
  readonly arrow: HTMLElement;
  readonly name: HTMLElement;
  readonly countBadge: HTMLElement;
  readonly pinIndicator: HTMLElement;
  readonly agentListEl: HTMLElement | null;
}

export class ProjectSidebar {
  private readonly container: HTMLElement;
  private readonly callbacks: ProjectSidebarCallbacks;
  private readonly entries = new Map<string, ProjectEntry>();
  private readonly domRefs = new Map<string, ProjectDomRefs>();
  private activeProjectId: string | null = null;
  private agentDropdownProjectId: string | null = null;
  private collapsed = false;

  constructor(container: HTMLElement, callbacks: ProjectSidebarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
  }

  setProjects(projects: ProjectInfo[]): void {
    const projectIds = new Set(projects.map((p) => p.id));

    // Remove projects no longer in the list
    for (const id of this.entries.keys()) {
      if (!projectIds.has(id)) {
        this.entries.delete(id);
        const refs = this.domRefs.get(id);
        if (refs) {
          refs.wrapper.remove();
          this.domRefs.delete(id);
        }
      }
    }

    // Update or add projects
    for (const project of projects) {
      const existing = this.entries.get(project.id);
      if (existing) {
        this.entries.set(project.id, { ...existing, project });
        this.updateProjectDom(project.id);
      } else {
        this.entries.set(project.id, {
          project,
          agents: [],
          expanded: false,
          notificationCount: 0, gitChangeCount: 0, gitChangeFiles: [],
        });
      }
    }

    this.renderList();
    this.updateEmptyState();
  }

  setActiveProject(projectId: string | null): void {
    const previousId = this.activeProjectId;
    this.activeProjectId = projectId;

    // Clear notification badge when switching to a project
    if (projectId) {
      const entry = this.entries.get(projectId);
      if (entry) {
        this.entries.set(projectId, { ...entry, notificationCount: 0 });
      }
    }

    // Update only the changed rows
    if (previousId) {
      this.updateProjectRowActive(previousId);
    }
    if (projectId) {
      this.updateProjectRowActive(projectId);
      this.renderAgentList(projectId);
    }
  }

  updateAgents(projectId: string, agents: AgentInfo[]): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.set(projectId, { ...entry, agents });

    // Targeted update: status dot, count badge, agent list
    this.updateProjectDot(projectId);
    this.updateCountBadge(projectId);
    if (entry.expanded) {
      this.renderAgentList(projectId);
    }
  }

  updateAgentStatus(agentId: string, status: AgentInfo['status']): void {
    for (const [projectId, entry] of this.entries) {
      const agentIndex = entry.agents.findIndex((a) => a.id === agentId);
      if (agentIndex !== -1) {
        const updatedAgents = entry.agents.map((a) =>
          a.id === agentId ? { ...a, status } : a,
        );
        this.entries.set(projectId, { ...entry, agents: updatedAgents });

        // Targeted: update status dot only
        this.updateProjectDot(projectId);

        // Update the specific agent's indicator in the expanded list
        if (entry.expanded) {
          const agentIndicator = this.container.querySelector(
            `[data-agent-id="${agentId}"] .status-indicator`,
          ) as HTMLElement | null;
          if (agentIndicator) {
            updateStatusIndicator(agentIndicator, status);
          }
        }

        // Add notification badge if this is a non-active project
        if (projectId !== this.activeProjectId &&
            (status === 'needs-input' || status === 'complete' || status === 'error')) {
          this.incrementNotification(projectId);
        }
        return;
      }
    }
  }

  updateGitChanges(projectId: string, count: number, files: string[]): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.set(projectId, { ...entry, gitChangeCount: count, gitChangeFiles: files });
    // Targeted update of the badge
    const badge = this.container.querySelector(
      `[data-project-id="${projectId}"] .git-change-badge`,
    ) as HTMLElement | null;
    if (badge) {
      badge.textContent = count > 0 ? `\u0394${count}` : '';
      badge.title = count > 0 ? files.slice(0, 15).join('\n') + (files.length > 15 ? `\n...and ${files.length - 15} more` : '') : '';
    }
  }

  removeAgent(agentId: string): void {
    for (const [projectId, entry] of this.entries) {
      const filtered = entry.agents.filter((a) => a.id !== agentId);
      if (filtered.length !== entry.agents.length) {
        this.entries.set(projectId, { ...entry, agents: filtered });
        this.updateProjectDot(projectId);
        this.updateCountBadge(projectId);
        if (entry.expanded) {
          this.renderAgentList(projectId);
        }
        return;
      }
    }
  }

  dispose(): void {
    this.container.replaceChildren();
    this.domRefs.clear();
  }

  // --- Private: Initial render ---

  private render(): void {
    this.container.replaceChildren();

    const header = document.createElement('div');
    header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Projects';

    const addBtn = document.createElement('button');
    addBtn.className = 'add-agent-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add Project';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onProjectAdd();
    });

    header.appendChild(title);
    header.appendChild(addBtn);
    this.container.appendChild(header);

    const listEl = document.createElement('div');
    listEl.className = 'project-list-entries';
    this.container.appendChild(listEl);
  }

  // --- Private: Full list render (only on add/remove/reorder) ---

  private renderList(): void {
    const listEl = this.container.querySelector('.project-list-entries');
    if (!listEl) return;

    listEl.replaceChildren();
    this.domRefs.clear();

    for (const entry of this.entries.values()) {
      const refs = this.createProjectElement(entry);
      listEl.appendChild(refs.wrapper);
      this.domRefs.set(entry.project.id, refs);
    }
  }

  private createProjectElement(entry: ProjectEntry): ProjectDomRefs {
    const wrapper = document.createElement('div');
    wrapper.className = 'project-entry-wrapper';
    wrapper.dataset.projectId = entry.project.id;

    const row = document.createElement('div');
    row.className = 'project-entry';
    if (entry.project.id === this.activeProjectId) {
      row.classList.add('active');
    }

    row.addEventListener('click', () => {
      this.callbacks.onProjectSelect(entry.project);
    });

    // Context menu for pin/unpin
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showContextMenu(entry.project, e.clientX, e.clientY);
    });

    const arrow = document.createElement('span');
    arrow.className = 'project-arrow';
    arrow.textContent = entry.expanded ? '\u25BE' : '\u25B8';
    arrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = this.entries.get(entry.project.id);
      if (!current) return;
      const toggled = !current.expanded;
      this.entries.set(entry.project.id, { ...current, expanded: toggled });
      arrow.textContent = toggled ? '\u25BE' : '\u25B8';
      this.renderAgentList(entry.project.id);
    });

    const dot = createStatusIndicator(this.getAggregateStatus(entry.agents));

    const pinIndicator = document.createElement('span');
    pinIndicator.className = 'project-pin-indicator';
    pinIndicator.textContent = entry.project.pinned ? '\u{1F4CC}' : '';

    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = entry.project.name;
    name.title = entry.project.path;

    // Double-click to rename
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startInlineRename(entry.project.id, name);
    });

    const countBadge = document.createElement('span');
    countBadge.className = 'agent-count-badge';
    if (entry.agents.length > 0) {
      countBadge.textContent = String(entry.agents.length);
    }

    // Notification badge
    const notifBadge = document.createElement('span');
    notifBadge.className = 'project-notification-badge';
    if (entry.notificationCount > 0) {
      notifBadge.textContent = String(entry.notificationCount);
    }

    const addAgentBtn = document.createElement('button');
    addAgentBtn.className = 'project-add-agent-btn';
    addAgentBtn.textContent = '+';
    addAgentBtn.title = 'New terminal';
    addAgentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleAgentDropdown(entry.project.id, wrapper);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'project-remove-btn';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove project';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onProjectRemove(entry.project.id);
    });

    row.appendChild(arrow);
    row.appendChild(dot);
    if (entry.project.pinned) {
      row.appendChild(pinIndicator);
    }
    // Git change badge
    const gitBadge = document.createElement('span');
    gitBadge.className = 'git-change-badge';
    if (entry.gitChangeCount > 0) {
      gitBadge.textContent = `\u0394${entry.gitChangeCount}`;
      gitBadge.title = entry.gitChangeFiles.slice(0, 15).join('\n');
    }
    gitBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onGitChangesClick(entry.project.path);
    });

    // File explorer button
    const filesBtn = document.createElement('button');
    filesBtn.className = 'project-files-btn';
    filesBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/></svg>`;
    filesBtn.title = 'Browse files';
    filesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onFileExplorerClick(entry.project.path);
    });

    row.appendChild(name);
    row.appendChild(gitBadge);
    row.appendChild(notifBadge);
    row.appendChild(countBadge);
    row.appendChild(filesBtn);
    row.appendChild(addAgentBtn);
    row.appendChild(removeBtn);
    wrapper.appendChild(row);

    // Agent list container (always exists, populated when expanded)
    let agentListEl: HTMLElement | null = null;
    if (entry.expanded && entry.agents.length > 0) {
      agentListEl = this.createAgentListElement(entry.agents);
      wrapper.appendChild(agentListEl);
    }

    return { wrapper, row, dot, arrow, name, countBadge, pinIndicator, agentListEl };
  }

  private createAgentListElement(agents: AgentInfo[]): HTMLElement {
    const agentList = document.createElement('div');
    agentList.className = 'project-agent-list';

    for (const agent of agents) {
      const agentEl = document.createElement('div');
      agentEl.className = 'project-agent-entry';
      agentEl.dataset.agentId = agent.id;
      agentEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onAgentSelect(agent.id, agent.sessionId);
      });

      const agentDot = createStatusIndicator(agent.status);
      const agentIcon = createAgentIcon(agent.config.type, 13);

      const agentLabel = document.createElement('span');
      agentLabel.className = 'agent-label';
      agentLabel.textContent = agent.config.label || agent.config.type;

      const agentBadge = document.createElement('span');
      agentBadge.className = 'agent-type-badge';
      agentBadge.textContent = agent.config.type;

      agentEl.appendChild(agentDot);
      agentEl.appendChild(agentIcon);
      agentEl.appendChild(agentLabel);
      agentEl.appendChild(agentBadge);
      agentList.appendChild(agentEl);
    }

    return agentList;
  }

  // --- Private: Targeted DOM updates ---

  private updateProjectDot(projectId: string): void {
    const refs = this.domRefs.get(projectId);
    const entry = this.entries.get(projectId);
    if (!refs || !entry) return;
    updateStatusIndicator(refs.dot, this.getAggregateStatus(entry.agents));
  }

  private updateCountBadge(projectId: string): void {
    const refs = this.domRefs.get(projectId);
    const entry = this.entries.get(projectId);
    if (!refs || !entry) return;
    refs.countBadge.textContent = entry.agents.length > 0 ? String(entry.agents.length) : '';
  }

  private updateProjectRowActive(projectId: string): void {
    const refs = this.domRefs.get(projectId);
    if (!refs) return;
    refs.row.classList.toggle('active', projectId === this.activeProjectId);
  }

  private updateProjectDom(projectId: string): void {
    const refs = this.domRefs.get(projectId);
    const entry = this.entries.get(projectId);
    if (!refs || !entry) return;
    refs.name.textContent = entry.project.name;
    refs.name.title = entry.project.path;
    refs.pinIndicator.textContent = entry.project.pinned ? '\u{1F4CC}' : '';
  }

  private incrementNotification(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.set(projectId, { ...entry, notificationCount: entry.notificationCount + 1 });

    const wrapper = this.container.querySelector(
      `[data-project-id="${projectId}"] .project-notification-badge`,
    ) as HTMLElement | null;
    if (wrapper) {
      wrapper.textContent = String(entry.notificationCount + 1);
    }
  }

  private renderAgentList(projectId: string): void {
    const refs = this.domRefs.get(projectId);
    const entry = this.entries.get(projectId);
    if (!refs || !entry) return;

    // Remove existing agent list
    const existingList = refs.wrapper.querySelector('.project-agent-list');
    if (existingList) {
      existingList.remove();
    }

    if (entry.expanded && entry.agents.length > 0) {
      const agentListEl = this.createAgentListElement(entry.agents);
      refs.wrapper.appendChild(agentListEl);
    }
  }

  // --- Private: Empty state ---

  private updateEmptyState(): void {
    const listEl = this.container.querySelector('.project-list-entries');
    if (!listEl) return;

    const existing = listEl.querySelector('.project-empty-state');

    if (this.entries.size === 0) {
      if (!existing) {
        const empty = document.createElement('div');
        empty.className = 'project-empty-state';

        const msg = document.createElement('p');
        msg.textContent = 'No projects yet';

        const btn = document.createElement('button');
        btn.className = 'project-empty-btn';
        btn.textContent = 'Add Project';
        btn.addEventListener('click', () => this.callbacks.onProjectAdd());

        const hint = document.createElement('p');
        hint.className = 'project-empty-hint';
        hint.textContent = 'Ctrl+Shift+O';

        empty.appendChild(msg);
        empty.appendChild(btn);
        empty.appendChild(hint);
        listEl.appendChild(empty);
      }
    } else if (existing) {
      existing.remove();
    }
  }

  // --- Private: Context menu ---

  private showContextMenu(project: ProjectInfo, x: number, y: number): void {
    // Remove any existing context menu
    const existing = document.querySelector('.project-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'project-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const renameItem = document.createElement('div');
    renameItem.className = 'context-menu-item';
    renameItem.textContent = 'Rename';
    renameItem.addEventListener('click', () => {
      menu.remove();
      const nameEl = this.container.querySelector(
        `[data-project-id="${project.id}"] .project-name`,
      ) as HTMLElement | null;
      if (nameEl) {
        this.startInlineRename(project.id, nameEl);
      }
    });

    const pinItem = document.createElement('div');
    pinItem.className = 'context-menu-item';
    pinItem.textContent = project.pinned ? 'Unpin' : 'Pin to top';
    pinItem.addEventListener('click', () => {
      this.callbacks.onProjectPin(project.id, !project.pinned);
      menu.remove();
    });

    const separator = document.createElement('div');
    separator.className = 'context-menu-separator';

    const removeItem = document.createElement('div');
    removeItem.className = 'context-menu-item context-menu-danger';
    removeItem.textContent = 'Remove project';
    removeItem.addEventListener('click', () => {
      this.callbacks.onProjectRemove(project.id);
      menu.remove();
    });

    menu.appendChild(renameItem);
    menu.appendChild(pinItem);
    menu.appendChild(separator);
    menu.appendChild(removeItem);
    document.body.appendChild(menu);

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  // --- Private: Inline rename ---

  private startInlineRename(projectId: string, nameEl: HTMLElement): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;

    const input = document.createElement('input');
    input.className = 'project-rename-input';
    input.type = 'text';
    input.value = entry.project.name;

    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== entry.project.name) {
        this.callbacks.onProjectRename(projectId, newName);
      }
      // Restore the span
      input.replaceWith(nameEl);
      nameEl.textContent = newName || entry.project.name;
    };

    const cancel = () => {
      input.replaceWith(nameEl);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener('blur', () => {
      commit();
    });

    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  // --- Private: Agent dropdown ---

  private toggleAgentDropdown(projectId: string, wrapper: HTMLElement): void {
    const existing = this.container.querySelector('.project-agent-dropdown');
    if (existing) {
      existing.remove();
      if (this.agentDropdownProjectId === projectId) {
        this.agentDropdownProjectId = null;
        return;
      }
    }

    this.agentDropdownProjectId = projectId;

    const dropdown = document.createElement('div');
    dropdown.className = 'project-agent-dropdown new-agent-dropdown';

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
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onAgentSpawn(projectId, type);
        dropdown.remove();
        this.agentDropdownProjectId = null;
      });
      dropdown.appendChild(item);
    }

    wrapper.appendChild(dropdown);

    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        this.agentDropdownProjectId = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  // --- Private: Helpers ---

  private getAggregateStatus(agents: AgentInfo[]): string {
    if (agents.length === 0) return 'idle';
    if (agents.some((a) => a.status === 'needs-input')) return 'needs-input';
    if (agents.some((a) => a.status === 'error')) return 'error';
    if (agents.some((a) => a.status === 'running')) return 'running';
    if (agents.some((a) => a.status === 'starting')) return 'starting';
    if (agents.some((a) => a.status === 'complete')) return 'complete';
    return 'idle';
  }
}

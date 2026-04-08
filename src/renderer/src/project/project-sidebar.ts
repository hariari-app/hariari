import type { ProjectInfo } from '../../../shared/ipc-types';
import type { AgentInfo, AgentType } from '../../../shared/agent-types';
import { createStatusIndicator, updateStatusIndicator } from '../ui/status-indicator';
import { createAgentIcon } from '../ui/agent-icons';
import { logoMonoSvg } from '../ui/logo';

/** Generate a deterministic color from a project name for the letter avatar. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 50%, 55%)`;
}

export interface ProjectSidebarCallbacks {
  readonly onProjectSelect: (project: ProjectInfo) => void;
  readonly onProjectAdd: () => void;
  readonly onProjectRemove: (projectId: string) => void;
  readonly onProjectRename: (projectId: string, newName: string) => void;
  readonly onProjectPin: (projectId: string, pinned: boolean) => void;
  readonly onAgentSpawn: (projectId: string, type: AgentType) => void;
  readonly onAgentSelect: (agentId: string, sessionId: string) => void;
  readonly onAgentKill: (agentId: string) => void;
  readonly onGitChangesClick: (projectPath: string) => void;
  readonly onFileExplorerClick: (projectPath: string) => void;
  readonly onNotificationClick: (projectId: string, agentId: string, sessionId: string) => void;
  readonly onLaunchWorkspace?: () => void;
  readonly onEqualizePanes?: () => void;
  readonly onToggleSinglePreview?: () => void;
}

interface ProjectEntry {
  readonly project: ProjectInfo;
  readonly agents: AgentInfo[];
  expanded: boolean;
  notificationCount: number;
  notifyingAgentIds: string[];
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
  private savedExpandedWidth = 0;
  private previewBtn: HTMLElement | null = null;
  private previewBadge: HTMLElement | null = null;
  private autoHideEnabled = false;
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly AUTO_HIDE_DELAY_MS = 3000;

  constructor(container: HTMLElement, callbacks: ProjectSidebarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();

    // Reset auto-hide timer when user interacts with the sidebar
    this.container.addEventListener('mouseenter', () => this.clearAutoHideTimer());
    this.container.addEventListener('mouseleave', () => this.startAutoHideTimer());
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  toggleCollapse(): void {
    if (!this.collapsed) {
      // Save current width before collapsing
      this.savedExpandedWidth = this.container.offsetWidth;
    }
    this.collapsed = !this.collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
    // Clear inline width so CSS class controls sizing
    if (this.collapsed) {
      this.container.style.width = '';
      this.clearAutoHideTimer();
    } else {
      // Restore saved width when expanding
      if (this.savedExpandedWidth > 0) {
        this.container.style.width = `${this.savedExpandedWidth}px`;
      }
      this.startAutoHideTimer();
    }
    this.updateRailVisibility();
  }

  setCollapsed(collapsed: boolean): void {
    if (!collapsed && this.collapsed && this.savedExpandedWidth === 0) {
      this.savedExpandedWidth = 240;
    }
    if (!this.collapsed && collapsed) {
      this.savedExpandedWidth = this.container.offsetWidth || 240;
    }
    this.collapsed = collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) {
      this.container.style.width = '';
      this.clearAutoHideTimer();
    } else {
      if (this.savedExpandedWidth > 0) {
        this.container.style.width = `${this.savedExpandedWidth}px`;
      }
      this.startAutoHideTimer();
    }
    this.updateRailVisibility();
  }

  setAutoHide(enabled: boolean): void {
    this.autoHideEnabled = enabled;
    if (enabled) {
      this.startAutoHideTimer();
    } else {
      this.clearAutoHideTimer();
    }
  }

  isAutoHideEnabled(): boolean {
    return this.autoHideEnabled;
  }

  private startAutoHideTimer(): void {
    if (!this.autoHideEnabled || this.collapsed) return;
    this.clearAutoHideTimer();
    this.autoHideTimer = setTimeout(() => {
      if (!this.collapsed) {
        this.setCollapsed(true);
      }
    }, ProjectSidebar.AUTO_HIDE_DELAY_MS);
  }

  private clearAutoHideTimer(): void {
    if (this.autoHideTimer !== null) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  private updateRailVisibility(): void {
    const expandedContent = this.container.querySelector('.sidebar-expanded-content') as HTMLElement | null;

    if (expandedContent) {
      expandedContent.style.display = this.collapsed ? 'none' : '';
    }

    if (this.collapsed) {
      // Render rail first (creates the element if needed), then show it
      this.renderRailContent();
      const rail = this.container.querySelector('.sidebar-rail-content') as HTMLElement | null;
      if (rail) rail.style.display = 'flex';
    } else {
      const rail = this.container.querySelector('.sidebar-rail-content') as HTMLElement | null;
      if (rail) rail.style.display = 'none';
    }
  }

  private renderRailContent(): void {
    let rail = this.container.querySelector('.sidebar-rail-content') as HTMLElement | null;
    if (!rail) {
      rail = document.createElement('div');
      rail.className = 'sidebar-rail-content';
      this.container.appendChild(rail);
    }
    rail.replaceChildren();

    // Dragonfly icon at top — same visual weight as project avatars
    const logoBtn = document.createElement('button');
    logoBtn.className = 'rail-logo-btn';
    logoBtn.innerHTML = logoMonoSvg(28);
    logoBtn.title = 'Expand sidebar';
    logoBtn.setAttribute('aria-label', 'Expand sidebar');
    logoBtn.addEventListener('click', () => this.toggleCollapse());
    rail.appendChild(logoBtn);

    // Separator
    const sep = document.createElement('div');
    sep.className = 'rail-separator';
    rail.appendChild(sep);

    // Project avatars with nested agent icons
    const MAX_AGENT_ICONS = 6;

    for (const entry of this.entries.values()) {
      const project = entry.project;
      const projectBtn = document.createElement('button');
      projectBtn.className = 'rail-project-btn';
      if (project.id === this.activeProjectId) {
        projectBtn.classList.add('active');
      }
      projectBtn.title = project.name;
      projectBtn.setAttribute('aria-label', project.name);

      // Letter avatar
      const letter = document.createElement('span');
      letter.className = 'rail-avatar';
      letter.textContent = (project.name[0] ?? '?').toUpperCase();
      letter.style.background = avatarColor(project.name);
      projectBtn.appendChild(letter);

      // Notification dot
      if (entry.notificationCount > 0) {
        const dot = document.createElement('span');
        dot.className = 'rail-notify-dot';
        projectBtn.appendChild(dot);
      }

      projectBtn.addEventListener('click', () => {
        this.callbacks.onProjectSelect(project);
        // Expand sidebar when clicking a project in the rail
        if (this.collapsed) {
          this.toggleCollapse();
        }
      });

      rail.appendChild(projectBtn);

      // Agent type icons below project
      const visibleAgents = entry.agents.slice(0, MAX_AGENT_ICONS);
      for (const agent of visibleAgents) {
        const agentBtn = document.createElement('button');
        agentBtn.className = 'rail-agent-btn';
        const agentLabel = agent.config.label ?? agent.config.type;
        agentBtn.title = `${agentLabel} (${agent.status})`;
        agentBtn.setAttribute('aria-label', `${agentLabel}, ${agent.status}`);

        const icon = createAgentIcon(agent.config.type, 14);
        agentBtn.appendChild(icon);

        // Attention dot for needs-input
        if (agent.status === 'needs-input') {
          const attDot = document.createElement('span');
          attDot.className = 'rail-attention-dot';
          agentBtn.appendChild(attDot);
        }

        agentBtn.addEventListener('click', () => {
          // Switch to parent project first, then focus the agent's terminal
          this.callbacks.onProjectSelect(project);
          this.callbacks.onAgentSelect(agent.id, agent.sessionId);
        });

        rail.appendChild(agentBtn);
      }

      // Overflow badge
      if (entry.agents.length > MAX_AGENT_ICONS) {
        const overflow = document.createElement('span');
        overflow.className = 'rail-overflow';
        overflow.textContent = `+${entry.agents.length - MAX_AGENT_ICONS}`;
        overflow.title = entry.agents.slice(MAX_AGENT_ICONS).map(a => a.config.label ?? a.config.type).join(', ');
        rail.appendChild(overflow);
      }
    }
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
          notificationCount: 0, notifyingAgentIds: [], gitChangeCount: 0, gitChangeFiles: [],
        });
      }
    }

    this.renderList();
    this.updateEmptyState();
  }

  setSinglePreviewActive(active: boolean): void {
    if (this.previewBtn) {
      this.previewBtn.classList.toggle('active', active);
    }
  }

  updateNeedsInputCount(count: number): void {
    if (!this.previewBadge) return;
    if (count <= 0) {
      this.previewBadge.style.display = 'none';
      this.previewBadge.textContent = '';
    } else {
      this.previewBadge.style.display = '';
      this.previewBadge.textContent = count > 9 ? '9+' : String(count);
    }
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

    // Re-render rail to update active indicator
    if (this.collapsed) {
      this.renderRailContent();
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
    if (this.collapsed) {
      this.renderRailContent();
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
          this.incrementNotification(projectId, agentId);
        }

        // Update icon rail if collapsed
        if (this.collapsed) {
          this.renderRailContent();
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

    const expandedContent = document.createElement('div');
    expandedContent.className = 'sidebar-expanded-content';

    // --- Logo banner ---
    const logoBanner = document.createElement('div');
    logoBanner.className = 'sidebar-logo-banner';
    const logoEl = document.createElement('span');
    logoEl.className = 'sidebar-logo';
    logoEl.innerHTML = logoMonoSvg(32);
    const logoText = document.createElement('span');
    logoText.className = 'sidebar-logo-text';
    logoText.innerHTML = 'Hari<span class="sidebar-logo-text-accent">Ari</span>';
    logoBanner.appendChild(logoEl);
    logoBanner.appendChild(logoText);
    expandedContent.appendChild(logoBanner);

    // --- Toolbar row ---
    const toolbar = document.createElement('div');
    toolbar.className = 'sidebar-toolbar';

    const launchBtn = document.createElement('button');
    launchBtn.className = 'sidebar-toolbar-btn sidebar-launch-btn';
    launchBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><polygon points="3,2 13,8 3,14"/></svg>`;
    launchBtn.title = 'Launch Workspace';
    launchBtn.setAttribute('aria-label', 'Launch Workspace');
    launchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onLaunchWorkspace?.();
    });

    const equalizeBtn = document.createElement('button');
    equalizeBtn.className = 'sidebar-toolbar-btn sidebar-equalize-btn';
    equalizeBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="6" height="12" rx="1"/><rect x="9" y="2" width="6" height="12" rx="1"/></svg>`;
    equalizeBtn.title = 'Auto-arrange panes';
    equalizeBtn.setAttribute('aria-label', 'Auto-arrange panes');
    equalizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onEqualizePanes?.();
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'sidebar-toolbar-btn sidebar-add-btn';
    addBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>`;
    addBtn.title = 'Add Project';
    addBtn.setAttribute('aria-label', 'Add Project');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onProjectAdd();
    });

    const previewBtn = document.createElement('button');
    previewBtn.className = 'sidebar-toolbar-btn sidebar-preview-btn';
    previewBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`;
    previewBtn.title = 'Single Preview (Ctrl+Shift+A)';
    previewBtn.setAttribute('aria-label', 'Toggle Single Preview — view all agents');
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onToggleSinglePreview?.();
    });
    const previewBadge = document.createElement('span');
    previewBadge.className = 'sidebar-preview-badge';
    previewBadge.style.display = 'none';
    previewBtn.appendChild(previewBadge);
    this.previewBtn = previewBtn;
    this.previewBadge = previewBadge;

    toolbar.appendChild(previewBtn);
    toolbar.appendChild(launchBtn);
    toolbar.appendChild(equalizeBtn);
    toolbar.appendChild(addBtn);
    expandedContent.appendChild(toolbar);

    // --- Projects section header ---
    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'sidebar-section-header';
    sectionHeader.textContent = 'Projects';
    expandedContent.appendChild(sectionHeader);

    // --- Project list ---
    const listEl = document.createElement('div');
    listEl.className = 'project-list-entries';
    expandedContent.appendChild(listEl);

    this.container.appendChild(expandedContent);
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
    name.title = `${entry.project.path}\nDouble-click to rename`;

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
    notifBadge.title = 'Click to jump to agent';
    if (entry.notificationCount > 0) {
      notifBadge.textContent = String(entry.notificationCount);
    }
    notifBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentEntry = this.entries.get(entry.project.id);
      if (!currentEntry) return;
      // Find the most urgent notifying agent
      const targetAgentId = currentEntry.notifyingAgentIds[0];
      if (targetAgentId) {
        const agent = currentEntry.agents.find((a) => a.id === targetAgentId);
        if (agent) {
          this.callbacks.onNotificationClick(entry.project.id, agent.id, agent.sessionId);
          // Clear notifications
          this.entries.set(entry.project.id, { ...currentEntry, notificationCount: 0, notifyingAgentIds: [] });
          notifBadge.textContent = '';
        }
      }
    });

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

    // Agent list or empty hint when expanded
    let agentListEl: HTMLElement | null = null;
    if (entry.expanded) {
      if (entry.agents.length > 0) {
        agentListEl = this.createAgentListElement(entry.agents);
        wrapper.appendChild(agentListEl);
      } else {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'project-agent-list-empty';
        emptyHint.textContent = 'No agents \u2014 click + to add';
        wrapper.appendChild(emptyHint);
      }
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

      const killBtn = document.createElement('button');
      killBtn.className = 'agent-entry-kill';
      killBtn.textContent = '\u00d7';
      killBtn.title = 'Kill agent';
      killBtn.setAttribute('aria-label', 'Kill agent');
      killBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onAgentKill(agent.id);
      });

      agentEl.appendChild(agentDot);
      agentEl.appendChild(agentIcon);
      agentEl.appendChild(agentLabel);
      agentEl.appendChild(killBtn);
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

  private incrementNotification(projectId: string, agentId?: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    const notifyingAgentIds = agentId && !entry.notifyingAgentIds.includes(agentId)
      ? [...entry.notifyingAgentIds, agentId]
      : entry.notifyingAgentIds;
    this.entries.set(projectId, { ...entry, notificationCount: entry.notificationCount + 1, notifyingAgentIds });

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

    // Remove existing agent list or empty hint
    const existingList = refs.wrapper.querySelector('.project-agent-list');
    if (existingList) existingList.remove();
    const existingHint = refs.wrapper.querySelector('.project-agent-list-empty');
    if (existingHint) existingHint.remove();

    if (entry.expanded) {
      if (entry.agents.length > 0) {
        const agentListEl = this.createAgentListElement(entry.agents);
        refs.wrapper.appendChild(agentListEl);
      } else {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'project-agent-list-empty';
        emptyHint.textContent = 'No agents running';

        const launchHint = document.createElement('button');
        launchHint.className = 'project-agent-launch-hint';
        launchHint.textContent = 'Launch Agent';
        launchHint.addEventListener('click', (e) => {
          e.stopPropagation();
          // Expand sidebar first if collapsed so dropdown is visible
          if (this.collapsed) {
            this.toggleCollapse();
          }
          const wrapper = refs.wrapper;
          this.toggleAgentDropdown(projectId, wrapper);
        });

        emptyHint.appendChild(launchHint);
        refs.wrapper.appendChild(emptyHint);
      }
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

        // Dragonfly icon for warmth
        const icon = document.createElement('div');
        icon.className = 'project-empty-icon';
        icon.innerHTML = logoMonoSvg(48);

        const msg = document.createElement('p');
        msg.textContent = 'No projects yet';

        const sub = document.createElement('p');
        sub.className = 'project-empty-sub';
        sub.textContent = 'Open a folder to get started';

        const btn = document.createElement('button');
        btn.className = 'project-empty-btn';
        btn.textContent = 'Open Folder';
        btn.addEventListener('click', () => this.callbacks.onProjectAdd());

        const hint = document.createElement('p');
        hint.className = 'project-empty-hint';
        hint.textContent = 'Ctrl+Shift+O';

        empty.appendChild(icon);
        empty.appendChild(msg);
        empty.appendChild(sub);
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
      { type: 'pi', label: 'Pi' },
      { type: 'gemini', label: 'Gemini CLI' },
      { type: 'codex', label: 'Codex CLI' },
      { type: 'opencode', label: 'OpenCode' },
      { type: 'cline', label: 'Cline CLI' },
      { type: 'copilot', label: 'Copilot CLI' },
      { type: 'amp', label: 'Amp' },
      { type: 'continue', label: 'Continue' },
      { type: 'cursor', label: 'Cursor CLI' },
      { type: 'crush', label: 'Crush' },
      { type: 'qwen', label: 'Qwen Code' },
    ];

    for (const { type, label } of agentTypes) {
      const item = document.createElement('div');
      item.className = 'dropdown-item';

      const icon = createAgentIcon(type, 14);
      const text = document.createElement('span');
      text.textContent = label;

      item.appendChild(icon);
      item.appendChild(text);
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

import type { ProjectInfo } from '../../../shared/ipc-types';
import { avatarColor } from './project-sidebar';

// ---------------------------------------------------------------------------
// Callback interface
// ---------------------------------------------------------------------------

export interface ProjectTabBarCallbacks {
  readonly onTabSelect: (projectId: string) => void;
  readonly onTabClose: (projectId: string) => void | Promise<void>;
  readonly onNewProject: () => void;
  readonly onToggleSinglePreview: () => void;
  readonly onProjectRename: (projectId: string, newName: string) => void;
  readonly onProjectPin: (projectId: string, pinned: boolean) => void;
  readonly onProjectRemove: (projectId: string) => void;
}

// ---------------------------------------------------------------------------
// Internal state per tab
// ---------------------------------------------------------------------------

interface TabState {
  readonly project: ProjectInfo;
  readonly el: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly badgeEl: HTMLElement;
  readonly notifyDot: HTMLElement;
  readonly closeBtn: HTMLElement;
  agentTotal: number;
  agentNeedsInput: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_MIN_WIDTH = 80;
const PREVIEW_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
  <rect x="1" y="1" width="6" height="6" rx="1"/>
  <rect x="9" y="1" width="6" height="6" rx="1"/>
  <rect x="1" y="9" width="6" height="6" rx="1"/>
  <rect x="9" y="9" width="6" height="6" rx="1"/>
</svg>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  }
  return e;
}

function noDrag(e: HTMLElement): HTMLElement {
  e.style.cssText += '-webkit-app-region: no-drag;';
  return e;
}

// ---------------------------------------------------------------------------
// ProjectTabBar
// ---------------------------------------------------------------------------

export class ProjectTabBar {
  readonly containerEl: HTMLElement;

  private readonly callbacks: ProjectTabBarCallbacks;
  private readonly previewTab: HTMLElement;
  private readonly tabContainer: HTMLElement;
  private readonly addBtn: HTMLElement;
  private readonly overflowBtn: HTMLElement;
  private readonly overflowMenu: HTMLElement;
  private readonly dragRegion: HTMLElement;

  private tabs: readonly TabState[] = [];
  private activeProjectId: string | null = null;
  private previewActive = false;
  private contextMenu: HTMLElement | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly dismissHandler: (e: Event) => void;
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(callbacks: ProjectTabBarCallbacks) {
    this.callbacks = callbacks;

    // Root container
    this.containerEl = el('div', 'project-tab-bar', {
      role: 'tablist',
      'aria-label': 'Project workspaces',
    });
    this.containerEl.style.cssText = '-webkit-app-region: drag;';

    // macOS traffic-light pad
    if (document.body.classList.contains('platform-darwin')) {
      const pad = el('div', 'tab-bar-macos-pad');
      pad.style.minWidth = '78px';
      this.containerEl.appendChild(pad);
    }

    // Preview tab
    this.previewTab = this.buildPreviewTab();
    this.containerEl.appendChild(this.previewTab);

    // Scrollable tab container
    this.tabContainer = el('div', 'tab-bar-tabs');
    this.containerEl.appendChild(this.tabContainer);

    // Add button
    this.addBtn = noDrag(el('button', 'tab-bar-add', { 'aria-label': 'Open new project' }));
    this.addBtn.textContent = '+';
    this.addBtn.addEventListener('click', () => callbacks.onNewProject());
    this.containerEl.appendChild(this.addBtn);

    // Overflow button (hidden by default)
    this.overflowBtn = noDrag(el('button', 'tab-bar-overflow', { 'aria-hidden': 'true' }));
    this.overflowBtn.style.display = 'none';
    this.overflowBtn.addEventListener('click', () => this.toggleOverflowMenu());
    this.containerEl.appendChild(this.overflowBtn);

    // Overflow menu
    this.overflowMenu = el('div', 'tab-bar-overflow-menu');
    this.overflowMenu.style.display = 'none';
    document.body.appendChild(this.overflowMenu);

    // Drag region filler
    this.dragRegion = el('div', 'tab-bar-drag-region');
    this.containerEl.appendChild(this.dragRegion);

    // Resize observer for overflow recalc
    this.resizeObserver = new ResizeObserver(() => this.recalcOverflow());
    this.resizeObserver.observe(this.containerEl);

    // Global listeners for dismissing menus (stored for cleanup)
    this.dismissHandler = (e: Event) => this.dismissMenus(e);
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.dismissMenus(null);
    };
    document.addEventListener('click', this.dismissHandler);
    document.addEventListener('keydown', this.keyHandler);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  setProjects(projects: ReadonlyArray<ProjectInfo>): void {
    this.tabContainer.innerHTML = '';
    this.tabs = projects.map((p) => this.buildTab(p));
    for (const t of this.tabs) this.tabContainer.appendChild(t.el);
    this.refreshActiveState();
    this.recalcOverflow();
  }

  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId;
    this.refreshActiveState();
  }

  updateAgentCount(projectId: string, total: number, needsInput: number): void {
    const tab = this.tabs.find((t) => t.project.id === projectId);
    if (!tab) return;
    tab.agentTotal = total;
    tab.agentNeedsInput = needsInput;
    tab.badgeEl.textContent = total > 0 ? String(total) : '';
    tab.badgeEl.style.display = total > 0 ? '' : 'none';
    tab.notifyDot.style.display = needsInput > 0 ? '' : 'none';
    tab.el.classList.toggle('needs-input', needsInput > 0);
    const ariaSuffix = needsInput > 0 ? ', needs input' : '';
    tab.el.setAttribute('aria-label', `${tab.project.name}, ${total} agents${ariaSuffix}`);
  }

  setSinglePreviewActive(active: boolean): void {
    this.previewActive = active;
    this.previewTab.classList.toggle('active', active);
    this.previewTab.setAttribute('aria-selected', String(active));
  }

  appendWindowControls(controlsEl: HTMLElement): void {
    this.containerEl.appendChild(controlsEl);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    document.removeEventListener('click', this.dismissHandler);
    document.removeEventListener('keydown', this.keyHandler);
    this.overflowMenu.remove();
    this.dismissMenus(null);
  }

  // -----------------------------------------------------------------------
  // Tab building
  // -----------------------------------------------------------------------

  private buildPreviewTab(): HTMLElement {
    const tab = noDrag(el('button', 'tab-bar-preview', {
      role: 'tab',
      'aria-label': 'All projects preview',
      'aria-selected': 'false',
    }));
    tab.innerHTML = PREVIEW_SVG;
    const label = el('span');
    label.textContent = 'Preview';
    tab.appendChild(label);
    tab.addEventListener('click', () => this.callbacks.onToggleSinglePreview());
    return tab;
  }

  private buildTab(project: ProjectInfo): TabState {
    const tab = noDrag(el('div', 'tab-bar-tab', {
      role: 'tab',
      'aria-selected': 'false',
      'aria-label': `${project.name}, 0 agents`,
      'data-project-id': project.id,
    }));

    // Per-project color drives background tint, active underline,
    // and the whole-tab attention pulse. Same deterministic HSL the
    // sidebar rail uses, so identity is consistent across chrome.
    tab.style.setProperty('--tab-color', avatarColor(project.name));

    // Avatar dot
    const dot = el('span', 'tab-avatar-dot');
    dot.style.backgroundColor = avatarColor(project.name);
    tab.appendChild(dot);

    // Name
    const nameEl = el('span', 'tab-name');
    nameEl.textContent = project.name;
    tab.appendChild(nameEl);

    // Badge
    const badgeEl = el('span', 'tab-badge');
    badgeEl.style.display = 'none';
    tab.appendChild(badgeEl);

    // Notification dot
    const notifyDot = el('span', 'tab-notify-dot');
    notifyDot.style.display = 'none';
    tab.appendChild(notifyDot);

    // Close button
    const closeBtn = el('button', 'tab-close', {
      'aria-label': `Close ${project.name} workspace`,
    });
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onTabClose(project.id);
    });
    tab.appendChild(closeBtn);

    // Events
    tab.addEventListener('click', () => this.callbacks.onTabSelect(project.id));
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.callbacks.onTabClose(project.id);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showContextMenu(project, e.clientX, e.clientY);
    });

    return { project, el: tab, nameEl, badgeEl, notifyDot, closeBtn, agentTotal: 0, agentNeedsInput: 0 };
  }

  // -----------------------------------------------------------------------
  // Active state
  // -----------------------------------------------------------------------

  private refreshActiveState(): void {
    const isLastTab = this.tabs.length <= 1;
    for (const t of this.tabs) {
      const active = t.project.id === this.activeProjectId;
      t.el.classList.toggle('active', active);
      t.el.setAttribute('aria-selected', String(active));
      (t.closeBtn as HTMLButtonElement).disabled = isLastTab;
    }
  }

  // -----------------------------------------------------------------------
  // Overflow
  // -----------------------------------------------------------------------

  private recalcOverflow(): void {
    const containerWidth = this.containerEl.clientWidth;
    const reserved =
      (this.previewTab.offsetWidth || 60) +
      (this.addBtn.offsetWidth || 28) +
      (this.dragRegion.offsetWidth || 40) +
      (document.body.classList.contains('platform-darwin') ? 78 : 0);

    const available = containerWidth - reserved - 40; // 40px buffer for overflow btn
    const totalTabs = this.tabs.length;
    const fittable = Math.max(1, Math.floor(available / TAB_MIN_WIDTH));
    const hiddenCount = Math.max(0, totalTabs - fittable);

    for (let i = 0; i < totalTabs; i++) {
      this.tabs[i].el.style.display = i < fittable ? '' : 'none';
    }

    if (hiddenCount > 0) {
      this.overflowBtn.textContent = `\u25be +${hiddenCount}`;
      this.overflowBtn.style.display = '';
      this.overflowBtn.setAttribute('aria-hidden', 'false');
    } else {
      this.overflowBtn.style.display = 'none';
      this.overflowBtn.setAttribute('aria-hidden', 'true');
      this.overflowMenu.style.display = 'none';
    }
  }

  private toggleOverflowMenu(): void {
    const visible = this.overflowMenu.style.display !== 'none';
    if (visible) {
      this.overflowMenu.style.display = 'none';
      return;
    }

    this.overflowMenu.innerHTML = '';
    const hiddenTabs = this.tabs.filter((t) => t.el.style.display === 'none');

    for (const t of hiddenTabs) {
      const item = el('div', 'tab-bar-overflow-item');
      const dot = el('span', 'tab-avatar-dot');
      dot.style.backgroundColor = avatarColor(t.project.name);
      item.appendChild(dot);

      const name = el('span');
      name.textContent = t.project.name;
      item.appendChild(name);

      if (t.agentTotal > 0) {
        const badge = el('span', 'tab-badge');
        badge.textContent = String(t.agentTotal);
        item.appendChild(badge);
      }

      item.addEventListener('click', () => {
        this.overflowMenu.style.display = 'none';
        this.callbacks.onTabSelect(t.project.id);
      });
      this.overflowMenu.appendChild(item);
    }

    // Position relative to overflow button
    const rect = this.overflowBtn.getBoundingClientRect();
    this.overflowMenu.style.top = `${rect.bottom}px`;
    this.overflowMenu.style.left = `${rect.left}px`;
    this.overflowMenu.style.display = '';
  }

  // -----------------------------------------------------------------------
  // Context menu
  // -----------------------------------------------------------------------

  private showContextMenu(project: ProjectInfo, x: number, y: number): void {
    this.dismissMenus(null);

    const menu = el('div', 'tab-bar-context-menu');
    this.contextMenu = menu;

    const items: ReadonlyArray<{ label: string; separator?: boolean; action?: () => void }> = [
      { label: 'Close', action: () => this.callbacks.onTabClose(project.id) },
      {
        label: 'Close Others',
        action: async () => {
          const toClose = this.tabs
            .filter((t) => t.project.id !== project.id)
            .map((t) => t.project.id);
          for (const id of toClose) {
            await this.callbacks.onTabClose(id);
          }
        },
      },
      {
        label: 'Close All to the Right',
        action: async () => {
          const idx = this.tabs.findIndex((t) => t.project.id === project.id);
          const toClose = this.tabs.slice(idx + 1).map((t) => t.project.id);
          for (const id of toClose) {
            await this.callbacks.onTabClose(id);
          }
        },
      },
      { label: '', separator: true },
      {
        label: 'Rename',
        action: () => {
          const newName = prompt('Rename project:', project.name);
          if (newName && newName !== project.name) {
            this.callbacks.onProjectRename(project.id, newName);
          }
        },
      },
      {
        label: project.pinned ? 'Unpin' : 'Pin',
        action: () => this.callbacks.onProjectPin(project.id, !project.pinned),
      },
      {
        label: 'Copy Path',
        action: () => { void navigator.clipboard.writeText(project.path); },
      },
    ];

    for (const item of items) {
      if (item.separator) {
        menu.appendChild(el('div', 'tab-bar-context-separator'));
        continue;
      }
      const row = el('div', 'tab-bar-context-item');
      row.textContent = item.label;
      row.addEventListener('click', () => {
        this.dismissMenus(null);
        item.action?.();
      });
      menu.appendChild(row);
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);
  }

  // -----------------------------------------------------------------------
  // Menu dismissal
  // -----------------------------------------------------------------------

  private dismissMenus(e: Event | null): void {
    if (this.contextMenu) {
      if (e && this.contextMenu.contains(e.target as Node)) return;
      this.contextMenu.remove();
      this.contextMenu = null;
    }
    if (this.overflowMenu.style.display !== 'none') {
      if (e && (this.overflowMenu.contains(e.target as Node) || this.overflowBtn.contains(e.target as Node))) return;
      this.overflowMenu.style.display = 'none';
    }
  }
}

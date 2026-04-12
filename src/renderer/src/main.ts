import '@xterm/xterm/css/xterm.css';
import './styles/global.css';
import './styles/terminal.css';
import './styles/tab-bar.css';
import './styles/source-control.css';
import './onboarding/onboarding.css';
import './editor-window/editor-window.css';
import { ProjectSidebar } from './project/project-sidebar';
import { ProjectTabBar } from './project/project-tab-bar';
import { ProjectStore, getNeedsInputCount } from './project/project-store';
import { WorkspaceSwitcher } from './project/workspace-switcher';
import { CommandPalette } from './ui/command-palette';
import { KeybindingManager } from './ui/keybindings';
import { KeybindingEditor } from './ui/keybinding-editor';
import { KEYBINDING_DEFAULTS, loadUserKeybindings, loadUserKeybindingsAsync, getEffectiveKey } from './ui/keybinding-defaults';
import { applyTheme, loadSavedTheme } from './terminal/terminal-theme';
import { LAYOUT_PRESETS } from './layout/layout-presets';
import { FileViewer } from './file/file-viewer';
import { FileFinder } from './file/file-finder';
import { FileSearch } from './file/file-search';
import { VoiceCapture } from './voice/voice-capture';
import { setInstallCallback } from './ui/agent-install-dialog';
import { playNotificationSound } from './ui/notification-sounds';
import { loadNotificationConfig, getNotificationConfig } from './ui/notification-config';
import { toastManager } from './ui/toast-manager';
import { NotificationPreferences } from './ui/notification-preferences';
import { VoiceRouter } from './voice/voice-router';
import { LaunchWorkspaceDialog, buildDynamicPreset } from './ui/launch-workspace-dialog';
import type { ProjectInfo, AppState } from '../../shared/ipc-types';
import type { AgentInfo, AgentType } from '../../shared/agent-types';

const AUTO_SAVE_INTERVAL_MS = 30_000;

function main(): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('Missing #app element');
  }

  applyTheme(loadSavedTheme());

  // Add platform class to body for platform-specific CSS (e.g. macOS traffic lights)
  document.body.classList.add(`platform-${window.api.platform}`);

  // Check if this is a pop-out window
  const urlParams = new URLSearchParams(window.location.search);
  const popoutType = urlParams.get('popout');

  if (popoutType === 'editor-window') {
    const projectPath = urlParams.get('project') ?? '';
    const branchName = urlParams.get('branch') ?? undefined;
    if (projectPath) {
      import('./editor-window/editor-window-app')
        .then(({ EditorWindowApp }) => {
          document.body.classList.add('popout-mode');
          const editorApp = new EditorWindowApp(appEl, projectPath, branchName);
          return editorApp.init();
        })
        .catch((error) => {
          console.error('[EditorWindow] Failed to initialize:', error);
          appEl.textContent = 'Failed to load editor window.';
        });
      return;
    }
  }

  if (popoutType === 'file-viewer') {
    const projectPath = urlParams.get('project') ?? '';
    const filePath = urlParams.get('file') ?? undefined;
    if (projectPath) {
      document.body.classList.add('popout-mode');
      const viewer = new FileViewer();
      viewer.show(projectPath).then(() => {
        if (filePath) viewer.openFile(filePath);
      });
      return; // Don't load the full app
    }
  }

  // Project store — single source of truth for project/agent state
  const store = new ProjectStore();

  // Tab bar (replaces the old title bar)
  const projectTabBar = new ProjectTabBar({
    onTabSelect: async (projectId: string) => {
      const project = store.getState().projects.find((p) => p.id === projectId);
      if (project) {
        await workspaceSwitcher.switchTo(project);
        const workspace = workspaceSwitcher.getWorkspace(project.id);
        if (workspace) {
          const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
          store.updateAgents(project.id, agents);
        }
      }
    },
    onTabClose: async (projectId: string) => {
      // Check for running agents — show confirmation if any
      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        const agents = Array.from(workspace.getTrackedAgents().values());
        const running = agents.filter((t) => {
          const s = t.info.status;
          return s === 'running' || s === 'starting' || s === 'needs-input';
        });
        if (running.length > 0) {
          const confirmed = confirm(`${running.length} agent(s) still running. Close this project?`);
          if (!confirmed) return;
        }
      }
      try {
        await workspaceSwitcher.closeWorkspace(projectId);
        await window.api.project.remove(projectId);
        await refreshProjectList();
        // Auto-switch to next project
        if (workspaceSwitcher.getActiveProjectId() === null) {
          const projects = await window.api.project.list();
          if (projects.length > 0) {
            await workspaceSwitcher.switchTo(projects[0]);
            const ws = workspaceSwitcher.getWorkspace(projects[0].id);
            if (ws) {
              const agents = Array.from(ws.getTrackedAgents().values()).map((t) => t.info);
              store.updateAgents(projects[0].id, agents);
            }
          }
        }
      } catch (error) {
        console.error('[Main] Failed to close project:', error);
      }
    },
    onNewProject: async () => {
      const dirPath = await window.api.project.pickDirectory();
      if (!dirPath) return;
      try {
        const project = await window.api.project.create({ path: dirPath });
        await refreshProjectList();
        await workspaceSwitcher.switchTo(project);
        const workspace = workspaceSwitcher.getWorkspace(project.id);
        if (workspace) {
          const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
          store.updateAgents(project.id, agents);
        }
      } catch (error) {
        console.error('[Main] Failed to create project:', error);
      }
    },
    onToggleSinglePreview: () => {
      workspaceSwitcher.toggleSinglePreview();
      const inPreview = workspaceSwitcher.isInSinglePreview();
      store.setInSinglePreview(inPreview);
      ariaLive.textContent = inPreview ? 'Entering Single Preview' : 'Exiting Single Preview';
    },
    onProjectRename: async (projectId: string, newName: string) => {
      try {
        await window.api.project.update({ id: projectId, name: newName });
        await refreshProjectList();
      } catch (error) {
        console.error('[Main] Failed to rename project:', error);
      }
    },
    onProjectPin: async (projectId: string, pinned: boolean) => {
      try {
        await window.api.project.update({ id: projectId, pinned });
        await refreshProjectList();
      } catch (error) {
        console.error('[Main] Failed to pin/unpin project:', error);
      }
    },
    onProjectRemove: async (projectId: string) => {
      try {
        await workspaceSwitcher.closeWorkspace(projectId);
        await window.api.project.remove(projectId);
        await refreshProjectList();
      } catch (error) {
        console.error('[Main] Failed to remove project:', error);
      }
    },
  });

  // On Windows/Linux, create custom window controls and append to tab bar.
  // On macOS, skip entirely — the OS native traffic lights are positioned
  // on the left via main-window.ts trafficLightPosition, and creating
  // custom controls on the right would duplicate them.
  if (window.api.platform !== 'darwin') {
    const titleControls = document.createElement('div');
    titleControls.className = 'app-titlebar-controls';
    titleControls.setAttribute('role', 'toolbar');
    titleControls.setAttribute('aria-label', 'Window controls');

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'app-titlebar-btn minimize';
    minimizeBtn.setAttribute('aria-label', 'Minimize window');
    minimizeBtn.textContent = '\u2212'; // − MINUS SIGN
    minimizeBtn.addEventListener('click', () => window.api.window.minimize());

    const maximizeBtn = document.createElement('button');
    maximizeBtn.className = 'app-titlebar-btn maximize';
    maximizeBtn.setAttribute('aria-label', 'Maximize window');
    maximizeBtn.textContent = '\u25A1'; // □ WHITE SQUARE
    maximizeBtn.addEventListener('click', () => window.api.window.maximize());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'app-titlebar-btn close';
    closeBtn.setAttribute('aria-label', 'Close window');
    closeBtn.textContent = '\u2715'; // ✕ MULTIPLICATION X
    closeBtn.addEventListener('click', () => window.api.window.close());

    titleControls.appendChild(minimizeBtn);
    titleControls.appendChild(maximizeBtn);
    titleControls.appendChild(closeBtn);
    projectTabBar.appendWindowControls(titleControls);
  }

  appEl.appendChild(projectTabBar.containerEl);

  // App body (sidebar + workspace)
  const appBody = document.createElement('div');
  appBody.className = 'app-body';
  appEl.appendChild(appBody);

  // Font size state
  let terminalFontSize = 14;
  let uiFontSize = 13;
  let worktreeIsolation = true;
  let sidebarAutoHide = false;

  // Load font/sidebar/worktree settings
  window.api.settings.load().then((s) => {
    if (s.terminalFontSize && typeof s.terminalFontSize === 'number') {
      terminalFontSize = s.terminalFontSize as number;
    }
    if (s.uiFontSize && typeof s.uiFontSize === 'number') {
      uiFontSize = s.uiFontSize as number;
      document.documentElement.style.setProperty('--font-base', `${uiFontSize}px`);
    }
    if (s.sidebarWidth && typeof s.sidebarWidth === 'number') {
      sidebarEl.style.width = `${s.sidebarWidth}px`;
    }
    if (typeof s.worktreeIsolation === 'boolean') {
      worktreeIsolation = s.worktreeIsolation;
    }
    if (typeof s.sidebarAutoHide === 'boolean') {
      sidebarAutoHide = s.sidebarAutoHide;
    }
  }).catch(() => {});

  // Create sidebar
  const sidebarEl = document.createElement('div');
  sidebarEl.className = 'agent-sidebar';
  sidebarEl.setAttribute('role', 'navigation');
  sidebarEl.setAttribute('aria-label', 'Project sidebar');
  appBody.appendChild(sidebarEl);

  // Sidebar resize handle
  const sidebarHandle = document.createElement('div');
  sidebarHandle.className = 'sidebar-resize-handle';
  sidebarEl.appendChild(sidebarHandle);

  sidebarHandle.addEventListener('mousedown', (startEvent) => {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startWidth = sidebarEl.offsetWidth;

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(140, Math.min(500, startWidth + (e.clientX - startX)));
      sidebarEl.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist sidebar width
      const width = sidebarEl.offsetWidth;
      window.api.settings.load().then((s) => {
        window.api.settings.save({ ...s, sidebarWidth: width });
      }).catch(() => {});
      // Refit terminals
      const ws = workspaceSwitcher.getActiveWorkspace();
      if (ws) ws.terminalManager.fitAll();
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Create workspace host (holds all project workspace containers)
  const workspaceHost = document.createElement('div');
  workspaceHost.className = 'workspace-host';
  workspaceHost.setAttribute('role', 'main');
  workspaceHost.setAttribute('aria-label', 'Terminal workspace');
  appBody.appendChild(workspaceHost);

  // Empty workspace state
  const emptyState = document.createElement('div');
  emptyState.className = 'workspace-empty-state';
  emptyState.innerHTML = `
    <p>No project open</p>
    <p><kbd>Ctrl+Shift+O</kbd> to add a project</p>
    <p><kbd>Ctrl+Shift+P</kbd> for command palette</p>
  `;
  workspaceHost.appendChild(emptyState);

  // Hint bar at bottom
  const hintBar = document.createElement('div');
  hintBar.className = 'workspace-hint-bar';
  hintBar.setAttribute('role', 'status');
  hintBar.setAttribute('aria-label', 'Keyboard shortcuts');
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const mod = isMac ? '\u2318' : 'Ctrl';
  const shift = isMac ? '\u21E7' : 'Shift';
  const sep = isMac ? '' : '+';
  const versionLabel = `v${window.api.appVersion}`;
  hintBar.innerHTML = `
    <span class="hint-item"><kbd>${mod}${sep}${shift}${sep}P</kbd> Commands</span>
    <span class="hint-item"><kbd>${mod}${sep}P</kbd> Open File</span>
    <span class="hint-item"><kbd>${mod}${sep}${shift}${sep}D</kbd> Split</span>
    <span class="hint-item"><kbd>${mod}${sep}${shift}${sep}W</kbd> Close</span>
    <span class="hint-item"><kbd>${mod}${sep}B</kbd> Sidebar</span>
    <span class="hint-item"><kbd>F3</kbd> Dictate</span>
    <span class="hint-item"><kbd>F4</kbd> Voice Cmd</span>
    <span class="hint-version">${versionLabel}</span>
  `;
  appEl.appendChild(hintBar);

  // Aria-live region for screen reader announcements of agent status changes
  const ariaLive = document.createElement('div');
  ariaLive.setAttribute('role', 'log');
  ariaLive.setAttribute('aria-live', 'polite');
  ariaLive.setAttribute('aria-label', 'Agent status updates');
  ariaLive.className = 'sr-only';
  document.body.appendChild(ariaLive);

  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAnnouncement = '';

  function announceStatus(agentName: string, status: string): void {
    const messages: Record<string, string> = {
      'needs-input': `${agentName} needs your input`,
      'complete': `${agentName} completed`,
      'error': `${agentName} encountered an error`,
      'running': `${agentName} is running`,
      'starting': `${agentName} is starting`,
    };
    const text = messages[status] ?? `${agentName} status: ${status}`;
    pendingAnnouncement = text;

    // Throttle: max 1 announcement per 2 seconds
    if (!announceTimer) {
      ariaLive.textContent = text;
      announceTimer = setTimeout(() => {
        announceTimer = null;
        if (pendingAnnouncement !== ariaLive.textContent) {
          ariaLive.textContent = pendingAnnouncement;
        }
      }, 2000);
    }
  }

  // Workspace switcher
  const workspaceSwitcher = new WorkspaceSwitcher(workspaceHost, (projectId) => {
    emptyState.style.display = (projectId || workspaceSwitcher.isInSinglePreview()) ? 'none' : '';
    store.setActiveProject(projectId);
    if (projectId) {
      store.clearNotifications(projectId);
      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        workspace.useWorktree = worktreeIsolation;
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        store.updateAgents(projectId, agents);
      }
    }
  });

  // Launch Workspace dialog (instantiated early so sidebar can reference it)
  const launchWorkspaceDialog = new LaunchWorkspaceDialog();

  // Project sidebar
  const projectSidebar = new ProjectSidebar(sidebarEl, {
    onProjectSelect: async (project: ProjectInfo) => {
      await workspaceSwitcher.switchTo(project);
      // After switching, update the agent list for this project
      const workspace = workspaceSwitcher.getWorkspace(project.id);
      if (workspace) {
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        store.updateAgents(project.id, agents);
      }
    },
    onProjectAdd: async () => {
      const dirPath = await window.api.project.pickDirectory();
      if (!dirPath) return;

      try {
        const project = await window.api.project.create({ path: dirPath });
        await refreshProjectList();
        await workspaceSwitcher.switchTo(project);
        const workspace = workspaceSwitcher.getWorkspace(project.id);
        if (workspace) {
          const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
          store.updateAgents(project.id, agents);
        }
      } catch (error) {
        console.error('[Main] Failed to create project:', error);
      }
    },
    onProjectRemove: async (projectId: string) => {
      try {
        await workspaceSwitcher.closeWorkspace(projectId);
        await window.api.project.remove(projectId);
        await refreshProjectList();

        // Auto-switch to next available project
        if (workspaceSwitcher.getActiveProjectId() === null) {
          const projects = await window.api.project.list();
          if (projects.length > 0) {
            await workspaceSwitcher.switchTo(projects[0]);
            const workspace = workspaceSwitcher.getWorkspace(projects[0].id);
            if (workspace) {
              const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
              store.updateAgents(projects[0].id, agents);
            }
          }
        }
      } catch (error) {
        console.error('[Main] Failed to remove project:', error);
      }
    },
    onProjectRename: async (projectId: string, newName: string) => {
      try {
        await window.api.project.update({ id: projectId, name: newName });
        await refreshProjectList();
      } catch (error) {
        console.error('[Main] Failed to rename project:', error);
      }
    },
    onProjectPin: async (projectId: string, pinned: boolean) => {
      try {
        await window.api.project.update({ id: projectId, pinned });
        await refreshProjectList();
      } catch (error) {
        console.error('[Main] Failed to pin/unpin project:', error);
      }
    },
    onAgentSpawn: async (projectId: string, type: AgentType) => {
      // Ensure we're on the right project and workspace exists
      const projects = await window.api.project.list();
      const project = projects.find((p: ProjectInfo) => p.id === projectId);
      if (!project) return;

      // Always switchTo to ensure workspace is created (idempotent if already active)
      await workspaceSwitcher.switchTo(project);

      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        await workspace.spawnAgent(type);
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        store.updateAgents(projectId, agents);
      }
    },
    onAgentSelect: (_agentId: string, sessionId: string) => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        workspace.focusTerminal(sessionId);
      }
    },
    onAgentKill: async (agentId: string) => {
      for (const ws of workspaceSwitcher.getAllWorkspaces()) {
        if (ws.hasAgent(agentId)) {
          await ws.killAgent(agentId);
          const agents = Array.from(ws.getTrackedAgents().values()).map((t) => t.info);
          store.updateAgents(ws.projectId, agents);
          break;
        }
      }
    },
    onGitChangesClick: (projectPath: string) => {
      fileViewer.showChanges(projectPath);
    },
    onFileExplorerClick: (projectPath: string) => {
      fileViewer.show(projectPath);
    },
    onNotificationClick: async (projectId: string, _agentId: string, sessionId: string) => {
      // Switch to the project and focus the agent's terminal
      const projects = await window.api.project.list();
      const project = projects.find((p: ProjectInfo) => p.id === projectId);
      if (!project) return;
      if (workspaceSwitcher.getActiveProjectId() !== projectId) {
        await workspaceSwitcher.switchTo(project);
      }
      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        workspace.focusTerminal(sessionId);
        const leaf = workspace.layoutManager.findLeafBySessionId(sessionId);
        if (leaf) {
          workspace.layoutManager.focusLeaf(leaf.id);
        }
      }
    },
    onEqualizePanes: () => {
      const ws = workspaceSwitcher.getActiveWorkspace();
      if (ws) ws.layoutManager.equalizeAll();
    },
    onToggleSinglePreview: () => {
      workspaceSwitcher.toggleSinglePreview();
      const inPreview = workspaceSwitcher.isInSinglePreview();
      store.setInSinglePreview(inPreview);
      ariaLive.textContent = inPreview ? 'Entering Single Preview' : 'Exiting Single Preview';
    },
    onLaunchWorkspace: () => {
      launchWorkspaceDialog.show(async (result) => {
        await workspaceSwitcher.switchTo(result.project);
        store.setActiveProject(result.project.id);
        await refreshProjectList();
        const preset = buildDynamicPreset(result.agents, result.layout);
        const workspace = workspaceSwitcher.getActiveWorkspace();
        if (workspace) {
          const success = await workspace.applyPreset(preset);
          if (success) {
            const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
            store.updateAgents(result.project.id, agents);
          }
        }
      });
    },
  });

  // Store subscription — fan out state changes to both sidebar and tab bar
  store.subscribe((state, prev) => {
    // Projects changed
    if (state.projects !== prev.projects) {
      projectSidebar.setProjects(state.projects as ProjectInfo[]);
      projectTabBar.setProjects(state.projects);
    }
    // Active project changed
    if (state.activeProjectId !== prev.activeProjectId) {
      projectSidebar.setActiveProject(state.activeProjectId);
      projectTabBar.setActiveProject(state.activeProjectId);
    }
    // Agent data changed — update sidebar and tab bar badges
    if (state.agentsByProject !== prev.agentsByProject) {
      for (const [projectId, agents] of state.agentsByProject) {
        if (agents !== prev.agentsByProject.get(projectId)) {
          projectSidebar.updateAgents(projectId, agents as AgentInfo[]);
          const total = agents.length;
          const needsInput = agents.filter((a) => a.status === 'needs-input').length;
          projectTabBar.updateAgentCount(projectId, total, needsInput);
        }
      }
      // Update needs-input badge on sidebar
      const count = getNeedsInputCount(state);
      projectSidebar.updateNeedsInputCount(count);
    }
    // Single preview changed
    if (state.inSinglePreview !== prev.inSinglePreview) {
      projectSidebar.setSinglePreviewActive(state.inSinglePreview);
      projectTabBar.setSinglePreviewActive(state.inSinglePreview);
    }
  });

  // Periodic git status poll for sidebar badges
  async function refreshGitBadges(): Promise<void> {
    try {
      const projects = await window.api.project.list();
      for (const project of projects) {
        const status = await window.api.git.status(project.path);
        if (status.isRepo) {
          const files = status.changes.map((c: { path: string }) => c.path);
          projectSidebar.updateGitChanges(project.id, status.changes.length, files);
        }
      }
    } catch { /* ignore */ }
  }

  // Refresh git badges on startup and every 15 seconds
  setTimeout(refreshGitBadges, 2000);
  setInterval(refreshGitBadges, 15_000);

  // Auto-update status listener
  let updateToastId: number | null = null;
  window.api.update.onStatus((status) => {
    // Dismiss previous update toast
    if (updateToastId !== null) {
      toastManager.dismiss(updateToastId);
      updateToastId = null;
    }

    switch (status.state) {
      case 'available':
        // Don't show a separate toast — the download-progress toast will appear
        // immediately since autoDownload is true. Avoids a flicker.
        break;
      case 'downloading':
        updateToastId = toastManager.showGeneric({
          title: 'Downloading Update',
          message: `${status.progress ?? 0}% complete${status.version ? ` (v${status.version})` : ''}`,
          color: 'var(--accent)',
          persistent: true,
        });
        break;
      case 'downloaded':
        updateToastId = toastManager.showGeneric({
          title: 'Update Ready',
          message: `Version ${status.version ?? ''} downloaded. Restart to apply.`,
          color: 'var(--success)',
          persistent: true,
          actionLabel: 'Restart Now',
          onAction: () => window.api.update.install(),
        });
        break;
      case 'manual-available':
        updateToastId = toastManager.showGeneric({
          title: 'Update Available',
          message: `Version ${status.version ?? ''} is available. Download from GitHub to update.`,
          color: 'var(--accent)',
          persistent: true,
          actionLabel: 'Download',
          onAction: () => {
            if (status.downloadUrl) {
              window.api.shell.openExternal(status.downloadUrl);
            }
          },
        });
        break;
      case 'error':
        // Only show error for manual checks, not scheduled ones
        if (status.error) {
          toastManager.showGeneric({
            title: 'Update Error',
            message: status.error,
            color: 'var(--error)',
          });
        }
        break;
      case 'not-available':
        // Silent for scheduled checks — only show for manual
        break;
    }
  });

  // Agent install callback — spawns a shell terminal and runs the install command
  setInstallCallback(async (installCommand: string) => {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    const info = await workspace.spawnAgent('shell');
    if (info) {
      // Small delay to let the terminal initialize, then send the install command
      setTimeout(() => {
        window.api.pty.write({ sessionId: info.sessionId, data: installCommand + '\n' });
      }, 500);
    }
  });

  // Agent event listeners
  const unsubStatus = window.api.agent.onStatus((event) => {
    workspaceSwitcher.handleAgentStatus(event.agentId, event.status);
    store.updateAgentStatus(event.agentId, event.status);

    // Announce status change for screen readers
    const statusInfo = findAgentInfo(event.agentId);
    if (statusInfo) {
      announceStatus(statusInfo.config.label ?? statusInfo.config.type, event.status);
    }

    if (event.status === 'needs-input') {
      const config = getNotificationConfig();

      // Sound notification
      playNotificationSound('needs-input');

      // Toast notification
      const agentInfo = findAgentInfo(event.agentId);
      if (agentInfo) {
        toastManager.show({
          event: 'needs-input',
          agentName: agentInfo.config.label || agentInfo.config.type,
          agentType: agentInfo.config.type,
          message: 'Waiting for your input',
          onClick: () => focusAgentTerminal(agentInfo.id),
        });
      }

      // Desktop notification for non-active projects
      if (config.events['needs-input'].desktop) {
        const activeId = workspaceSwitcher.getActiveProjectId();
        for (const ws of getAllWorkspaces()) {
          if (ws.hasAgent(event.agentId) && ws.projectId !== activeId) {
            window.api.notify.show({
              title: 'Agent needs input',
              body: 'An agent in another project is waiting for your response',
              urgency: 'critical',
            });
            break;
          }
        }
      }
    }
  });

  const unsubExit = window.api.agent.onExit((event) => {
    // Capture agent info before status update (which may remove it from tracked map)
    const agentInfo = findAgentInfo(event.agentId);

    workspaceSwitcher.handleAgentExit(event.agentId, event.exitCode);
    const exitStatus = event.exitCode === 0 ? 'complete' : 'error';
    store.updateAgentStatus(event.agentId, exitStatus as any);

    const config = getNotificationConfig();

    // Sound notification
    playNotificationSound(exitStatus as 'complete' | 'error');

    // Toast notification
    if (agentInfo) {
      toastManager.show({
        event: exitStatus as 'complete' | 'error',
        agentName: agentInfo.config.label || agentInfo.config.type,
        agentType: agentInfo.config.type,
        message: event.exitCode === 0 ? 'Completed successfully' : `Exited with error (code ${event.exitCode})`,
        onClick: () => focusAgentTerminal(agentInfo.id),
      });
    }

    // Desktop notification for non-active projects
    if (config.events[exitStatus as 'complete' | 'error'].desktop) {
      const activeId = workspaceSwitcher.getActiveProjectId();
      for (const ws of getAllWorkspaces()) {
        if (ws.hasAgent(event.agentId) && ws.projectId !== activeId) {
          const label = event.exitCode === 0 ? 'completed' : `exited with code ${event.exitCode}`;
          window.api.notify.show({
            title: `Agent ${label}`,
            body: `An agent in another project has ${label}`,
            urgency: event.exitCode === 0 ? 'low' : 'normal',
          });
          break;
        }
      }
    }
  });

  // Command palette
  const commandPalette = new CommandPalette();
  commandPalette.register({
    id: 'new-project',
    label: 'New Project',
    shortcut: 'Ctrl+Shift+O',
    category: 'General',
    action: () => projectSidebar['callbacks'].onProjectAdd(),
  });
  commandPalette.register({
    id: 'new-shell',
    label: 'New Shell in Project',
    shortcut: 'Ctrl+Shift+N',
    category: 'Agent',
    action: () => spawnInActiveProject('shell'),
  });
  commandPalette.register({
    id: 'new-claude',
    label: 'New Claude Agent in Project',
    shortcut: 'Ctrl+Shift+1',
    category: 'Agent',
    action: () => spawnInActiveProject('claude'),
  });
  commandPalette.register({
    id: 'new-gemini',
    label: 'New Gemini Agent in Project',
    shortcut: 'Ctrl+Shift+2',
    category: 'Agent',
    action: () => spawnInActiveProject('gemini'),
  });
  commandPalette.register({
    id: 'new-codex',
    label: 'New Codex Agent in Project',
    shortcut: 'Ctrl+Shift+3',
    category: 'Agent',
    action: () => spawnInActiveProject('codex'),
  });
  commandPalette.register({
    id: 'new-pi',
    label: 'New Pi Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('pi'),
  });
  commandPalette.register({
    id: 'new-opencode',
    label: 'New OpenCode Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('opencode'),
  });
  commandPalette.register({
    id: 'new-cline',
    label: 'New Cline Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('cline'),
  });
  commandPalette.register({
    id: 'new-copilot',
    label: 'New Copilot Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('copilot'),
  });
  commandPalette.register({
    id: 'new-amp',
    label: 'New Amp Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('amp'),
  });
  commandPalette.register({
    id: 'new-continue',
    label: 'New Continue Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('continue'),
  });
  commandPalette.register({
    id: 'new-cursor',
    label: 'New Cursor Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('cursor'),
  });
  commandPalette.register({
    id: 'new-crush',
    label: 'New Crush Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('crush'),
  });
  commandPalette.register({
    id: 'new-qwen',
    label: 'New Qwen Code Agent in Project',
    category: 'Agent',
    action: () => spawnInActiveProject('qwen'),
  });
  commandPalette.register({
    id: 'toggle-worktree-isolation',
    label: worktreeIsolation ? 'Git: Disable Worktree Isolation' : 'Git: Enable Worktree Isolation',
    category: 'Git',
    action: () => {
      worktreeIsolation = !worktreeIsolation;
      for (const ws of workspaceSwitcher.getAllWorkspaces()) {
        ws.useWorktree = worktreeIsolation;
      }
      commandPalette.updateLabel(
        'toggle-worktree-isolation',
        worktreeIsolation ? 'Git: Disable Worktree Isolation' : 'Git: Enable Worktree Isolation',
      );
      window.api.settings.load().then((s) => {
        window.api.settings.save({ ...s, worktreeIsolation });
      }).catch(() => {});
    },
  });
  commandPalette.register({
    id: 'split-v',
    label: 'Split Vertical',
    shortcut: 'Ctrl+Shift+D',
    category: 'Layout',
    action: () => spawnInActiveProject('shell', 'vertical'),
  });
  commandPalette.register({
    id: 'split-h',
    label: 'Split Horizontal',
    shortcut: 'Ctrl+Shift+R',
    category: 'Layout',
    action: () => spawnInActiveProject('shell', 'horizontal'),
  });
  commandPalette.register({
    id: 'equalize-panes',
    label: 'Equalize All Panes',
    category: 'Layout',
    context: 'terminal',
    action: () => {
      const ws = workspaceSwitcher.getActiveWorkspace();
      if (ws) ws.layoutManager.equalizeAll();
    },
  });

  commandPalette.register({
    id: 'toggle-single-preview',
    label: 'Toggle Single Preview',
    category: 'View',
    action: () => { workspaceSwitcher.toggleSinglePreview(); const inPreview = workspaceSwitcher.isInSinglePreview(); store.setInSinglePreview(inPreview); ariaLive.textContent = inPreview ? 'Entering Single Preview' : 'Exiting Single Preview'; },
  });

  commandPalette.register({
    id: 'launch-workspace',
    label: 'Launch Workspace',
    category: 'General',
    action: () => {
      launchWorkspaceDialog.show(async (result) => {
        // Switch to selected project
        await workspaceSwitcher.switchTo(result.project);
        store.setActiveProject(result.project.id);
        await refreshProjectList();

        // Build and apply custom preset
        const preset = buildDynamicPreset(result.agents, result.layout);
        const workspace = workspaceSwitcher.getActiveWorkspace();
        if (workspace) {
          const success = await workspace.applyPreset(preset);
          if (success) {
            const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
            store.updateAgents(result.project.id, agents);
          }
        }
      });
    },
  });

  // File viewer
  const fileViewer = new FileViewer();

  // Fuzzy file finder — opens file in viewer
  const fileFinder = new FileFinder(async (filePath) => {
    const ws = workspaceSwitcher.getActiveWorkspace();
    if (ws) {
      await fileViewer.show(ws.projectPath);
      fileViewer.openFile(filePath);
    }
  });

  commandPalette.register({
    id: 'file-finder',
    label: 'Quick Open File',
    shortcut: 'Ctrl+P',
    category: 'File',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) fileFinder.toggle(workspace.projectPath);
    },
  });

  // Cross-file search
  const fileSearch = new FileSearch(async (filePath, _lineNumber) => {
    const ws = workspaceSwitcher.getActiveWorkspace();
    if (ws) {
      await fileViewer.show(ws.projectPath);
      fileViewer.openFile(filePath);
    }
  });

  commandPalette.register({
    id: 'file-search',
    label: 'Search Across Files',
    shortcut: 'Ctrl+Shift+H',
    category: 'File',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) fileSearch.toggle(workspace.projectPath);
    },
  });

  commandPalette.register({
    id: 'git-changes',
    label: 'Git: Show Changes',
    shortcut: 'Ctrl+Shift+G',
    category: 'Git',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) fileViewer.showChanges(workspace.projectPath);
    },
  });

  commandPalette.register({
    id: 'editor-window',
    label: 'Open Editor Window',
    shortcut: 'Ctrl+Shift+E',
    category: 'File',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        window.api.window.popoutEditor(workspace.projectPath).catch(() => {});
      }
    },
  });
  commandPalette.register({
    id: 'file-viewer',
    label: 'Open File Viewer (Overlay)',
    category: 'File',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        fileViewer.toggle(workspace.projectPath);
      }
    },
  });
  commandPalette.register({
    id: 'file-viewer-popout',
    label: 'Open File Viewer in New Window',
    shortcut: 'Ctrl+Shift+F2',
    category: 'File',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        window.api.window.popoutFile(workspace.projectPath);
      }
    },
  });

  // Voice input
  // Voice command router — detects "hariari <command>" vs terminal text
  const voiceRouter = new VoiceRouter((text) => {
    const sessionId = workspaceSwitcher.getFocusedSessionId();
    if (sessionId) {
      window.api.pty.write({ sessionId, data: text });
    }
  });

  // Register voice commands for app actions
  voiceRouter.registerCommand({ id: 'split-vertical', aliases: ['split vertical', 'split vertically', 'vertical split'], action: () => spawnInActiveProject('shell', 'vertical') });
  voiceRouter.registerCommand({ id: 'split-horizontal', aliases: ['split horizontal', 'split horizontally', 'horizontal split'], action: () => spawnInActiveProject('shell', 'horizontal') });
  voiceRouter.registerCommand({ id: 'new-shell', aliases: ['new shell', 'new terminal', 'open shell', 'open terminal'], action: () => spawnInActiveProject('shell') });
  voiceRouter.registerCommand({ id: 'new-claude', aliases: ['new claude', 'open claude', 'start claude', 'claude agent', 'new cloud', 'open cloud'], action: () => spawnInActiveProject('claude') });
  voiceRouter.registerCommand({ id: 'new-gemini', aliases: ['new gemini', 'open gemini', 'start gemini', 'gemini agent'], action: () => spawnInActiveProject('gemini') });
  voiceRouter.registerCommand({ id: 'new-codex', aliases: ['new codex', 'open codex', 'start codex', 'codex agent'], action: () => spawnInActiveProject('codex') });
  voiceRouter.registerCommand({ id: 'new-pi', aliases: ['new pi', 'open pi', 'start pi', 'pi agent', 'new pie', 'open pie'], action: () => spawnInActiveProject('pi') });
  voiceRouter.registerCommand({ id: 'new-opencode', aliases: ['new opencode', 'open opencode', 'start opencode', 'opencode agent', 'new open code', 'open open code'], action: () => spawnInActiveProject('opencode') });
  voiceRouter.registerCommand({ id: 'new-cline', aliases: ['new cline', 'open cline', 'start cline', 'cline agent', 'new Klein', 'open Klein'], action: () => spawnInActiveProject('cline') });
  voiceRouter.registerCommand({ id: 'new-copilot', aliases: ['new copilot', 'open copilot', 'start copilot', 'copilot agent'], action: () => spawnInActiveProject('copilot') });
  voiceRouter.registerCommand({ id: 'new-amp', aliases: ['new amp', 'open amp', 'start amp', 'amp agent'], action: () => spawnInActiveProject('amp') });
  voiceRouter.registerCommand({ id: 'new-continue', aliases: ['new continue', 'open continue', 'start continue', 'continue agent'], action: () => spawnInActiveProject('continue') });
  voiceRouter.registerCommand({ id: 'new-cursor', aliases: ['new cursor', 'open cursor', 'start cursor', 'cursor agent'], action: () => spawnInActiveProject('cursor') });
  voiceRouter.registerCommand({ id: 'new-crush', aliases: ['new crush', 'open crush', 'start crush', 'crush agent'], action: () => spawnInActiveProject('crush') });
  voiceRouter.registerCommand({ id: 'new-qwen', aliases: ['new qwen', 'open qwen', 'start qwen', 'qwen agent', 'new when', 'open when'], action: () => spawnInActiveProject('qwen') });
  voiceRouter.registerCommand({ id: 'close-pane', aliases: ['close pane', 'close terminal', 'close this', 'close tab'], action: () => closeFocused() });
  voiceRouter.registerCommand({ id: 'equalize-panes', aliases: ['equalize panes', 'equal size', 'auto arrange', 'reset layout', 'equal panes'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) ws.layoutManager.equalizeAll(); } });
  voiceRouter.registerCommand({ id: 'toggle-single-preview', aliases: ['single preview', 'preview all', 'show all agents', 'all agents', 'overview'], action: () => { workspaceSwitcher.toggleSinglePreview(); const inPreview = workspaceSwitcher.isInSinglePreview(); store.setInSinglePreview(inPreview); ariaLive.textContent = inPreview ? 'Entering Single Preview' : 'Exiting Single Preview'; } });
  voiceRouter.registerCommand({ id: 'launch-workspace', aliases: ['launch workspace', 'setup workspace', 'new workspace', 'workspace setup'], action: () => { launchWorkspaceDialog.show(async (result) => { await workspaceSwitcher.switchTo(result.project); store.setActiveProject(result.project.id); await refreshProjectList(); const preset = buildDynamicPreset(result.agents, result.layout); const workspace = workspaceSwitcher.getActiveWorkspace(); if (workspace) { const success = await workspace.applyPreset(preset); if (success) { const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info); store.updateAgents(result.project.id, agents); } } }); } });
  voiceRouter.registerCommand({ id: 'toggle-sidebar', aliases: ['toggle sidebar', 'hide sidebar', 'show sidebar', 'sidebar'], action: () => projectSidebar.toggleCollapse() });
  voiceRouter.registerCommand({ id: 'command-palette', aliases: ['command palette', 'commands', 'open commands', 'show commands'], action: () => commandPalette.toggle() });
  voiceRouter.registerCommand({ id: 'file-finder', aliases: ['open file', 'quick open', 'find file', 'go to file'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) fileFinder.toggle(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'git-changes', aliases: ['show changes', 'git status', 'git diff', 'show diff', 'view changes'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) fileViewer.showChanges(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'editor-window', aliases: ['open editor', 'editor window', 'open files', 'file viewer', 'show files', 'browse files', 'file browser'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) window.api.window.popoutEditor(ws.projectPath).catch(() => {}); } });
  voiceRouter.registerCommand({ id: 'file-viewer-popout', aliases: ['pop out files', 'pop out file viewer', 'file viewer new window', 'open files new window'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) window.api.window.popoutFile(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'search', aliases: ['search', 'find', 'search terminal', 'find in terminal'], action: () => toggleSearchOnFocused() });
  voiceRouter.registerCommand({ id: 'zoom-in', aliases: ['zoom in', 'make bigger', 'increase size'], action: () => window.api.window.zoomIn() });
  voiceRouter.registerCommand({ id: 'zoom-out', aliases: ['zoom out', 'make smaller', 'decrease size'], action: () => window.api.window.zoomOut() });
  voiceRouter.registerCommand({ id: 'zoom-reset', aliases: ['reset zoom', 'normal size', 'default size'], action: () => window.api.window.zoomReset() });
  voiceRouter.registerCommand({ id: 'font-increase', aliases: ['bigger font', 'increase font', 'larger font', 'font bigger'], action: () => changeTerminalFontSize(1) });
  voiceRouter.registerCommand({ id: 'font-decrease', aliases: ['smaller font', 'decrease font', 'font smaller'], action: () => changeTerminalFontSize(-1) });
  voiceRouter.registerCommand({ id: 'notification-prefs', aliases: ['notification settings', 'notification preferences', 'sound settings'], action: () => notificationPrefs.toggle() });

  // Theme commands
  const themeNames = ['tokyo night', 'tokyo night light', 'solarized dark', 'dracula', 'nord', 'gruvbox dark', 'one dark', 'catppuccin mocha', 'monokai', 'brutalist', 'brutalist light', 'caffeine dark', 'caffeine light'];
  const themeIds = ['tokyoNight', 'tokyoNightLight', 'solarizedDark', 'dracula', 'nord', 'gruvboxDark', 'oneDark', 'catppuccinMocha', 'monokai', 'brutalist', 'brutalistLight', 'caffeineDark', 'caffeineLight'];
  for (let i = 0; i < themeNames.length; i++) {
    const id = themeIds[i];
    voiceRouter.registerCommand({ id: `theme-${id}`, aliases: [`theme ${themeNames[i]}`, themeNames[i], `switch to ${themeNames[i]}`], action: () => switchTheme(id) });
  }

  // Layout presets
  for (const preset of LAYOUT_PRESETS) {
    voiceRouter.registerCommand({ id: `preset-${preset.id}`, aliases: [`layout ${preset.label.toLowerCase()}`, preset.label.toLowerCase()], action: () => { applyPresetToActive(preset.id).catch(() => {}); } });
  }

  // Voice mode: 'dictation' types into terminal, 'command' matches app commands
  let voiceMode: 'dictation' | 'command' = 'dictation';

  const voiceCapture = new VoiceCapture(
    (text) => {
      if (voiceMode === 'command') {
        const result = voiceRouter.routeCommand(text);
        if (result.matched) {
          voiceCapture.showDoneState(`\u2713 ${result.command}`);
        } else {
          voiceCapture.showDoneState(text);
        }
      } else {
        voiceRouter.routeDictation(text);
        voiceCapture.showDoneState(text);
      }
    },
    (_state) => {
      // State change callback — indicator handles UI
    },
  );

  // Load voice settings from disk
  voiceCapture.ensureSettingsLoaded();
  loadNotificationConfig();

  // Notification preferences
  const notificationPrefs = new NotificationPreferences();
  commandPalette.register({
    id: 'notification-preferences',
    label: 'Notification Preferences',
    category: 'General',
    action: () => notificationPrefs.toggle(),
  });

  commandPalette.register({
    id: 'voice-toggle', category: 'Voice',
    label: 'Voice Dictation (hold to talk)',
    shortcut: 'Ctrl+Shift+M (hold)',
    action: () => voiceCapture.toggle(),
  });
  commandPalette.register({
    id: 'voice-setup', category: 'Voice',
    label: 'Voice Input: Configure',
    action: () => voiceCapture.showSetup(),
  });
  commandPalette.register({
    id: 'voice-mode-command', category: 'Voice',
    label: 'Voice Mode: Command (symbols + case conversion)',
    action: () => voiceCapture.setPostProcessMode('command'),
  });
  commandPalette.register({
    id: 'voice-mode-natural', category: 'Voice',
    label: 'Voice Mode: Natural (raw transcription)',
    action: () => voiceCapture.setPostProcessMode('natural'),
  });
  commandPalette.register({
    id: 'voice-mode-code', category: 'Voice',
    label: 'Voice Mode: Code (symbols + abbreviations)',
    action: () => voiceCapture.setPostProcessMode('code'),
  });

  // Layout preset commands
  for (const preset of LAYOUT_PRESETS) {
    commandPalette.register({
      id: `preset-${preset.id}`,
      label: `Layout: ${preset.label}`,
      shortcut: preset.shortcut,
      category: 'Layout' as const,
      action: () => {
        applyPresetToActive(preset.id).catch((err) => {
          console.error('[Main] Preset failed:', err);
        });
      },
    });
  }

  commandPalette.register({
    id: 'toggle-sidebar', category: 'View',
    label: 'Toggle Sidebar',
    shortcut: 'Ctrl+B',
    action: () => projectSidebar.toggleCollapse(),
  });
  commandPalette.register({
    id: 'toggle-sidebar-auto-hide', category: 'View',
    label: sidebarAutoHide ? 'Sidebar: Disable Auto-Hide' : 'Sidebar: Enable Auto-Hide',
    action: () => {
      sidebarAutoHide = !sidebarAutoHide;
      projectSidebar.setAutoHide(sidebarAutoHide);
      commandPalette.updateLabel(
        'toggle-sidebar-auto-hide',
        sidebarAutoHide ? 'Sidebar: Disable Auto-Hide' : 'Sidebar: Enable Auto-Hide',
      );
      window.api.settings.load().then((s) => {
        window.api.settings.save({ ...s, sidebarAutoHide });
      }).catch(() => {});
    },
  });
  commandPalette.register({
    id: 'check-for-updates', category: 'General',
    label: 'Check for Updates',
    action: () => {
      window.api.update.check();
      toastManager.showGeneric({
        title: 'Update',
        message: 'Checking for updates...',
      });
    },
  });
  commandPalette.register({
    id: 'close-pane', category: 'Layout',
    label: 'Close Pane',
    shortcut: 'Ctrl+Shift+W',
    action: () => closeFocused(),
  });
  commandPalette.register({
    id: 'search-terminal', category: 'General',
    label: 'Search in Terminal',
    shortcut: 'Ctrl+Shift+F',
    action: () => toggleSearchOnFocused(),
  });
  const themeEntries: Array<{ id: string; label: string }> = [
    { id: 'tokyoNight', label: 'Tokyo Night' },
    { id: 'tokyoNightLight', label: 'Tokyo Night Light' },
    { id: 'solarizedDark', label: 'Solarized Dark' },
    { id: 'solarizedLight', label: 'Solarized Light' },
    { id: 'dracula', label: 'Dracula' },
    { id: 'nord', label: 'Nord' },
    { id: 'gruvboxDark', label: 'Gruvbox Dark' },
    { id: 'oneDark', label: 'One Dark' },
    { id: 'catppuccinMocha', label: 'Catppuccin Mocha' },
    { id: 'catppuccinLatte', label: 'Catppuccin Latte' },
    { id: 'monokai', label: 'Monokai' },
    { id: 'githubLight', label: 'GitHub Light' },
    { id: 'brutalist', label: 'Brutalist' },
    { id: 'brutalistLight', label: 'Brutalist Light' },
    { id: 'caffeineDark', label: 'Caffeine Dark' },
    { id: 'caffeineLight', label: 'Caffeine Light' },
  ];
  for (const theme of themeEntries) {
    commandPalette.register({
      id: `theme-${theme.id}`,
      label: `Theme: ${theme.label}`,
      category: 'Theme' as const,
      action: () => switchTheme(theme.id),
    });
  }

  // Font size commands
  function changeTerminalFontSize(delta: number): void {
    terminalFontSize = Math.max(8, Math.min(28, terminalFontSize + delta));
    for (const ws of workspaceSwitcher.getAllWorkspaces()) {
      ws.terminalManager.setDefaultFontSize(terminalFontSize);
      ws.terminalManager.setFontSizeAll(terminalFontSize);
    }
    window.api.settings.load().then((s) => {
      window.api.settings.save({ ...s, terminalFontSize });
    }).catch(() => {});
  }

  function changeUIFontSize(delta: number): void {
    uiFontSize = Math.max(10, Math.min(20, uiFontSize + delta));
    document.documentElement.style.setProperty('--font-base', `${uiFontSize}px`);
    document.documentElement.style.setProperty('--font-sm', `${uiFontSize - 2}px`);
    document.documentElement.style.setProperty('--font-md', `${uiFontSize + 1}px`);
    document.documentElement.style.setProperty('--font-xs', `${uiFontSize - 3}px`);
    window.api.settings.load().then((s) => {
      window.api.settings.save({ ...s, uiFontSize });
    }).catch(() => {});
  }

  commandPalette.register({
    id: 'terminal-font-increase', category: 'View',
    label: 'Terminal: Increase Font Size',
    shortcut: 'Ctrl++',
    action: () => changeTerminalFontSize(1),
  });
  commandPalette.register({
    id: 'terminal-font-decrease', category: 'View',
    label: 'Terminal: Decrease Font Size',
    shortcut: 'Ctrl+-',
    action: () => changeTerminalFontSize(-1),
  });
  commandPalette.register({
    id: 'ui-font-increase', category: 'View',
    label: 'UI: Increase Font Size',
    action: () => changeUIFontSize(1),
  });
  commandPalette.register({
    id: 'ui-font-decrease', category: 'View',
    label: 'UI: Decrease Font Size',
    action: () => changeUIFontSize(-1),
  });
  commandPalette.register({
    id: 'font-reset', category: 'View',
    label: 'Reset All Font Sizes',
    action: () => {
      terminalFontSize = 14;
      uiFontSize = 13;
      changeTerminalFontSize(0);
      changeUIFontSize(0);
    },
  });

  // Keybinding action map — maps definition IDs to actions
  const keybindingActions: Record<string, { action: () => void; holdUp?: () => void }> = {
    'command-palette': { action: () => { updatePaletteContext(); commandPalette.toggle(); } },
    'toggle-sidebar': { action: () => projectSidebar.toggleCollapse() },
    'git-changes': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileViewer.showChanges(ws.projectPath);
      },
    },
    'file-search': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileSearch.toggle(ws.projectPath);
      },
    },
    'file-finder': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileFinder.toggle(ws.projectPath);
      },
    },
    'editor-window': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) window.api.window.popoutEditor(ws.projectPath).catch(() => {});
      },
    },
    'file-viewer': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileViewer.toggle(ws.projectPath);
      },
    },
    'file-viewer-popout': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) window.api.window.popoutFile(ws.projectPath);
      },
    },
    'add-project': { action: () => projectSidebar['callbacks'].onProjectAdd() },
    'new-shell': { action: () => spawnInActiveProject('shell') },
    'split-vertical': { action: () => spawnInActiveProject('shell', 'vertical') },
    'split-horizontal': { action: () => spawnInActiveProject('shell', 'horizontal') },
    'close-pane': { action: () => closeFocused() },
    'search-terminal': { action: () => toggleSearchOnFocused() },
    'voice-push-to-talk': {
      action: () => { voiceMode = 'dictation'; voiceCapture.startListening(); },
      holdUp: () => voiceCapture.stopListening(),
    },
    'voice-command': {
      action: () => { voiceMode = 'command'; voiceCapture.startListening(); },
      holdUp: () => voiceCapture.stopListening(),
    },
    'font-increase': { action: () => changeTerminalFontSize(1) },
    'font-decrease': { action: () => changeTerminalFontSize(-1) },
    'zoom-in': { action: () => window.api.window.zoomIn() },
    'zoom-out': { action: () => window.api.window.zoomOut() },
    'zoom-reset': { action: () => window.api.window.zoomReset() },
    'toggle-single-preview': { action: () => { workspaceSwitcher.toggleSinglePreview(); const inPreview = workspaceSwitcher.isInSinglePreview(); store.setInSinglePreview(inPreview); ariaLive.textContent = inPreview ? 'Entering Single Preview' : 'Exiting Single Preview'; } },
  };

  // Keybinding manager — registers from config, re-registers on change
  const keybindings = new KeybindingManager();

  function registerAllKeybindings(): void {
    keybindings.clearAll();
    const overrides = loadUserKeybindings();

    for (const def of KEYBINDING_DEFAULTS) {
      const key = getEffectiveKey(def.id, overrides);
      if (!key) continue;
      const binding = keybindingActions[def.id];
      if (!binding) continue;

      if (def.holdMode && binding.holdUp) {
        keybindings.registerHold(key, binding.action, binding.holdUp);
      } else {
        keybindings.register(key, binding.action);
      }
    }
  }

  // Load saved keybindings from file, then register
  loadUserKeybindingsAsync().then(() => {
    registerAllKeybindings();
    // Ctrl+Shift+V image paste — the main process intercepts this via
    // before-input-event (prevents Chromium's native "paste as plain text")
    // and pushes an IPC event here. This is the primary path on all platforms.
    window.api.clipboard.onTriggerPaste(() => {
      const sessionId = workspaceSwitcher.getFocusedSessionId();
      if (!sessionId) return;
      for (const ws of workspaceSwitcher.getAllWorkspaces()) {
        const panel = ws.terminalManager.getTerminal(sessionId);
        if (panel) {
          panel.triggerImagePaste();
          return;
        }
      }
    });

    // Ctrl+Shift+V JS-level fallback for popout windows or if
    // the main process handler is unavailable.
    keybindings.register('ctrl+shift+v', () => {
      const sessionId = workspaceSwitcher.getFocusedSessionId();
      if (!sessionId) return;
      for (const ws of workspaceSwitcher.getAllWorkspaces()) {
        const panel = ws.terminalManager.getTerminal(sessionId);
        if (panel) {
          panel.triggerImagePaste();
          return;
        }
      }
    });
  });

  // Keybinding editor
  const keybindingEditor = new KeybindingEditor(() => {
    registerAllKeybindings();
  });

  commandPalette.register({
    id: 'keybinding-editor', category: 'General',
    label: 'Keyboard Shortcuts',
    shortcut: 'Ctrl+K Ctrl+S',
    action: () => keybindingEditor.toggle(),
  });

  function getAllWorkspaces() {
    return workspaceSwitcher.getAllWorkspaces();
  }

  function findAgentInfo(agentId: string) {
    for (const ws of getAllWorkspaces()) {
      const tracked = ws.getTrackedAgents();
      const entry = tracked.get(agentId);
      if (entry) return entry.info;
    }
    return undefined;
  }

  function focusAgentTerminal(agentId: string) {
    for (const ws of getAllWorkspaces()) {
      const tracked = ws.getTrackedAgents();
      const entry = tracked.get(agentId);
      if (entry) {
        // If already active, just focus
        if (ws.isActive()) {
          ws.focusTerminal(entry.info.sessionId);
        } else {
          // Need to switch project — look up project info
          window.api.project.list().then((projects) => {
            const project = projects.find((p) => p.id === ws.projectId);
            if (project) {
              workspaceSwitcher.switchTo(project).then(() => {
                store.setActiveProject(ws.projectId);
                ws.focusTerminal(entry.info.sessionId);
              });
            }
          });
        }
        return;
      }
    }
  }

  function updatePaletteContext(): void {
    const ws = workspaceSwitcher.getActiveWorkspace();
    if (!ws) {
      commandPalette.setContext({ hasFocusedTerminal: false, focusedAgentType: null });
      return;
    }
    const leafId = ws.layoutManager.getFocusedLeafId();
    const hasFocused = !!leafId;
    let agentType: string | null = null;
    if (leafId) {
      const leafEl = document.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
      const sessionId = leafEl?.dataset.sessionId ?? null;
      if (sessionId) {
        for (const tracked of ws.getTrackedAgents().values()) {
          if (tracked.info.sessionId === sessionId) {
            agentType = tracked.info.config.type;
            break;
          }
        }
      }
    }
    commandPalette.setContext({ hasFocusedTerminal: hasFocused, focusedAgentType: agentType });
  }

  function sendToFocusedTerminal(data: string): void {
    const ws = workspaceSwitcher.getActiveWorkspace();
    if (!ws) return;
    const leafId = ws.layoutManager.getFocusedLeafId();
    if (!leafId) return;
    const leafEl = document.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
    const sessionId = leafEl?.dataset.sessionId ?? null;
    if (sessionId) {
      window.api.pty.write({ sessionId, data });
    }
  }

  // Register agent-specific commands (context-aware)
  commandPalette.registerDynamic('claude', [
    { id: 'claude-accept', label: 'Claude: Accept Changes', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'claude-reject', label: 'Claude: Reject Changes', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
    { id: 'claude-plan', label: 'Claude: Show Plan', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('/plan\n') },
    { id: 'claude-compact', label: 'Claude: Compact Context', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('/compact\n') },
  ]);
  commandPalette.registerDynamic('gemini', [
    { id: 'gemini-accept', label: 'Gemini: Accept', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'gemini-reject', label: 'Gemini: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('codex', [
    { id: 'codex-approve', label: 'Codex: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'codex-reject', label: 'Codex: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('pi', [
    { id: 'pi-approve', label: 'Pi: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'pi-reject', label: 'Pi: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('opencode', [
    { id: 'opencode-approve', label: 'OpenCode: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'opencode-reject', label: 'OpenCode: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('cline', [
    { id: 'cline-approve', label: 'Cline: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'cline-reject', label: 'Cline: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('copilot', [
    { id: 'copilot-approve', label: 'Copilot: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'copilot-reject', label: 'Copilot: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('amp', [
    { id: 'amp-approve', label: 'Amp: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'amp-reject', label: 'Amp: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('continue', [
    { id: 'continue-approve', label: 'Continue: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'continue-reject', label: 'Continue: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('cursor', [
    { id: 'cursor-approve', label: 'Cursor: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'cursor-reject', label: 'Cursor: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('crush', [
    { id: 'crush-approve', label: 'Crush: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'crush-reject', label: 'Crush: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);
  commandPalette.registerDynamic('qwen', [
    { id: 'qwen-approve', label: 'Qwen: Approve', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('y\n') },
    { id: 'qwen-reject', label: 'Qwen: Reject', category: 'Agent', context: 'agent', action: () => sendToFocusedTerminal('n\n') },
  ]);

  // Tag terminal-specific commands with context
  commandPalette.register({
    id: 'search-terminal',
    label: 'Search in Terminal',
    shortcut: 'Ctrl+Shift+F',
    category: 'View',
    context: 'terminal',
    action: () => toggleSearchOnFocused(),
  });

  // Listen for agent version updates
  window.api.agent.onVersion((event) => {
    for (const ws of getAllWorkspaces()) {
      const tracked = ws.getTrackedAgents().get(event.agentId);
      if (tracked) {
        (tracked as any).statusBar?.updateVersion?.(event.version);
        break;
      }
    }
  });

  async function applyPresetToActive(presetId: string): Promise<void> {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) {
      console.warn('[Preset] No active workspace');
      return;
    }
    const preset = LAYOUT_PRESETS.find((p) => p.id === presetId);
    if (!preset) {
      console.warn('[Preset] Preset not found:', presetId);
      return;
    }
    const success = await workspace.applyPreset(preset);
    if (success) {
      const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
      store.updateAgents(workspace.projectId, agents);
    }
  }

  async function spawnInActiveProject(type: AgentType, direction?: 'horizontal' | 'vertical'): Promise<void> {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    await workspace.spawnAgent(type, direction);
    const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
    store.updateAgents(workspace.projectId, agents);
  }

  function closeFocused(): void {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    const leafId = workspace.layoutManager.getFocusedLeafId();
    if (leafId) {
      workspace.layoutManager.closePane(leafId);
      workspace.layoutManager.equalizeAll();
    }
  }

  function toggleSearchOnFocused(): void {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    const leafId = workspace.layoutManager.getFocusedLeafId();
    if (!leafId) return;
    const leafEl = document.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
    const sessionId = leafEl?.dataset.sessionId ?? null;
    if (sessionId) {
      workspace.terminalManager.toggleSearchOnFocused(sessionId);
    }
  }

  function switchTheme(name: string): void {
    applyTheme(name);
    workspaceSwitcher.setThemeAll(name);
  }

  async function refreshProjectList(): Promise<void> {
    try {
      const projects = await window.api.project.list();
      store.setProjects(projects);
      workspaceSwitcher.updateProjectNames(projects);
    } catch (error) {
      console.error('[Main] Failed to refresh project list:', error);
    }
  }

  async function saveGlobalState(): Promise<void> {
    try {
      await workspaceSwitcher.saveAllStates();

      let existingState: AppState | null = null;
      try {
        existingState = await window.api.state.load();
      } catch {
        // Ignore
      }

      const state: AppState = {
        window: existingState?.window ?? { x: 0, y: 0, width: 1400, height: 900, isMaximized: false },
        activeProjectId: workspaceSwitcher.getActiveProjectId(),
        sidebarCollapsed: projectSidebar.isCollapsed(),
        layout: null,
        agents: [],
      };
      await window.api.state.save(state);
    } catch (error) {
      console.error('[Main] Failed to save global state:', error);
    }
  }

  // Check if onboarding is needed
  window.api.settings.load().then(async (settings) => {
    const projects = await window.api.project.list();
    if (!settings.onboardingComplete) {
      const { OnboardingWizard } = await import('./onboarding/onboarding-wizard');
      const wizard = new OnboardingWizard(appEl, {
        initialStep: typeof settings.onboardingStep === 'number' ? settings.onboardingStep : 0,
        onComplete: () => refreshProjectList(),
        onSkip: () => refreshProjectList(),
      });
      wizard.show();
    }
  }).catch(() => {});

  // Initialize
  initializeFromState(workspaceSwitcher, projectSidebar, refreshProjectList, store).then(() => {
    // Restore sidebar collapsed state and auto-hide setting
    Promise.all([
      window.api.state.load().catch(() => null),
      window.api.settings.load().catch(() => ({})),
    ]).then(([state, settings]) => {
      if (state?.sidebarCollapsed) {
        projectSidebar.setCollapsed(true);
      }
      // Apply auto-hide from persisted settings (authoritative source)
      const s = settings as Record<string, unknown>;
      if (typeof s.sidebarAutoHide === 'boolean') {
        sidebarAutoHide = s.sidebarAutoHide;
      }
      projectSidebar.setAutoHide(sidebarAutoHide);
      // Sync command palette label
      commandPalette.updateLabel(
        'toggle-sidebar-auto-hide',
        sidebarAutoHide ? 'Sidebar: Disable Auto-Hide' : 'Sidebar: Enable Auto-Hide',
      );
    });
  });

  // Periodic auto-save
  const autoSaveTimer = setInterval(() => {
    saveGlobalState();
  }, AUTO_SAVE_INTERVAL_MS);

  // Save state on window unload
  window.addEventListener('beforeunload', () => {
    clearInterval(autoSaveTimer);
    saveGlobalState();
  });
}

async function initializeFromState(
  workspaceSwitcher: WorkspaceSwitcher,
  _projectSidebar: ProjectSidebar,
  refreshProjectList: () => Promise<void>,
  appStore: ProjectStore,
): Promise<void> {
  try {
    await refreshProjectList();

    const savedState = await window.api.state.load();
    const projects = await window.api.project.list();

    if (savedState?.activeProjectId) {
      const activeProject = projects.find((p: ProjectInfo) => p.id === savedState.activeProjectId);
      if (activeProject) {
        await workspaceSwitcher.switchTo(activeProject);
        const workspace = workspaceSwitcher.getWorkspace(activeProject.id);
        if (workspace) {
          const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
          appStore.updateAgents(activeProject.id, agents);
        }
        return;
      }
    }

    // If there's exactly one project, auto-switch to it
    if (projects.length === 1) {
      await workspaceSwitcher.switchTo(projects[0]);
      const workspace = workspaceSwitcher.getWorkspace(projects[0].id);
      if (workspace) {
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        appStore.updateAgents(projects[0].id, agents);
      }
    }
  } catch (error) {
    console.error('[Main] Failed to initialize from state:', error);
  }
}

document.addEventListener('DOMContentLoaded', main);

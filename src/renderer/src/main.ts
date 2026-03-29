import '@xterm/xterm/css/xterm.css';
import './styles/global.css';
import './styles/terminal.css';
import { ProjectSidebar } from './project/project-sidebar';
import { WorkspaceSwitcher } from './project/workspace-switcher';
import { CommandPalette } from './ui/command-palette';
import { KeybindingManager } from './ui/keybindings';
import { KeybindingEditor } from './ui/keybinding-editor';
import { KEYBINDING_DEFAULTS, loadUserKeybindings, loadUserKeybindingsAsync, getEffectiveKey } from './ui/keybinding-defaults';
import { applyTheme, loadSavedTheme } from './terminal/terminal-theme';
import { LAYOUT_PRESETS } from './layout/layout-presets';
import { FileViewer } from './file/file-viewer';
import { FileFinder } from './file/file-finder';
import { VoiceCapture } from './voice/voice-capture';
import { VoiceRouter } from './voice/voice-router';
import type { ProjectInfo, AppState } from '../../shared/ipc-types';
import type { AgentType } from '../../shared/agent-types';

const AUTO_SAVE_INTERVAL_MS = 30_000;

function main(): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('Missing #app element');
  }

  applyTheme(loadSavedTheme());

  // Custom title bar
  const titleBar = document.createElement('div');
  titleBar.className = 'app-titlebar';

  const titleText = document.createElement('span');
  titleText.className = 'app-titlebar-title';
  titleText.textContent = 'VibeIDE';

  const titleControls = document.createElement('div');
  titleControls.className = 'app-titlebar-controls';

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'app-titlebar-btn minimize';
  minimizeBtn.addEventListener('click', () => window.api.window.minimize());

  const maximizeBtn = document.createElement('button');
  maximizeBtn.className = 'app-titlebar-btn maximize';
  maximizeBtn.addEventListener('click', () => window.api.window.maximize());

  const closeBtn = document.createElement('button');
  closeBtn.className = 'app-titlebar-btn close';
  closeBtn.addEventListener('click', () => window.api.window.close());

  titleControls.appendChild(minimizeBtn);
  titleControls.appendChild(maximizeBtn);
  titleControls.appendChild(closeBtn);
  titleBar.appendChild(titleText);
  titleBar.appendChild(titleControls);
  appEl.appendChild(titleBar);

  // App body (sidebar + workspace)
  const appBody = document.createElement('div');
  appBody.className = 'app-body';
  appEl.appendChild(appBody);

  // Font size state
  let terminalFontSize = 14;
  let uiFontSize = 13;

  // Load font/sidebar settings
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
  }).catch(() => {});

  // Create sidebar
  const sidebarEl = document.createElement('div');
  sidebarEl.className = 'agent-sidebar';
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
  hintBar.innerHTML = `
    <span class="hint-item"><kbd>Ctrl+Shift+P</kbd> Commands</span>
    <span class="hint-item"><kbd>Ctrl+P</kbd> Open File</span>
    <span class="hint-item"><kbd>Ctrl+Shift+D</kbd> Split</span>
    <span class="hint-item"><kbd>Ctrl+Shift+W</kbd> Close</span>
    <span class="hint-item"><kbd>Ctrl+B</kbd> Sidebar</span>
    <span class="hint-item"><kbd>F3</kbd> Dictate</span>
    <span class="hint-item"><kbd>F4</kbd> Voice Cmd</span>
  `;
  appEl.appendChild(hintBar);

  // Workspace switcher
  const workspaceSwitcher = new WorkspaceSwitcher(workspaceHost, (projectId) => {
    emptyState.style.display = projectId ? 'none' : '';
    projectSidebar.setActiveProject(projectId);
    // Update agents in sidebar for the active workspace
    if (projectId) {
      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        projectSidebar.updateAgents(projectId, agents);
      }
    }
  });

  // Project sidebar
  const projectSidebar = new ProjectSidebar(sidebarEl, {
    onProjectSelect: async (project: ProjectInfo) => {
      await workspaceSwitcher.switchTo(project);
      // After switching, update the agent list for this project
      const workspace = workspaceSwitcher.getWorkspace(project.id);
      if (workspace) {
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        projectSidebar.updateAgents(project.id, agents);
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
          projectSidebar.updateAgents(project.id, agents);
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
              projectSidebar.updateAgents(projects[0].id, agents);
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
      // Ensure we're on the right project
      const projects = await window.api.project.list();
      const project = projects.find((p: ProjectInfo) => p.id === projectId);
      if (!project) return;

      if (workspaceSwitcher.getActiveProjectId() !== projectId) {
        await workspaceSwitcher.switchTo(project);
      }

      const workspace = workspaceSwitcher.getWorkspace(projectId);
      if (workspace) {
        await workspace.spawnAgent(type);
        const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
        projectSidebar.updateAgents(projectId, agents);
      }
    },
    onAgentSelect: (_agentId: string, sessionId: string) => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        workspace.focusTerminal(sessionId);
      }
    },
    onGitChangesClick: (projectPath: string) => {
      fileViewer.showChanges(projectPath);
    },
    onFileExplorerClick: (projectPath: string) => {
      fileViewer.show(projectPath);
    },
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

  // Agent event listeners
  const unsubStatus = window.api.agent.onStatus((event) => {
    workspaceSwitcher.handleAgentStatus(event.agentId, event.status);
    projectSidebar.updateAgentStatus(event.agentId, event.status);

    // Desktop notification for needs-input on non-active projects
    if (event.status === 'needs-input') {
      const activeId = workspaceSwitcher.getActiveProjectId();
      for (const ws of getAllWorkspaces()) {
        if (ws.hasAgent(event.agentId) && ws.projectId !== activeId) {
          window.api.notify.show({
            title: 'Agent needs input',
            body: `An agent in another project is waiting for your response`,
            urgency: 'critical',
          });
          break;
        }
      }
    }
  });

  const unsubExit = window.api.agent.onExit((event) => {
    workspaceSwitcher.handleAgentExit(event.agentId, event.exitCode);
    const exitStatus = event.exitCode === 0 ? 'complete' : 'error';
    projectSidebar.updateAgentStatus(event.agentId, exitStatus as any);

    // Desktop notification for agent completion/error
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
  });

  // Command palette
  const commandPalette = new CommandPalette();
  commandPalette.register({
    id: 'new-project',
    label: 'New Project',
    shortcut: 'Ctrl+Shift+O',
    action: () => projectSidebar['callbacks'].onProjectAdd(),
  });
  commandPalette.register({
    id: 'new-shell',
    label: 'New Shell in Project',
    shortcut: 'Ctrl+Shift+N',
    action: () => spawnInActiveProject('shell'),
  });
  commandPalette.register({
    id: 'new-claude',
    label: 'New Claude Agent in Project',
    shortcut: 'Ctrl+Shift+1',
    action: () => spawnInActiveProject('claude'),
  });
  commandPalette.register({
    id: 'new-gemini',
    label: 'New Gemini Agent in Project',
    shortcut: 'Ctrl+Shift+2',
    action: () => spawnInActiveProject('gemini'),
  });
  commandPalette.register({
    id: 'new-codex',
    label: 'New Codex Agent in Project',
    shortcut: 'Ctrl+Shift+3',
    action: () => spawnInActiveProject('codex'),
  });
  commandPalette.register({
    id: 'split-v',
    label: 'Split Vertical',
    shortcut: 'Ctrl+Shift+D',
    action: () => spawnInActiveProject('shell', 'vertical'),
  });
  commandPalette.register({
    id: 'split-h',
    label: 'Split Horizontal',
    shortcut: 'Ctrl+Shift+E',
    action: () => spawnInActiveProject('shell', 'horizontal'),
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
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) fileFinder.toggle(workspace.projectPath);
    },
  });

  commandPalette.register({
    id: 'git-changes',
    label: 'Git: Show Changes',
    shortcut: 'Ctrl+Shift+G',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) fileViewer.showChanges(workspace.projectPath);
    },
  });

  commandPalette.register({
    id: 'file-viewer',
    label: 'Open File Viewer',
    shortcut: 'Ctrl+Shift+E',
    action: () => {
      const workspace = workspaceSwitcher.getActiveWorkspace();
      if (workspace) {
        fileViewer.toggle(workspace.projectPath);
      }
    },
  });

  // Voice input
  // Voice command router — detects "vibeide <command>" vs terminal text
  const voiceRouter = new VoiceRouter((text) => {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    const leafId = workspace.layoutManager.getFocusedLeafId();
    if (!leafId) return;
    const leafEl = document.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
    const sessionId = leafEl?.dataset.sessionId ?? null;
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
  voiceRouter.registerCommand({ id: 'close-pane', aliases: ['close pane', 'close terminal', 'close this', 'close tab'], action: () => closeFocused() });
  voiceRouter.registerCommand({ id: 'toggle-sidebar', aliases: ['toggle sidebar', 'hide sidebar', 'show sidebar', 'sidebar'], action: () => projectSidebar.toggleCollapse() });
  voiceRouter.registerCommand({ id: 'command-palette', aliases: ['command palette', 'commands', 'open commands', 'show commands'], action: () => commandPalette.toggle() });
  voiceRouter.registerCommand({ id: 'file-finder', aliases: ['open file', 'quick open', 'find file', 'go to file'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) fileFinder.toggle(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'git-changes', aliases: ['show changes', 'git status', 'git diff', 'show diff', 'view changes'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) fileViewer.showChanges(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'file-viewer', aliases: ['open files', 'file viewer', 'show files', 'browse files', 'file browser'], action: () => { const ws = workspaceSwitcher.getActiveWorkspace(); if (ws) fileViewer.toggle(ws.projectPath); } });
  voiceRouter.registerCommand({ id: 'search', aliases: ['search', 'find', 'search terminal', 'find in terminal'], action: () => toggleSearchOnFocused() });
  voiceRouter.registerCommand({ id: 'zoom-in', aliases: ['zoom in', 'make bigger', 'increase size'], action: () => window.api.window.zoomIn() });
  voiceRouter.registerCommand({ id: 'zoom-out', aliases: ['zoom out', 'make smaller', 'decrease size'], action: () => window.api.window.zoomOut() });
  voiceRouter.registerCommand({ id: 'zoom-reset', aliases: ['reset zoom', 'normal size', 'default size'], action: () => window.api.window.zoomReset() });
  voiceRouter.registerCommand({ id: 'font-increase', aliases: ['bigger font', 'increase font', 'larger font', 'font bigger'], action: () => changeTerminalFontSize(1) });
  voiceRouter.registerCommand({ id: 'font-decrease', aliases: ['smaller font', 'decrease font', 'font smaller'], action: () => changeTerminalFontSize(-1) });

  // Theme commands
  const themeNames = ['tokyo night', 'tokyo night light', 'solarized dark', 'dracula', 'nord', 'gruvbox dark', 'one dark', 'catppuccin mocha', 'monokai'];
  const themeIds = ['tokyoNight', 'tokyoNightLight', 'solarizedDark', 'dracula', 'nord', 'gruvboxDark', 'oneDark', 'catppuccinMocha', 'monokai'];
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
      console.log(`[Voice] Transcript (${voiceMode}): "${text}"`);
      if (voiceMode === 'command') {
        const result = voiceRouter.routeCommand(text);
        if (result.matched) {
          console.log(`[Voice] Command matched: ${result.command}`);
        } else {
          console.log(`[Voice] No command match for: "${text}"`);
        }
      } else {
        voiceRouter.routeDictation(text);
      }
    },
    (_state) => {
      // State change callback — indicator handles UI
    },
  );

  // Load voice settings from disk
  voiceCapture.ensureSettingsLoaded();

  commandPalette.register({
    id: 'voice-toggle',
    label: 'Voice Dictation (hold to talk)',
    shortcut: 'Ctrl+Shift+M (hold)',
    action: () => voiceCapture.toggle(),
  });
  commandPalette.register({
    id: 'voice-setup',
    label: 'Voice Input: Configure',
    action: () => voiceCapture.showSetup(),
  });
  commandPalette.register({
    id: 'voice-mode-command',
    label: 'Voice Mode: Command (symbols + case conversion)',
    action: () => voiceCapture.setPostProcessMode('command'),
  });
  commandPalette.register({
    id: 'voice-mode-natural',
    label: 'Voice Mode: Natural (raw transcription)',
    action: () => voiceCapture.setPostProcessMode('natural'),
  });
  commandPalette.register({
    id: 'voice-mode-code',
    label: 'Voice Mode: Code (symbols + abbreviations)',
    action: () => voiceCapture.setPostProcessMode('code'),
  });

  // Layout preset commands
  for (const preset of LAYOUT_PRESETS) {
    commandPalette.register({
      id: `preset-${preset.id}`,
      label: `Layout: ${preset.label}`,
      shortcut: preset.shortcut,
      action: () => {
        applyPresetToActive(preset.id).catch((err) => {
          console.error('[Main] Preset failed:', err);
        });
      },
    });
  }

  commandPalette.register({
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    shortcut: 'Ctrl+B',
    action: () => projectSidebar.toggleCollapse(),
  });
  commandPalette.register({
    id: 'close-pane',
    label: 'Close Pane',
    shortcut: 'Ctrl+Shift+W',
    action: () => closeFocused(),
  });
  commandPalette.register({
    id: 'search-terminal',
    label: 'Search in Terminal',
    shortcut: 'Ctrl+Shift+F',
    action: () => toggleSearchOnFocused(),
  });
  const themeEntries: Array<{ id: string; label: string }> = [
    { id: 'tokyoNight', label: 'Tokyo Night' },
    { id: 'tokyoNightLight', label: 'Tokyo Night Light' },
    { id: 'solarizedDark', label: 'Solarized Dark' },
    { id: 'dracula', label: 'Dracula' },
    { id: 'nord', label: 'Nord' },
    { id: 'gruvboxDark', label: 'Gruvbox Dark' },
    { id: 'oneDark', label: 'One Dark' },
    { id: 'catppuccinMocha', label: 'Catppuccin Mocha' },
    { id: 'monokai', label: 'Monokai' },
  ];
  for (const theme of themeEntries) {
    commandPalette.register({
      id: `theme-${theme.id}`,
      label: `Theme: ${theme.label}`,
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
    id: 'terminal-font-increase',
    label: 'Terminal: Increase Font Size',
    shortcut: 'Ctrl++',
    action: () => changeTerminalFontSize(1),
  });
  commandPalette.register({
    id: 'terminal-font-decrease',
    label: 'Terminal: Decrease Font Size',
    shortcut: 'Ctrl+-',
    action: () => changeTerminalFontSize(-1),
  });
  commandPalette.register({
    id: 'ui-font-increase',
    label: 'UI: Increase Font Size',
    action: () => changeUIFontSize(1),
  });
  commandPalette.register({
    id: 'ui-font-decrease',
    label: 'UI: Decrease Font Size',
    action: () => changeUIFontSize(-1),
  });
  commandPalette.register({
    id: 'font-reset',
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
    'command-palette': { action: () => commandPalette.toggle() },
    'toggle-sidebar': { action: () => projectSidebar.toggleCollapse() },
    'git-changes': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileViewer.showChanges(ws.projectPath);
      },
    },
    'file-finder': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileFinder.toggle(ws.projectPath);
      },
    },
    'file-viewer': {
      action: () => {
        const ws = workspaceSwitcher.getActiveWorkspace();
        if (ws) fileViewer.toggle(ws.projectPath);
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

      console.log(`[Keybindings] Registering ${def.id} → "${key}" (hold=${!!def.holdMode})`);

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
  });

  // Keybinding editor
  const keybindingEditor = new KeybindingEditor(() => {
    registerAllKeybindings();
  });

  commandPalette.register({
    id: 'keybinding-editor',
    label: 'Keyboard Shortcuts',
    shortcut: 'Ctrl+K Ctrl+S',
    action: () => keybindingEditor.toggle(),
  });

  function getAllWorkspaces() {
    return workspaceSwitcher.getAllWorkspaces();
  }

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
      projectSidebar.updateAgents(workspace.projectId, agents);
    }
  }

  async function spawnInActiveProject(type: AgentType, direction?: 'horizontal' | 'vertical'): Promise<void> {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    await workspace.spawnAgent(type, direction);
    const agents = Array.from(workspace.getTrackedAgents().values()).map((t) => t.info);
    projectSidebar.updateAgents(workspace.projectId, agents);
  }

  function closeFocused(): void {
    const workspace = workspaceSwitcher.getActiveWorkspace();
    if (!workspace) return;
    const leafId = workspace.layoutManager.getFocusedLeafId();
    if (leafId) {
      workspace.layoutManager.closePane(leafId);
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
      projectSidebar.setProjects(projects);
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

  // Initialize
  initializeFromState(workspaceSwitcher, projectSidebar, refreshProjectList).then(() => {
    // Restore sidebar collapsed state after initialization
    window.api.state.load().then((state) => {
      if (state?.sidebarCollapsed) {
        projectSidebar.setCollapsed(true);
      }
    }).catch(() => {});
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
  projectSidebar: ProjectSidebar,
  refreshProjectList: () => Promise<void>,
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
          projectSidebar.updateAgents(activeProject.id, agents);
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
        projectSidebar.updateAgents(projects[0].id, agents);
      }
    }
  } catch (error) {
    console.error('[Main] Failed to initialize from state:', error);
  }
}

document.addEventListener('DOMContentLoaded', main);

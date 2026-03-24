import '@xterm/xterm/css/xterm.css';
import './styles/global.css';
import './styles/terminal.css';
import { TerminalManager } from './terminal/terminal-manager';
import { LayoutManager } from './layout/layout-manager';
import { AgentList } from './agent/agent-list';
import { AgentControls } from './agent/agent-controls';
import { CommandPalette } from './ui/command-palette';
import { KeybindingManager } from './ui/keybindings';
import { applyTheme, loadSavedTheme } from './terminal/terminal-theme';
import type { AgentType } from '../../shared/agent-types';
import type { AppState } from '../../shared/ipc-types';
import type { LayoutNode } from '../../shared/layout-types';

const AUTO_SAVE_INTERVAL_MS = 30_000;

function collectLeafSessionIds(node: LayoutNode): ReadonlyArray<string> {
  if (node.type === 'leaf') {
    return [node.sessionId];
  }
  return [
    ...collectLeafSessionIds(node.children[0]),
    ...collectLeafSessionIds(node.children[1]),
  ];
}

async function buildCurrentState(
  layoutManager: LayoutManager,
): Promise<Omit<AppState, 'window'>> {
  const layout = layoutManager.getLayoutTree();

  // Gather running agents from the main process
  let agents: AppState['agents'] = [];
  try {
    const agentInfos = await window.api.agent.list();
    agents = agentInfos.map((info) => ({
      type: info.config.type,
      cwd: info.config.cwd,
      ...(info.config.label ? { label: info.config.label } : {}),
    }));
  } catch (error) {
    console.error('[State] Failed to list agents for save:', error);
  }

  return { layout, agents };
}

async function saveRendererState(layoutManager: LayoutManager): Promise<void> {
  try {
    const partial = await buildCurrentState(layoutManager);

    // Load existing state to preserve window bounds (saved by main process)
    let existingState: AppState | null = null;
    try {
      existingState = await window.api.state.load();
    } catch {
      // Ignore load errors during save
    }

    const state: AppState = {
      window: existingState?.window ?? { x: 0, y: 0, width: 1400, height: 900, isMaximized: false },
      layout: partial.layout,
      agents: partial.agents,
    };

    await window.api.state.save(state);
  } catch (error) {
    console.error('[State] Failed to save state:', error);
  }
}

async function restoreFromState(
  agentControls: AgentControls,
  layoutManager: LayoutManager,
  savedState: AppState,
): Promise<boolean> {
  if (!savedState.layout || savedState.agents.length === 0) {
    return false;
  }

  try {
    // Spawn agents in order, collecting their session IDs
    const savedLeafSessionIds = collectLeafSessionIds(savedState.layout);
    const sessionIdMap = new Map<string, string>();

    for (let i = 0; i < savedState.agents.length; i++) {
      const agentDef = savedState.agents[i];
      const info = await window.api.agent.spawn({
        type: agentDef.type,
        cwd: agentDef.cwd,
        label: agentDef.label,
      });

      // Map old session ID to new session ID
      if (i < savedLeafSessionIds.length) {
        sessionIdMap.set(savedLeafSessionIds[i], info.sessionId);
      }
    }

    // Remap session IDs in the layout tree
    const remappedLayout = remapSessionIds(savedState.layout, sessionIdMap);
    layoutManager.restoreLayout(remappedLayout);

    // Update AgentControls to track the restored agents
    agentControls.markRestored();

    return true;
  } catch (error) {
    console.error('[State] Failed to restore state:', error);
    return false;
  }
}

function remapSessionIds(
  node: LayoutNode,
  sessionIdMap: ReadonlyMap<string, string>,
): LayoutNode {
  if (node.type === 'leaf') {
    const newSessionId = sessionIdMap.get(node.sessionId);
    if (newSessionId) {
      return { ...node, sessionId: newSessionId };
    }
    return node;
  }

  const newFirst = remapSessionIds(node.children[0], sessionIdMap);
  const newSecond = remapSessionIds(node.children[1], sessionIdMap);

  if (newFirst === node.children[0] && newSecond === node.children[1]) {
    return node;
  }

  return { ...node, children: [newFirst, newSecond] };
}

function main(): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('Missing #app element');
  }

  // Apply saved theme on startup
  applyTheme(loadSavedTheme());

  // Create sidebar
  const sidebarEl = document.createElement('div');
  sidebarEl.className = 'agent-sidebar';
  appEl.appendChild(sidebarEl);

  // Create terminal area
  const terminalArea = document.createElement('div');
  terminalArea.className = 'terminal-area';
  appEl.appendChild(terminalArea);

  // Initialize managers
  const terminalManager = new TerminalManager();

  const layoutManager = new LayoutManager(
    terminalArea,
    (sessionId, container) => terminalManager.createTerminal(sessionId, container),
    (sessionId) => terminalManager.removeTerminal(sessionId),
  );
  layoutManager.setFitAllCallback(() => terminalManager.fitAll());

  const agentList = new AgentList(sidebarEl, {
    onAgentSelect: (_agentId: string, sessionId: string) => {
      terminalManager.focusTerminal(sessionId);
    },
    onAgentSpawn: (type: AgentType) => {
      agentControls.spawnAgent(type);
    },
  });

  const agentControls = new AgentControls(terminalManager, layoutManager, agentList);
  agentControls.setupEventListeners();

  // Command palette
  const commandPalette = new CommandPalette();
  commandPalette.register({
    id: 'new-shell',
    label: 'New Shell',
    shortcut: 'Ctrl+Shift+N',
    action: () => agentControls.spawnAgent('shell'),
  });
  commandPalette.register({
    id: 'new-claude',
    label: 'New Claude Agent',
    shortcut: 'Ctrl+Shift+1',
    action: () => agentControls.spawnAgent('claude'),
  });
  commandPalette.register({
    id: 'new-gemini',
    label: 'New Gemini Agent',
    shortcut: 'Ctrl+Shift+2',
    action: () => agentControls.spawnAgent('gemini'),
  });
  commandPalette.register({
    id: 'new-codex',
    label: 'New Codex Agent',
    shortcut: 'Ctrl+Shift+3',
    action: () => agentControls.spawnAgent('codex'),
  });
  commandPalette.register({
    id: 'split-v',
    label: 'Split Vertical',
    shortcut: 'Ctrl+Shift+D',
    action: () => agentControls.spawnAgent('shell', 'vertical'),
  });
  commandPalette.register({
    id: 'split-h',
    label: 'Split Horizontal',
    shortcut: 'Ctrl+Shift+E',
    action: () => agentControls.spawnAgent('shell', 'horizontal'),
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
  commandPalette.register({
    id: 'theme-tokyo-night',
    label: 'Theme: Tokyo Night',
    action: () => switchTheme('tokyoNight'),
  });
  commandPalette.register({
    id: 'theme-tokyo-night-light',
    label: 'Theme: Tokyo Night Light',
    action: () => switchTheme('tokyoNightLight'),
  });
  commandPalette.register({
    id: 'theme-solarized-dark',
    label: 'Theme: Solarized Dark',
    action: () => switchTheme('solarizedDark'),
  });

  // Keybindings
  const keybindings = new KeybindingManager();
  keybindings.register('ctrl+shift+p', () => commandPalette.toggle());
  keybindings.register('ctrl+shift+n', () => agentControls.spawnAgent('shell'));
  keybindings.register('ctrl+shift+d', () => agentControls.spawnAgent('shell', 'vertical'));
  keybindings.register('ctrl+shift+e', () => agentControls.spawnAgent('shell', 'horizontal'));
  keybindings.register('ctrl+shift+w', () => closeFocused());
  keybindings.register('ctrl+shift+f', () => toggleSearchOnFocused());

  function closeFocused(): void {
    const leafId = layoutManager.getFocusedLeafId();
    if (leafId) {
      layoutManager.closePane(leafId);
    }
  }

  function toggleSearchOnFocused(): void {
    const leafId = layoutManager.getFocusedLeafId();
    if (!leafId) return;
    const leafEl = document.querySelector(`[data-leaf-id="${leafId}"]`) as HTMLElement | null;
    const sessionId = leafEl?.dataset.sessionId ?? null;
    if (sessionId) {
      terminalManager.toggleSearchOnFocused(sessionId);
    }
  }

  function switchTheme(name: string): void {
    applyTheme(name);
    terminalManager.setThemeAll(name);
  }

  // Attempt to restore saved state; fall back to spawning a default shell
  initializeFromState(agentControls, layoutManager);

  // Periodic auto-save
  const autoSaveTimer = setInterval(() => {
    saveRendererState(layoutManager);
  }, AUTO_SAVE_INTERVAL_MS);

  // Save state on window unload
  window.addEventListener('beforeunload', () => {
    clearInterval(autoSaveTimer);
    // Use synchronous-style save via sendBeacon is not available for IPC,
    // so fire-and-forget the async save
    saveRendererState(layoutManager);
  });
}

async function initializeFromState(
  agentControls: AgentControls,
  layoutManager: LayoutManager,
): Promise<void> {
  try {
    const savedState = await window.api.state.load();
    if (savedState) {
      const restored = await restoreFromState(agentControls, layoutManager, savedState);
      if (restored) {
        return;
      }
    }
  } catch (error) {
    console.error('[State] Failed to load saved state:', error);
  }

  // Fallback: spawn default shell
  agentControls.spawnAgent('shell').catch((error) => {
    console.error('Failed to spawn initial shell:', error);
  });
}

document.addEventListener('DOMContentLoaded', main);

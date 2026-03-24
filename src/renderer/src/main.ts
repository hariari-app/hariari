import '@xterm/xterm/css/xterm.css';
import './styles/global.css';
import './styles/terminal.css';
import { TerminalManager } from './terminal/terminal-manager';
import { LayoutManager } from './layout/layout-manager';
import { AgentList } from './agent/agent-list';
import { AgentControls } from './agent/agent-controls';
import { CommandPalette } from './ui/command-palette';
import { KeybindingManager } from './ui/keybindings';
import type { AgentType } from '../../shared/agent-types';

function main(): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('Missing #app element');
  }

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

  // Keybindings
  const keybindings = new KeybindingManager();
  keybindings.register('ctrl+shift+p', () => commandPalette.toggle());
  keybindings.register('ctrl+shift+n', () => agentControls.spawnAgent('shell'));
  keybindings.register('ctrl+shift+d', () => agentControls.spawnAgent('shell', 'vertical'));
  keybindings.register('ctrl+shift+e', () => agentControls.spawnAgent('shell', 'horizontal'));
  keybindings.register('ctrl+shift+w', () => closeFocused());

  function closeFocused(): void {
    const leafId = layoutManager.getFocusedLeafId();
    if (leafId) {
      layoutManager.closePane(leafId);
    }
  }

  // Spawn default shell on startup
  agentControls.spawnAgent('shell').catch((error) => {
    console.error('Failed to spawn initial shell:', error);
  });
}

document.addEventListener('DOMContentLoaded', main);

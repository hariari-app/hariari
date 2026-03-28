export interface KeybindingDefinition {
  readonly id: string;
  readonly label: string;
  readonly defaultKey: string;
  readonly holdMode?: boolean;
}

export const KEYBINDING_DEFAULTS: readonly KeybindingDefinition[] = [
  { id: 'command-palette', label: 'Command Palette', defaultKey: 'ctrl+shift+p' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', defaultKey: 'ctrl+b' },
  { id: 'file-finder', label: 'Quick Open File', defaultKey: 'ctrl+p' },
  { id: 'file-viewer', label: 'Open File Viewer', defaultKey: 'ctrl+shift+g' },
  { id: 'add-project', label: 'Add Project', defaultKey: 'ctrl+shift+o' },
  { id: 'new-shell', label: 'New Shell', defaultKey: 'ctrl+shift+n' },
  { id: 'split-vertical', label: 'Split Vertical', defaultKey: 'ctrl+shift+d' },
  { id: 'split-horizontal', label: 'Split Horizontal', defaultKey: 'ctrl+shift+e' },
  { id: 'close-pane', label: 'Close Pane', defaultKey: 'ctrl+shift+w' },
  { id: 'search-terminal', label: 'Search in Terminal', defaultKey: 'ctrl+shift+f' },
  { id: 'voice-push-to-talk', label: 'Voice Dictation (PTT)', defaultKey: 'ctrl+shift+m', holdMode: true },
  { id: 'voice-command', label: 'Voice Command (PTT)', defaultKey: 'f4', holdMode: true },
  { id: 'font-increase', label: 'Terminal Font: Increase', defaultKey: 'ctrl+=' },
  { id: 'font-decrease', label: 'Terminal Font: Decrease', defaultKey: 'ctrl+-' },
  { id: 'zoom-in', label: 'Zoom In (All)', defaultKey: 'ctrl+shift+arrowup' },
  { id: 'zoom-out', label: 'Zoom Out (All)', defaultKey: 'ctrl+shift+arrowdown' },
  { id: 'zoom-reset', label: 'Zoom Reset', defaultKey: 'ctrl+0' },
];

// In-memory cache — loaded async on startup, saved async on change
let cachedOverrides: Record<string, string> = {};
let loaded = false;

export function loadUserKeybindings(): Record<string, string> {
  return cachedOverrides;
}

export async function loadUserKeybindingsAsync(): Promise<Record<string, string>> {
  if (loaded) return cachedOverrides;

  // Retry up to 5 times with 200ms delay — handles race condition where
  // main process IPC handlers aren't registered yet on startup
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await window.api.keybindings.load();
      if (result && typeof result === 'object' && !('error' in result)) {
        cachedOverrides = result;
        loaded = true;
        return cachedOverrides;
      }
    } catch {
      // Handler not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  cachedOverrides = {};
  return cachedOverrides;
}

export function saveUserKeybindings(overrides: Record<string, string>): void {
  cachedOverrides = overrides;
  // Fire-and-forget async save to file
  window.api.keybindings.save(overrides).catch(() => {});
}

export function getEffectiveKey(id: string, overrides: Record<string, string>): string {
  if (overrides[id]) return overrides[id];
  const def = KEYBINDING_DEFAULTS.find((d) => d.id === id);
  return def?.defaultKey ?? '';
}

export function getDefinitionById(id: string): KeybindingDefinition | undefined {
  return KEYBINDING_DEFAULTS.find((d) => d.id === id);
}

export function formatKeyCombo(key: string): string {
  return key
    .split('+')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('+');
}

export class KeybindingManager {
  private readonly bindings = new Map<string, () => void>();
  private readonly keyupBindings = new Map<string, () => void>();
  private readonly heldKeys = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => this.handleKeydown(e), true);
    window.addEventListener('keyup', (e) => this.handleKeyup(e), true);
  }

  register(keys: string, action: () => void): void {
    this.bindings.set(keys.toLowerCase(), action);
  }

  clearAll(): void {
    this.bindings.clear();
    this.keyupBindings.clear();
    this.heldKeys.clear();
  }

  registerHold(keys: string, onDown: () => void, onUp: () => void): void {
    const normalized = keys.toLowerCase();
    this.bindings.set(normalized, onDown);
    this.keyupBindings.set(normalized, onUp);
  }

  private handleKeydown(e: KeyboardEvent): void {
    // Let clipboard shortcuts through to native inputs and terminals
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    const isClipboard = e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'v' || e.key === 'x' || e.key === 'a');
    const isTerminalClipboard = e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'V');

    if (isInput && isClipboard) return; // native copy/paste/cut/select-all in inputs
    if (isTerminalClipboard) return; // Ctrl+Shift+C/V handled by xterm.js

    const key = this.normalizeEvent(e);
    if (!key) return;

    const action = this.bindings.get(key);
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      // For hold bindings, only fire on initial press (not repeat)
      if (this.keyupBindings.has(key)) {
        if (!this.heldKeys.has(key)) {
          this.heldKeys.add(key);
          action();
        }
      } else {
        action();
      }
    }
  }

  private handleKeyup(e: KeyboardEvent): void {
    // Check all held keys — if any modifier was released, fire the keyup handler
    for (const heldKey of this.heldKeys) {
      const parts = heldKey.split('+');
      const needsCtrl = parts.includes('ctrl');
      const needsShift = parts.includes('shift');
      const needsAlt = parts.includes('alt');
      const needsMeta = parts.includes('meta');

      // Fire keyup if any required modifier was released
      const released =
        (needsCtrl && !e.ctrlKey && e.key === 'Control') ||
        (needsShift && !e.shiftKey && e.key === 'Shift') ||
        (needsAlt && !e.altKey && e.key === 'Alt') ||
        (needsMeta && !e.metaKey && e.key === 'Meta') ||
        (e.key.toLowerCase() === parts[parts.length - 1]);

      if (released) {
        this.heldKeys.delete(heldKey);
        const action = this.keyupBindings.get(heldKey);
        if (action) {
          e.preventDefault();
          action();
        }
      }
    }
  }

  private normalizeEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');

    let key = e.key.toLowerCase();
    if (key === ' ') key = 'space';
    if (key === 'control' || key === 'alt' || key === 'shift' || key === 'meta') {
      return '';
    }

    parts.push(key);
    return parts.join('+');
  }
}

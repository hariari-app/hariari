export class KeybindingManager {
  private readonly bindings = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => this.handleKeydown(e));
  }

  register(keys: string, action: () => void): void {
    this.bindings.set(keys.toLowerCase(), action);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const key = this.normalizeEvent(e);
    const action = this.bindings.get(key);
    if (action) {
      e.preventDefault();
      e.stopPropagation();
      action();
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

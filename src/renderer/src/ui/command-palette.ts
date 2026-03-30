export type CommandCategory = 'Agent' | 'Layout' | 'File' | 'Theme' | 'Git' | 'Voice' | 'View' | 'General';
export type CommandContext = 'any' | 'terminal' | 'agent';

export interface PaletteContext {
  readonly hasFocusedTerminal: boolean;
  readonly focusedAgentType: string | null;
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly category?: CommandCategory;
  readonly context?: CommandContext;
  readonly action: () => void;
}

interface ScoredCommand {
  readonly command: Command;
  readonly score: number;
  readonly matchIndices: readonly number[];
}

const RECENT_STORAGE_KEY = 'vibeide-recent-commands';
const MAX_RECENT = 5;

function fuzzyMatch(text: string, query: string): { score: number; indices: number[] } | null {
  const textLower = text.toLowerCase();
  const queryLower = query.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < textLower.length && queryIdx < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIdx]) {
      indices.push(i);
      if (i === prevMatchIdx + 1) score += 5;
      if (i === 0 || text[i - 1] === ' ' || text[i - 1] === ':' || text[i - 1] === '-') score += 3;
      if (text[i] === text[i].toUpperCase() && text[i] !== text[i].toLowerCase()) score += 2;
      score += 1;
      prevMatchIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx !== queryLower.length) return null;
  score += Math.max(0, 20 - text.length);
  return { score, indices };
}

function highlightMatches(text: string, indices: readonly number[]): HTMLElement {
  const span = document.createElement('span');
  span.className = 'command-label';

  const indexSet = new Set(indices);
  let current = '';
  let inHighlight = false;

  for (let i = 0; i < text.length; i++) {
    const isMatch = indexSet.has(i);
    if (isMatch !== inHighlight) {
      if (current) {
        const el = document.createElement('span');
        if (inHighlight) el.className = 'command-match-highlight';
        el.textContent = current;
        span.appendChild(el);
      }
      current = '';
      inHighlight = isMatch;
    }
    current += text[i];
  }

  if (current) {
    const el = document.createElement('span');
    if (inHighlight) el.className = 'command-match-highlight';
    el.textContent = current;
    span.appendChild(el);
  }

  return span;
}

export class CommandPalette {
  private readonly commands: Command[] = [];
  private readonly dynamicCommands = new Map<string, Command[]>();
  private visible = false;
  private selectedIndex = 0;
  private filterText = '';
  private overlayEl: HTMLElement | null = null;
  private recentIds: string[] = [];
  private context: PaletteContext = { hasFocusedTerminal: false, focusedAgentType: null };

  constructor() {
    this.loadRecent();
  }

  register(command: Command): void {
    this.commands.push(command);
  }

  updateLabel(id: string, label: string): void {
    const idx = this.commands.findIndex((c) => c.id === id);
    if (idx !== -1) {
      this.commands[idx] = { ...this.commands[idx], label };
    }
  }

  registerDynamic(prefix: string, commands: Command[]): void {
    this.dynamicCommands.set(prefix, commands);
  }

  unregisterDynamic(prefix: string): void {
    this.dynamicCommands.delete(prefix);
  }

  setContext(context: PaletteContext): void {
    this.context = context;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.filterText = '';
    this.selectedIndex = 0;
    this.renderOverlay();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }

  private trackRecent(id: string): void {
    this.recentIds = [id, ...this.recentIds.filter((r) => r !== id)].slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(this.recentIds)); } catch { /* */ }
  }

  private loadRecent(): void {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (raw) this.recentIds = JSON.parse(raw);
    } catch { /* */ }
  }

  private renderOverlay(): void {
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'command-palette-overlay';
    this.overlayEl.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) this.hide();
    });

    const palette = document.createElement('div');
    palette.className = 'command-palette';

    const input = document.createElement('input');
    input.className = 'command-palette-input';
    input.placeholder = 'Type a command...';
    input.addEventListener('input', () => {
      this.filterText = input.value;
      this.selectedIndex = 0;
      this.renderItems(itemsContainer);
    });
    input.addEventListener('keydown', (e) => this.handleKeydown(e));

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'command-palette-items';

    palette.appendChild(input);
    palette.appendChild(itemsContainer);
    this.overlayEl.appendChild(palette);
    document.body.appendChild(this.overlayEl);

    this.renderItems(itemsContainer);
    input.focus();
  }

  private renderItems(container: HTMLElement): void {
    container.replaceChildren();
    const results = this.getFilteredCommands();

    if (this.filterText && results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-empty';
      empty.textContent = 'No matching commands';
      container.appendChild(empty);
      return;
    }

    let globalIndex = 0;

    if (!this.filterText) {
      // No filter: show recently-used first, then grouped by category

      // Recent section
      const recentCommands = this.recentIds
        .map((id) => this.commands.find((c) => c.id === id))
        .filter(Boolean) as Command[];

      if (recentCommands.length > 0) {
        this.renderCategoryHeader(container, 'Recent');
        for (const cmd of recentCommands) {
          this.renderCommandItem(container, { command: cmd, score: 0, matchIndices: [] }, globalIndex);
          globalIndex++;
        }
      }

      // Group by category
      const categories: CommandCategory[] = ['Agent', 'Layout', 'File', 'Git', 'Voice', 'Theme', 'View', 'General'];
      const grouped = new Map<string, Command[]>();

      const visibleCommands = this.getAllCommands().filter((cmd) => this.isContextVisible(cmd));
      for (const cmd of visibleCommands) {
        // Skip commands already shown in recent
        if (recentCommands.some((r) => r.id === cmd.id)) continue;
        const cat = cmd.category ?? 'General';
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat)!.push(cmd);
      }

      for (const cat of categories) {
        const cmds = grouped.get(cat);
        if (!cmds || cmds.length === 0) continue;
        this.renderCategoryHeader(container, cat);
        for (const cmd of cmds) {
          this.renderCommandItem(container, { command: cmd, score: 0, matchIndices: [] }, globalIndex);
          globalIndex++;
        }
      }
    } else {
      // Filtered: group results by category with headers
      const categories: CommandCategory[] = ['Agent', 'Layout', 'File', 'Git', 'Voice', 'Theme', 'View', 'General'];
      const grouped = new Map<string, ScoredCommand[]>();

      for (const result of results) {
        const cat = result.command.category ?? 'General';
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat)!.push(result);
      }

      for (const cat of categories) {
        const cmds = grouped.get(cat);
        if (!cmds || cmds.length === 0) continue;
        this.renderCategoryHeader(container, cat);
        for (const cmd of cmds) {
          this.renderCommandItem(container, cmd, globalIndex);
          globalIndex++;
        }
      }
    }
  }

  private renderCategoryHeader(container: HTMLElement, category: string): void {
    const header = document.createElement('div');
    header.className = 'command-category-header';
    header.textContent = category;
    container.appendChild(header);
  }

  private renderCommandItem(container: HTMLElement, result: ScoredCommand, index: number): void {
    const item = document.createElement('div');
    item.className = `command-item${index === this.selectedIndex ? ' selected' : ''}`;
    item.setAttribute('tabindex', '-1');
    item.setAttribute('role', 'option');

    if (this.filterText && result.matchIndices.length > 0) {
      const label = highlightMatches(result.command.label, result.matchIndices);
      item.appendChild(label);
    } else {
      const label = document.createElement('span');
      label.className = 'command-label';
      label.textContent = result.command.label;
      item.appendChild(label);
    }

    if (result.command.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'command-shortcut';
      shortcut.textContent = result.command.shortcut;
      item.appendChild(shortcut);
    }

    item.addEventListener('click', () => {
      this.trackRecent(result.command.id);
      this.hide();
      result.command.action();
    });

    item.addEventListener('mouseenter', () => {
      this.selectedIndex = index;
      container.querySelectorAll('.command-item').forEach((el, i) => {
        el.classList.toggle('selected', i === index);
      });
    });

    container.appendChild(item);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const allItems = this.overlayEl?.querySelectorAll('.command-item') ?? [];
    const maxIndex = allItems.length - 1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, maxIndex);
        this.updateSelection();
        allItems[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.updateSelection();
        allItems[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
        break;
      case 'Enter':
        e.preventDefault();
        const selected = allItems[this.selectedIndex] as HTMLElement | undefined;
        if (selected) selected.click();
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  }

  private updateSelection(): void {
    if (!this.overlayEl) return;
    const items = this.overlayEl.querySelectorAll('.command-item');
    items.forEach((item, index) => {
      const isSelected = index === this.selectedIndex;
      item.classList.toggle('selected', isSelected);
      if (isSelected) (item as HTMLElement).focus();
    });
  }

  private getAllCommands(): readonly Command[] {
    const dynamic = Array.from(this.dynamicCommands.values()).flat();
    return [...this.commands, ...dynamic];
  }

  private isContextVisible(command: Command): boolean {
    const ctx = command.context ?? 'any';
    if (ctx === 'any') return true;
    if (ctx === 'terminal') return this.context.hasFocusedTerminal;
    if (ctx === 'agent') return !!this.context.focusedAgentType && this.context.focusedAgentType !== 'shell';
    return true;
  }

  private getFilteredCommands(): ScoredCommand[] {
    const all = this.getAllCommands().filter((cmd) => this.isContextVisible(cmd));

    if (!this.filterText) {
      return all.map((command) => ({
        command,
        score: 0,
        matchIndices: [],
      }));
    }

    const scored: ScoredCommand[] = [];
    for (const command of all) {
      const labelMatch = fuzzyMatch(command.label, this.filterText);
      const categoryMatch = command.category ? fuzzyMatch(command.category, this.filterText) : null;
      const bestScore = Math.max(labelMatch?.score ?? 0, categoryMatch?.score ?? 0);

      if (labelMatch || categoryMatch) {
        scored.push({
          command,
          score: bestScore,
          matchIndices: labelMatch?.indices ?? [],
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}

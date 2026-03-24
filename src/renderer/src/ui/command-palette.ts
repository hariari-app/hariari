interface Command {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly action: () => void;
}

export class CommandPalette {
  private readonly commands: Command[] = [];
  private visible = false;
  private selectedIndex = 0;
  private filterText = '';
  private overlayEl: HTMLElement | null = null;

  register(command: Command): void {
    this.commands.push(command);
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
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

  private renderOverlay(): void {
    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'command-palette-overlay';
    this.overlayEl.addEventListener('click', (e) => {
      if (e.target === this.overlayEl) {
        this.hide();
      }
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
    container.innerHTML = '';
    const filtered = this.getFilteredCommands();

    filtered.forEach((cmd, index) => {
      const item = document.createElement('div');
      item.className = `command-item${index === this.selectedIndex ? ' selected' : ''}`;

      const label = document.createElement('span');
      label.className = 'command-label';
      label.textContent = cmd.label;

      item.appendChild(label);

      if (cmd.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'command-shortcut';
        shortcut.textContent = cmd.shortcut;
        item.appendChild(shortcut);
      }

      item.addEventListener('click', () => {
        this.hide();
        cmd.action();
      });

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.renderItems(container);
      });

      container.appendChild(item);
    });
  }

  private handleKeydown(e: KeyboardEvent): void {
    const filtered = this.getFilteredCommands();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, filtered.length - 1);
        this.updateSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.updateSelection();
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[this.selectedIndex]) {
          this.hide();
          filtered[this.selectedIndex].action();
        }
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
      item.classList.toggle('selected', index === this.selectedIndex);
    });
  }

  private getFilteredCommands(): Command[] {
    if (!this.filterText) return this.commands;
    const lower = this.filterText.toLowerCase();
    return this.commands.filter((cmd) => cmd.label.toLowerCase().includes(lower));
  }
}

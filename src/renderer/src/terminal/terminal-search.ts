import type { TerminalPanel } from './terminal-panel';

export class TerminalSearch {
  private readonly panel: TerminalPanel;
  private barEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private matchCountEl: HTMLElement | null = null;
  private visible = false;

  constructor(panel: TerminalPanel) {
    this.panel = panel;
  }

  show(): void {
    if (this.visible) {
      this.inputEl?.focus();
      return;
    }
    this.visible = true;
    this.render();
    this.inputEl?.focus();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.barEl) {
      this.barEl.remove();
      this.barEl = null;
      this.inputEl = null;
      this.matchCountEl = null;
    }
    this.panel.clearSearch();
    this.panel.focus();
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  dispose(): void {
    this.hide();
  }

  private render(): void {
    const container = this.panel.getContainer();
    if (!container) return;

    this.barEl = document.createElement('div');
    this.barEl.className = 'terminal-search-bar';

    this.inputEl = document.createElement('input');
    this.inputEl.className = 'terminal-search-input';
    this.inputEl.type = 'text';
    this.inputEl.placeholder = 'Search...';
    this.inputEl.addEventListener('input', () => this.onSearchInput());
    this.inputEl.addEventListener('keydown', (e) => this.onKeydown(e));

    this.matchCountEl = document.createElement('span');
    this.matchCountEl.className = 'terminal-search-count';
    this.matchCountEl.textContent = '';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'terminal-search-btn';
    prevBtn.textContent = '\u2191';
    prevBtn.title = 'Previous match';
    prevBtn.addEventListener('click', () => this.findPrevious());

    const nextBtn = document.createElement('button');
    nextBtn.className = 'terminal-search-btn';
    nextBtn.textContent = '\u2193';
    nextBtn.title = 'Next match';
    nextBtn.addEventListener('click', () => this.findNext());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'terminal-search-btn terminal-search-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Close search';
    closeBtn.addEventListener('click', () => this.hide());

    this.barEl.appendChild(this.inputEl);
    this.barEl.appendChild(this.matchCountEl);
    this.barEl.appendChild(prevBtn);
    this.barEl.appendChild(nextBtn);
    this.barEl.appendChild(closeBtn);

    container.insertBefore(this.barEl, container.firstChild);
  }

  private onSearchInput(): void {
    const query = this.inputEl?.value ?? '';
    if (query.length > 0) {
      this.panel.searchNext(query);
    } else {
      this.panel.clearSearch();
    }
  }

  private findNext(): void {
    const query = this.inputEl?.value ?? '';
    if (query.length > 0) {
      this.panel.searchNext(query);
    }
  }

  private findPrevious(): void {
    const query = this.inputEl?.value ?? '';
    if (query.length > 0) {
      this.panel.searchPrevious(query);
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        this.findPrevious();
      } else {
        this.findNext();
      }
    }
  }
}

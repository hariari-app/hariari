import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { DEFAULT_SCROLLBACK } from '../../../shared/constants';
import { getTheme, loadSavedTheme } from './terminal-theme';
import { TerminalSearch } from './terminal-search';

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export class TerminalPanel {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly searchAddon: SearchAddon;
  private webglAddon: WebglAddon | null = null;
  private readonly _sessionId: string;
  private container: HTMLElement | null = null;
  private unsubscribeData: (() => void) | null = null;
  private connected = false;
  private terminalSearch: TerminalSearch | null = null;
  private readonly debouncedResize: (sessionId: string, cols: number, rows: number) => void;

  constructor(sessionId: string, fontSize: number = 14) {
    this._sessionId = sessionId;

    const savedTheme = loadSavedTheme();

    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Menlo, monospace",
      fontSize,
      scrollback: DEFAULT_SCROLLBACK,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: getTheme(savedTheme).terminal,
      rightClickSelectsWord: true,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();

    this.debouncedResize = debounce(
      (sessionId: string, cols: number, rows: number) => {
        window.api.pty.resize({ sessionId, cols, rows }).catch(() => {
          // Resize failed — session may have ended
        });
      },
      50,
    );
  }

  attach(element: HTMLElement): void {
    this.container = element;
    this.terminal.open(element);
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(() => {
        this.webglAddon?.dispose();
        this.webglAddon = null;
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      console.warn('WebGL addon failed to load, using default canvas renderer');
      this.webglAddon = null;
    }

    this.terminalSearch = new TerminalSearch(this);

    // Clipboard: copy selection on Ctrl+Shift+C, paste on Ctrl+Shift+V
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        const selection = this.terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false; // prevent xterm from handling
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            window.api.pty.write({ sessionId: this._sessionId, data: text });
          }
        });
        return false;
      }
      return true;
    });

    // Right-click: paste from clipboard
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) {
          window.api.pty.write({ sessionId: this._sessionId, data: text });
        }
      });
    });

    this.fit();
  }

  reattach(element: HTMLElement): void {
    this.container = element;
    // Move the terminal DOM into the new container
    const termEl = this.terminal.element;
    if (termEl) {
      element.appendChild(termEl);
    }
    requestAnimationFrame(() => this.fit());
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;

    this.terminal.onData((data) => {
      window.api.pty.write({ sessionId: this._sessionId, data }).catch(() => {
        // PTY write failed — session may have ended
      });
    });

    this.unsubscribeData = window.api.pty.onData((event) => {
      if (event.sessionId === this._sessionId) {
        this.terminal.write(event.data);
      }
    });
  }

  fit(): void {
    try {
      this.fitAddon.fit();
      this.debouncedResize(this._sessionId, this.terminal.cols, this.terminal.rows);
    } catch {
      // Terminal may not be visible yet
    }
  }

  focus(): void {
    this.terminal.focus();
  }

  search(query: string): void {
    this.searchAddon.findNext(query);
  }

  searchNext(query: string): void {
    this.searchAddon.findNext(query);
  }

  searchPrevious(query: string): void {
    this.searchAddon.findPrevious(query);
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations();
  }

  toggleSearch(): void {
    this.terminalSearch?.toggle();
  }

  setTheme(name: string): void {
    const theme = getTheme(name);
    this.terminal.options.theme = theme.terminal;
  }

  setFontSize(size: number): void {
    this.terminal.options.fontSize = size;
    this.fit();
  }

  getFontSize(): number {
    return this.terminal.options.fontSize ?? 14;
  }

  getContainer(): HTMLElement | null {
    return this.container;
  }

  getSessionId(): string {
    return this._sessionId;
  }

  dispose(): void {
    if (this.unsubscribeData) {
      this.unsubscribeData();
      this.unsubscribeData = null;
    }
    this.connected = false;
    this.terminalSearch?.dispose();
    this.terminalSearch = null;
    this.webglAddon?.dispose();
    this.fitAddon.dispose();
    this.searchAddon.dispose();
    this.terminal.dispose();
    this.container = null;
  }
}

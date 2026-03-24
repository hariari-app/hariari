import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { DEFAULT_SCROLLBACK } from '../../../shared/constants';
import { darkTheme } from './terminal-theme';

export class TerminalPanel {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly searchAddon: SearchAddon;
  private webglAddon: WebglAddon | null = null;
  private readonly _sessionId: string;
  private container: HTMLElement | null = null;
  private unsubscribeData: (() => void) | null = null;
  private connected = false;

  constructor(sessionId: string) {
    this._sessionId = sessionId;

    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Menlo, monospace",
      fontSize: 14,
      scrollback: DEFAULT_SCROLLBACK,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: darkTheme,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
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
      window.api.pty.resize({
        sessionId: this._sessionId,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
      }).catch(() => {
        // Resize failed — session may have ended
      });
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

  getSessionId(): string {
    return this._sessionId;
  }

  dispose(): void {
    if (this.unsubscribeData) {
      this.unsubscribeData();
      this.unsubscribeData = null;
    }
    this.connected = false;
    this.webglAddon?.dispose();
    this.fitAddon.dispose();
    this.searchAddon.dispose();
    this.terminal.dispose();
    this.container = null;
  }
}

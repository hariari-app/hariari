import { TerminalPanel } from './terminal-panel';

export class TerminalManager {
  private readonly panels = new Map<string, TerminalPanel>();

  createTerminal(sessionId: string, container: HTMLElement): TerminalPanel {
    // If terminal already exists for this session, re-attach it to the new container
    const existing = this.panels.get(sessionId);
    if (existing) {
      existing.reattach(container);
      return existing;
    }

    const panel = new TerminalPanel(sessionId);
    panel.attach(container);
    panel.connect();
    this.panels.set(sessionId, panel);
    return panel;
  }

  removeTerminal(sessionId: string): void {
    const panel = this.panels.get(sessionId);
    if (panel) {
      panel.dispose();
      this.panels.delete(sessionId);
    }
  }

  getTerminal(sessionId: string): TerminalPanel | undefined {
    return this.panels.get(sessionId);
  }

  focusTerminal(sessionId: string): void {
    const panel = this.panels.get(sessionId);
    if (panel) {
      panel.focus();
    }
  }

  fitAll(): void {
    for (const panel of this.panels.values()) {
      panel.fit();
    }
  }

  disposeAll(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

import type { AgentConfig } from '../../shared/agent-types';
import { DEFAULT_COLS, DEFAULT_ROWS } from '../../shared/constants';
import { PtySession } from './pty-session';

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();

  spawn(sessionId: string, config: AgentConfig): PtySession {
    if (this.sessions.has(sessionId)) {
      throw new Error(`PTY session already exists: ${sessionId}`);
    }

    const session = new PtySession(sessionId, config.command, config.args, {
      cwd: config.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: config.env ? { ...config.env } : undefined,
      agentType: config.type,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  write(sessionId: string, data: string): void {
    const session = this.getSessionOrThrow(sessionId);
    session.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getSessionOrThrow(sessionId);
    session.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private getSessionOrThrow(sessionId: string): PtySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`PTY session not found: ${sessionId}`);
    }
    return session;
  }
}

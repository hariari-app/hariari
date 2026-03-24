import * as pty from 'node-pty';
import { FRAME_COALESCE_MS } from '../../shared/constants';

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'COLORTERM', 'TERM_PROGRAM', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY',
]);

function buildSafeEnv(
  agentType: string,
  overrides?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' };

  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  // Agent-specific API keys — only passed to the agent that needs them
  if (agentType === 'claude' && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  if (agentType === 'gemini' && process.env.GEMINI_API_KEY) {
    env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  }
  if (agentType === 'codex' && process.env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  if (overrides) {
    Object.assign(env, overrides);
  }

  return env;
}

export class PtySession {
  private readonly process: pty.IPty;
  private readonly _sessionId: string;
  private dataBuffer: string = '';
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(exitCode: number) => void> = [];
  private disposed = false;

  constructor(
    sessionId: string,
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly env?: Readonly<Record<string, string>>;
      readonly agentType: string;
    },
  ) {
    this._sessionId = sessionId;

    this.process = pty.spawn(command, [...args], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: buildSafeEnv(options.agentType, options.env),
    });

    this.process.onData((data) => {
      this.dataBuffer += data;
    });

    this.flushInterval = setInterval(() => {
      if (this.dataBuffer.length > 0) {
        const data = this.dataBuffer;
        this.dataBuffer = '';
        for (const listener of this.dataListeners) {
          try {
            listener(data);
          } catch {
            // Never let a listener error crash the main process
          }
        }
      }
    }, FRAME_COALESCE_MS);

    this.process.onExit(({ exitCode }) => {
      for (const listener of this.exitListeners) {
        try {
          listener(exitCode);
        } catch {
          // Swallow listener errors
        }
      }
      this.dispose();
    });
  }

  getSessionId(): string {
    return this._sessionId;
  }

  getPid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    if (this.disposed) return;
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.process.resize(cols, rows);
  }

  kill(): void {
    if (this.disposed) return;
    this.process.kill();
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.push(callback);
    return () => {
      const index = this.dataListeners.indexOf(callback);
      if (index !== -1) {
        this.dataListeners.splice(index, 1);
      }
    };
  }

  onExit(callback: (exitCode: number) => void): () => void {
    this.exitListeners.push(callback);
    return () => {
      const index = this.exitListeners.indexOf(callback);
      if (index !== -1) {
        this.exitListeners.splice(index, 1);
      }
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.flushInterval !== null) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    if (this.dataBuffer.length > 0) {
      const data = this.dataBuffer;
      this.dataBuffer = '';
      for (const listener of this.dataListeners) {
        try {
          listener(data);
        } catch {
          // Swallow
        }
      }
    }

    this.dataListeners = [];
    this.exitListeners = [];

    try {
      this.process.kill();
    } catch {
      // Process may already be dead
    }
  }
}

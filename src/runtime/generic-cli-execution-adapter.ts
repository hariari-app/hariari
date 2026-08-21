import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskView } from '../shared/runtime/runtime-interface';

const TRACER_TEXT = 'hariari-runtime-tracer';

export class GenericCliExecutionError extends Error {
  constructor(readonly code: 'worktree-unavailable' | 'process-start-failed') {
    super(`Generic CLI execution failed: ${code}`);
    this.name = 'GenericCliExecutionError';
  }
}

export interface GenericCliExecutionAdapter {
  start(request: GenericCliStartRequest): Promise<GenericCliExecution>;
}

export interface GenericCliStartRequest {
  readonly task: TaskView;
  readonly run: { readonly id: string; readonly number: number };
  readonly attempt: { readonly id: string; readonly number: number };
  readonly identities: {
    readonly contextId: string;
    readonly worktreeId: string;
    readonly processId: string;
    readonly ptyId: string;
  };
  readonly onOutput: (data: string) => void;
  readonly onExit: (exitCode: number) => void;
}

export interface GenericCliExecution {
  readonly context: {
    readonly id: string;
    readonly worktreeId: string;
    readonly branchName: string;
    readonly baseCommit: string;
    readonly processId: string;
    readonly ptyId: string;
  };
  activateOutput(): void;
  stop(): Promise<void>;
  dispose(): void;
}

interface PtyDisposable {
  dispose(): void;
}

interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { readonly exitCode: number }) => void): PtyDisposable;
  kill(signal?: string): void;
}

interface PtyPort {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: Record<string, string>;
    },
  ): PtyProcess;
}

export interface LocalGenericCliExecutionAdapterOptions {
  readonly runtimeDirectory: string;
  readonly nodeModulesRoot?: string;
  readonly pty?: PtyPort;
}

/** Owns local Git allocation and one allowlisted shell-backed Generic CLI process. */
export class LocalGenericCliExecutionAdapter implements GenericCliExecutionAdapter {
  private pty: PtyPort | null;
  private readonly worktreeRoot: string;

  constructor(options: LocalGenericCliExecutionAdapterOptions) {
    this.worktreeRoot = path.join(options.runtimeDirectory, 'task-worktrees');
    this.pty = options.pty ?? null;
    this.nodeModulesRoot = options.nodeModulesRoot;
  }

  async start(request: GenericCliStartRequest): Promise<GenericCliExecution> {
    if (request.task.provider !== 'shell') throw new GenericCliExecutionError('process-start-failed');
    const repository = await resolveRepository(request.task.repository);
    const baseCommit = await git(repository, ['rev-parse', '--verify', `${request.task.baseRef}^{commit}`]);
    const branchName = branchFor(request);
    const worktreePath = path.join(this.worktreeRoot, request.identities.worktreeId);
    await prepareWorktreePath(this.worktreeRoot, worktreePath);
    await git(repository, ['worktree', 'add', '-b', branchName, worktreePath, baseCommit]);
    return this.startPty(request, worktreePath, branchName, baseCommit);
  }

  private startPty(
    request: GenericCliStartRequest,
    worktreePath: string,
    branchName: string,
    baseCommit: string,
  ): GenericCliExecution {
    try {
      const command = tracerCommand();
      const pty = this.getPty().spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: worktreePath,
        env: runtimeEnvironment(),
      });
      return bufferedPtyExecution(pty, request, branchName, baseCommit);
    } catch {
      throw new GenericCliExecutionError('process-start-failed');
    }
  }

  private readonly nodeModulesRoot: string | undefined;

  private getPty(): PtyPort {
    this.pty ??= loadNodePty(this.nodeModulesRoot);
    return this.pty;
  }
}

function bufferedPtyExecution(
  pty: PtyProcess,
  request: GenericCliStartRequest,
  branchName: string,
  baseCommit: string,
): GenericCliExecution {
  let active = false;
  let disposed = false;
  const output: string[] = [];
  let exitCode: number | null = null;
  const flush = (): void => {
    if (!active) return;
    for (const data of output.splice(0)) request.onOutput(data);
    if (exitCode !== null) request.onExit(exitCode);
  };
  const dataSubscription = pty.onData((data) => {
    output.push(data);
    flush();
  });
  const exitSubscription = pty.onExit((event) => {
    exitCode = event.exitCode;
    flush();
  });
  return {
    context: executionContext(request, branchName, baseCommit),
    activateOutput: () => {
      active = true;
      flush();
    },
    stop: async () => {
      if (exitCode === null) pty.kill();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dataSubscription.dispose();
      exitSubscription.dispose();
    },
  };
}

function executionContext(
  request: GenericCliStartRequest,
  branchName: string,
  baseCommit: string,
): GenericCliExecution['context'] {
  return {
    id: request.identities.contextId,
    worktreeId: request.identities.worktreeId,
    branchName,
    baseCommit,
    processId: request.identities.processId,
    ptyId: request.identities.ptyId,
  };
}

function loadNodePty(nodeModulesRoot: string | undefined): PtyPort {
  const root = nodeModulesRoot ?? process.cwd();
  try {
    const requireFromAssets = createRequire(
      path.join(root, 'node_modules', 'node-pty', 'package.json'),
    );
    return requireFromAssets('node-pty') as PtyPort;
  } catch {
    throw new GenericCliExecutionError('process-start-failed');
  }
}

async function resolveRepository(candidate: string): Promise<string> {
  try {
    const stats = await fs.promises.lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('not a directory');
    const root = await git(candidate, ['rev-parse', '--show-toplevel']);
    return await fs.promises.realpath(root);
  } catch {
    throw new GenericCliExecutionError('worktree-unavailable');
  }
}

async function prepareWorktreePath(root: string, worktreePath: string): Promise<void> {
  try {
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const rootStats = await fs.promises.lstat(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('unsafe root');
    await fs.promises.access(worktreePath);
    throw new Error('occupied worktree');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw new GenericCliExecutionError('worktree-unavailable');
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await new Promise<{ readonly stdout: string; readonly stderr: string }>(
      (resolve, reject) => {
        execFile('git', [...args], { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      },
    );
    if (result.stderr.trim().length > 0 && !result.stdout.trim()) throw new Error('git stderr');
    return result.stdout.trim();
  } catch {
    throw new GenericCliExecutionError('worktree-unavailable');
  }
}

function branchFor(request: GenericCliStartRequest): string {
  return `hariari/task-${request.task.id}/run-${request.run.number}/attempt-${request.attempt.number}`;
}

function tracerCommand(): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `echo ${TRACER_TEXT}`] };
  }
  return { file: '/bin/sh', args: ['-c', `printf '${TRACER_TEXT}\\n'`] };
}

function runtimeEnvironment(): Record<string, string> {
  const keys = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP']
    : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const environment: Record<string, string> = { TERM: 'xterm-256color' };
  for (const key of keys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

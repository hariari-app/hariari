import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { TaskView } from '../shared/runtime/runtime-interface';

const TRACER_TEXT = 'hariari-runtime-tracer';

export class GenericCliExecutionError extends Error {
  constructor(
    readonly code: 'worktree-unavailable' | 'process-start-failed',
    readonly context: ActiveExecution['context'] | null = null,
  ) {
    super(`Generic CLI execution failed: ${code}`);
    this.name = 'GenericCliExecutionError';
  }
}

export interface ExecutionAdapter {
  start(request: ExecutionStartRequest): Promise<ActiveExecution>;
}

export interface ExecutionStartRequest {
  readonly task: TaskView;
  readonly run: { readonly id: string; readonly number: number };
  readonly attempt: { readonly id: string; readonly number: number };
  readonly identities: {
    readonly contextId: string;
    readonly worktreeId: string;
    readonly processId: string;
    readonly ptyId: string;
  };
  readonly instruction: ProviderStartInstruction;
  readonly onOutput: (data: string) => void;
  readonly onExit: (exitCode: number) => void;
}

export type ProviderStartInstruction =
  | { readonly kind: 'new'; readonly nativeSessionId: string | null }
  | {
      readonly kind: 'resume-claude';
      readonly nativeSessionId: string;
      readonly context: ActiveExecution['context'];
    }
  | {
      readonly kind: 'fork-claude';
      readonly parentNativeSessionId: string;
      readonly context: ActiveExecution['context'];
    };

export interface ActiveExecution {
  readonly context: {
    readonly id: string;
    readonly worktreeId: string;
    readonly branchName: string;
    readonly baseCommit: string;
    readonly processId: string;
    readonly ptyId: string;
  };
  readonly providerSession: { readonly nativeSessionId: string; readonly capabilities: { readonly resume: boolean; readonly fork: boolean } } | null;
  isRunning(): boolean;
  activateOutput(): void;
  activateExit(): void;
  stop(): Promise<void>;
  dispose(): void;
}

interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { readonly exitCode: number }) => void): PtyDisposable;
  kill(signal?: string): void;
}

export interface PtyPort {
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
export class LocalGenericCliExecutionAdapter implements ExecutionAdapter {
  private pty: PtyPort | null;
  private readonly worktreeRoot: string;

  constructor(options: LocalGenericCliExecutionAdapterOptions) {
    this.worktreeRoot = path.join(options.runtimeDirectory, 'task-worktrees');
    this.pty = options.pty ?? null;
    this.nodeModulesRoot = options.nodeModulesRoot;
  }

  async start(request: GenericCliStartRequest): Promise<GenericCliExecution> {
    if (request.task.provider !== 'shell' || request.instruction.kind !== 'new') {
      throw new GenericCliExecutionError('process-start-failed');
    }
    const allocation = await allocateLocalExecutionContext(request, this.worktreeRoot);
    return this.startPty(request, allocation.worktreePath, allocation.context);
  }

  private startPty(
    request: GenericCliStartRequest,
    worktreePath: string,
    context: GenericCliExecution['context'],
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
      return bufferedPtyExecution(pty, request, context);
    } catch {
      throw new GenericCliExecutionError('process-start-failed', context);
    }
  }

  private readonly nodeModulesRoot: string | undefined;

  private getPty(): PtyPort {
    this.pty ??= loadNodePty(this.nodeModulesRoot);
    return this.pty;
  }
}

export type GenericCliExecutionAdapter = ExecutionAdapter;
export type GenericCliStartRequest = ExecutionStartRequest;
export type GenericCliExecution = ActiveExecution;

function bufferedPtyExecution(
  pty: PtyProcess,
  request: GenericCliStartRequest,
  context: GenericCliExecution['context'],
): GenericCliExecution {
  const lifecycle = new BufferedPtyLifecycle(pty, request);
  return {
    context,
    providerSession: null,
    isRunning: () => lifecycle.isRunning(),
    activateOutput: () => lifecycle.activateOutput(),
    activateExit: () => lifecycle.activateExit(),
    stop: () => lifecycle.stop(),
    dispose: () => lifecycle.dispose(),
  };
}

class BufferedPtyLifecycle {
  private outputActive = false;
  private exitActive = false;
  private disposed = false;
  private stopRequested = false;
  private exitDelivered = false;
  private readonly output: string[] = [];
  private exitCode: number | null = null;
  private resolveExit: () => void = () => undefined;
  private readonly exited = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  private readonly dataSubscription: PtyDisposable;
  private readonly exitSubscription: PtyDisposable;

  constructor(
    private readonly pty: PtyProcess,
    private readonly request: GenericCliStartRequest,
  ) {
    this.dataSubscription = pty.onData((data) => {
      this.output.push(data);
      this.flush();
    });
    this.exitSubscription = pty.onExit((event) => this.recordExit(event.exitCode));
  }

  activateOutput(): void {
    this.outputActive = true;
    this.activateExit();
  }

  isRunning(): boolean {
    return !this.disposed && this.exitCode === null;
  }

  activateExit(): void {
    this.exitActive = true;
    this.flush();
  }

  async stop(): Promise<void> {
    if (!this.stopRequested && this.exitCode === null) {
      this.stopRequested = true;
      this.pty.kill();
    }
    await this.exited;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataSubscription.dispose();
    this.exitSubscription.dispose();
  }

  private recordExit(exitCode: number): void {
    this.exitCode = exitCode;
    this.resolveExit();
    this.flush();
  }

  private flush(): void {
    if (this.outputActive) {
      for (const data of this.output.splice(0)) this.request.onOutput(data);
    }
    if (this.exitActive && this.exitCode !== null && !this.exitDelivered) {
      this.exitDelivered = true;
      this.request.onExit(this.exitCode);
    }
  }
}

export function executionContext(
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

export function loadNodePty(nodeModulesRoot: string | undefined): PtyPort {
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

export async function allocateLocalExecutionContext(
  request: GenericCliStartRequest,
  worktreeRoot: string,
): Promise<{ readonly context: GenericCliExecution['context']; readonly worktreePath: string }> {
  const repository = await resolveRepository(request.task.repository);
  const baseCommit = await git(repository, ['rev-parse', '--verify', `${request.task.baseRef}^{commit}`]);
  const branchName = branchFor(request);
  const worktreePath = path.join(worktreeRoot, request.identities.worktreeId);
  await prepareWorktreePath(worktreeRoot, worktreePath);
  await git(repository, ['worktree', 'add', '-b', branchName, worktreePath, baseCommit]);
  return { context: executionContext(request, branchName, baseCommit), worktreePath };
}

export async function existingLocalWorktreePath(
  worktreeRoot: string,
  worktreeId: string,
): Promise<string> {
  const worktreePath = path.join(worktreeRoot, worktreeId);
  try {
    const stats = await fs.promises.lstat(worktreePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('unsafe worktree');
    return worktreePath;
  } catch {
    throw new GenericCliExecutionError('worktree-unavailable');
  }
}

function tracerCommand(): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `echo ${TRACER_TEXT}`] };
  }
  return { file: '/bin/sh', args: ['-c', `printf '${TRACER_TEXT}\\n'`] };
}

export function runtimeEnvironment(): Record<string, string> {
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

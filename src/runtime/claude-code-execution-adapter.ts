import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  GenericCliExecutionError,
  allocateLocalExecutionContext,
  existingLocalWorktreePath,
  loadNodePty,
  runtimeEnvironment,
  executionStartRequest,
  type ActiveExecution,
  type ExecutionAdapter,
  type ExecutionLaunchPlan,
  type ExecutionObservation,
  type PrivateExecutionBinding,
  type ExecutionStartRequest,
  type PtyPort,
  type PtyProcess,
} from './generic-cli-execution-adapter';
import type { ProviderSessionCapabilities, TaskView } from '../shared/runtime/runtime-interface';

const STRUCTURED_MODE = ['--print', '--verbose', '--output-format', 'stream-json'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClaudeExecutablePort {
  run(args: readonly string[]): Promise<string>;
}

export interface ClaudeCodeExecutionAdapterOptions {
  readonly runtimeDirectory: string;
  readonly executablePath?: string;
  readonly nodeModulesRoot?: string;
  readonly executable?: ClaudeExecutablePort;
  readonly pty?: PtyPort;
}

interface ClaudeCapabilities {
  readonly sessionId: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
}

/** Concrete Claude Code translation: strict discovery, argv, PTY, and native identity. */
export class ClaudeCodeExecutionAdapter implements ExecutionAdapter {
  private readonly executablePath: string;
  private readonly worktreeRoot: string;
  private readonly executable: ClaudeExecutablePort;
  private pty: PtyPort | null;
  private capabilityProbe: Promise<ClaudeCapabilities> | null = null;
  private readonly executions = new Map<string, ActiveExecution>();

  constructor(private readonly options: ClaudeCodeExecutionAdapterOptions) {
    this.executablePath = options.executablePath ?? 'claude';
    this.worktreeRoot = path.join(options.runtimeDirectory, 'task-worktrees');
    this.executable = options.executable ?? new LocalClaudeExecutable(this.executablePath);
    this.pty = options.pty ?? null;
  }

  async capabilities(task: TaskView): Promise<ProviderSessionCapabilities> {
    if (task.provider !== 'claude') return { resume: false, fork: false };
    const capabilities = await this.discoverCapabilities();
    return { resume: capabilities.resume, fork: capabilities.fork };
  }

  async observe(binding: PrivateExecutionBinding): Promise<ExecutionObservation> {
    const active = this.executions.get(binding.context.id);
    if (!active) return 'unknown';
    return active.isRunning() ? 'live' : 'lost';
  }

  async launch(plan: ExecutionLaunchPlan): Promise<ActiveExecution> {
    const request = executionStartRequest(plan);
    if (request.task.provider !== 'claude') throw new GenericCliExecutionError('process-start-failed');
    this.releaseLostSource(plan);
    const capabilities = await this.discoverCapabilities();
    this.assertSupported(request, capabilities);
    const allocation = await this.allocate(request);
    const active = await this.spawn(request, allocation.context, allocation.worktreePath, capabilities);
    this.executions.set(active.context.id, active);
    return active;
  }

  private releaseLostSource(plan: ExecutionLaunchPlan): void {
    if (plan.kind !== 'native-resume') return;
    const source = this.executions.get(plan.source.context.id);
    if (source && !source.isRunning()) {
      source.dispose();
      this.executions.delete(plan.source.context.id);
    }
  }

  private discoverCapabilities(): Promise<ClaudeCapabilities> {
    this.capabilityProbe ??= probeCapabilities(this.executable);
    return this.capabilityProbe;
  }

  private assertSupported(request: ExecutionStartRequest, capabilities: ClaudeCapabilities): void {
    const instruction = request.instruction;
    const supported = capabilities.sessionId &&
      (instruction.kind === 'new' ||
        (instruction.kind === 'resume-claude' ? capabilities.resume : capabilities.fork));
    if (!supported) throw new GenericCliExecutionError('process-start-failed');
    if (instruction.kind === 'new' && !validUuid(instruction.nativeSessionId)) {
      throw new GenericCliExecutionError('process-start-failed');
    }
  }

  private async allocate(request: ExecutionStartRequest): Promise<{
    readonly context: ActiveExecution['context'];
    readonly worktreePath: string;
  }> {
    if (request.instruction.kind === 'new') {
      return allocateLocalExecutionContext(request, this.worktreeRoot);
    }
    const parent = request.instruction.context;
    const worktreePath = await existingLocalWorktreePath(this.worktreeRoot, parent.worktreeId);
    return { context: inheritedContext(request, parent), worktreePath };
  }

  private async spawn(
    request: ExecutionStartRequest,
    context: ActiveExecution['context'],
    worktreePath: string,
    capabilities: ClaudeCapabilities,
  ): Promise<ActiveExecution> {
    let lifecycle: ClaudePtyLifecycle | null = null;
    try {
      const pty = this.getPty().spawn(this.executablePath, claudeArgs(request), {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: worktreePath, env: runtimeEnvironment(),
      });
      lifecycle = new ClaudePtyLifecycle(pty, request);
      const nativeSessionId = await lifecycle.waitForNativeSessionId();
      validateNativeIdentity(request, nativeSessionId);
      return activeClaudeExecution(context, nativeSessionId, capabilities, lifecycle);
    } catch {
      await lifecycle?.abort();
      throw new GenericCliExecutionError('process-start-failed', context);
    }
  }

  private getPty(): PtyPort {
    this.pty ??= loadNodePty(this.options.nodeModulesRoot);
    return this.pty;
  }
}

class LocalClaudeExecutable implements ClaudeExecutablePort {
  constructor(private readonly executablePath: string) {}

  run(args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.executablePath, [...args], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }
}

async function probeCapabilities(executable: ClaudeExecutablePort): Promise<ClaudeCapabilities> {
  try {
    const version = await executable.run(['--version']);
    if (version.trim().length === 0) throw new Error('missing version');
    const help = await executable.run(['--help']);
    const resume = hasFlag(help, '--resume');
    return {
      sessionId: hasFlag(help, '--session-id'),
      resume,
      fork: resume && hasFlag(help, '--fork-session'),
    };
  } catch {
    throw new GenericCliExecutionError('process-start-failed');
  }
}

function hasFlag(help: string, flag: string): boolean {
  return help.split(/[\s,]+/).includes(flag);
}

function claudeArgs(request: ExecutionStartRequest): readonly string[] {
  const instruction = request.instruction;
  const identityArgs = instruction.kind === 'new'
    ? ['--session-id', instruction.nativeSessionId!]
    : instruction.kind === 'resume-claude'
      ? ['--resume', instruction.nativeSessionId]
      : ['--resume', instruction.parentNativeSessionId, '--fork-session'];
  return [...STRUCTURED_MODE, ...identityArgs, request.task.objective];
}

function inheritedContext(
  request: ExecutionStartRequest,
  parent: ActiveExecution['context'],
): ActiveExecution['context'] {
  return {
    id: request.identities.contextId,
    worktreeId: parent.worktreeId,
    branchName: parent.branchName,
    baseCommit: parent.baseCommit,
    processId: request.identities.processId,
    ptyId: request.identities.ptyId,
  };
}

function activeClaudeExecution(
  context: ActiveExecution['context'],
  nativeSessionId: string,
  capabilities: ClaudeCapabilities,
  lifecycle: ClaudePtyLifecycle,
): ActiveExecution {
  return {
    context,
    providerSession: { nativeSessionId, capabilities: { resume: capabilities.resume, fork: capabilities.fork } },
    isRunning: () => lifecycle.isRunning(),
    activateOutput: () => lifecycle.activateOutput(),
    activateExit: () => lifecycle.activateExit(),
    stop: () => lifecycle.stop(),
    dispose: () => lifecycle.dispose(),
  };
}

function validateNativeIdentity(request: ExecutionStartRequest, nativeSessionId: string): void {
  if (!validUuid(nativeSessionId)) throw new Error('invalid native identity');
  const instruction = request.instruction;
  if (instruction.kind === 'new' && nativeSessionId !== instruction.nativeSessionId) throw new Error('identity mismatch');
  if (instruction.kind === 'resume-claude' && nativeSessionId !== instruction.nativeSessionId) throw new Error('identity mismatch');
  if (instruction.kind === 'fork-claude' && nativeSessionId === instruction.parentNativeSessionId) throw new Error('identity mismatch');
}

function validUuid(value: string | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

class ClaudePtyLifecycle {
  private outputActive = false;
  private exitActive = false;
  private disposed = false;
  private stopRequested = false;
  private exitCode: number | null = null;
  private output: string[] = [];
  private pending = '';
  private resolveIdentity: (value: string) => void = () => undefined;
  private rejectIdentity: (error: Error) => void = () => undefined;
  private resolveExit: () => void = () => undefined;
  private readonly identity = new Promise<string>((resolve, reject) => {
    this.resolveIdentity = resolve;
    this.rejectIdentity = reject;
  });
  private readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  private readonly dataSubscription;
  private readonly exitSubscription;

  constructor(private readonly pty: PtyProcess, private readonly request: ExecutionStartRequest) {
    this.dataSubscription = pty.onData((data) => this.recordData(data));
    this.exitSubscription = pty.onExit((event) => this.recordExit(event.exitCode));
  }

  waitForNativeSessionId(): Promise<string> { return this.identity; }
  isRunning(): boolean { return !this.disposed && this.exitCode === null; }
  activateOutput(): void { this.outputActive = true; this.activateExit(); this.flush(); }
  activateExit(): void { this.exitActive = true; this.flush(); }

  async stop(): Promise<void> {
    if (!this.stopRequested && this.exitCode === null) {
      this.stopRequested = true;
      this.pty.kill();
    }
    await this.exited;
  }

  async abort(): Promise<void> {
    await this.stop().catch(() => undefined);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataSubscription.dispose();
    this.exitSubscription.dispose();
  }

  private recordData(data: string): void {
    this.output.push(data);
    this.pending += data;
    let newline = this.pending.indexOf('\n');
    while (newline >= 0) {
      this.readIdentity(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf('\n');
    }
    this.flush();
  }

  private readIdentity(line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === 'system' && value.subtype === 'init' && typeof value.session_id === 'string') {
        this.resolveIdentity(value.session_id);
      }
    } catch {
      // Only the documented structured init event carries native identity.
    }
  }

  private recordExit(exitCode: number): void {
    this.exitCode = exitCode;
    this.resolveExit();
    this.rejectIdentity(new Error('Claude exited before reporting identity'));
    this.flush();
  }

  private flush(): void {
    if (this.outputActive) for (const data of this.output.splice(0)) this.request.onOutput(data);
    if (this.exitActive && this.exitCode !== null) {
      this.exitActive = false;
      this.request.onExit(this.exitCode);
    }
  }
}

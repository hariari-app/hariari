import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { isCliAgentType, type CliAgentType } from '../../shared/agent-types';
import { AGENT_INSTALL_INFO } from '../../shared/agent-install-info';
import {
  buildAgentCommandEnv,
  getLookupCommand,
  isAllowedAgentCommand,
  resolveHomeDir,
} from './agent-cli-environment';

export function registerAgentInstallHandlers(): void {
  registerAgentCheckInstalledHandler();
  registerAgentInstallHandler();
}

function registerAgentCheckInstalledHandler(): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_CHECK_INSTALLED, (_event, raw: unknown) =>
    handleAgentCheckInstalled(raw),
  );
}

async function handleAgentCheckInstalled(
  raw: unknown,
): Promise<{ installed: boolean; version?: string }> {
  try {
    if (typeof raw !== 'string' || !isAllowedAgentCommand(raw)) {
      return { installed: false };
    }
    return await checkAgentInstalled(raw);
  } catch {
    return { installed: false };
  }
}

function registerAgentInstallHandler(): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_INSTALL, (event, raw: unknown) =>
    handleAgentInstall(event, raw),
  );
}

async function handleAgentInstall(
  event: IpcMainInvokeEvent,
  raw: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isCliAgentType(raw)) return { success: false, error: 'Invalid agent type' };
    const info = AGENT_INSTALL_INFO[raw];
    if (!info) return { success: false, error: 'No install info for agent' };
    return await runAgentInstall(event, raw, info.installCommand, info.displayName);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function checkAgentInstalled(
  command: string,
): Promise<{ installed: boolean; version?: string }> {
  const { execFile } = await import('node:child_process');
  const env = buildAgentCommandEnv();
  const installed = await runLookup(execFile, command, env);
  if (!installed) return { installed: false };
  const version = await readVersion(execFile, command, env);
  return version ? { installed: true, version } : { installed: true };
}

function runLookup(
  execFile: typeof import('node:child_process').execFile,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(getLookupCommand(), [command], { timeout: 5000, env }, (error, stdout) => {
      resolve(!error && Boolean(stdout.trim()));
    });
  });
}

function readVersion(
  execFile: typeof import('node:child_process').execFile,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 5000, env }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim().split('\n')[0] || undefined);
    });
  });
}

async function runAgentInstall(
  event: IpcMainInvokeEvent,
  agentType: CliAgentType,
  installCommand: string,
  displayName: string,
): Promise<{ success: boolean; error?: string }> {
  const { spawn } = await import('node:child_process');
  const window = BrowserWindow.fromWebContents(event.sender);
  const home = resolveHomeDir();
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['/c', installCommand] : ['-c', installCommand];
  const env = buildAgentCommandEnv();

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, { cwd: home, env, timeout: 120_000 });
    const sendOutput = createInstallOutputSender(window, agentType);
    const onWindowClosed = () => safeKill(child);

    if (window) window.once('closed', onWindowClosed);
    child.stdout?.on('data', (chunk: Buffer) => sendOutput(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => sendOutput(chunk.toString()));
    child.on('close', (code) =>
      resolveInstallClose(window, onWindowClosed, sendOutput, code, displayName, resolve),
    );
    child.on('error', (err) => resolveInstallError(sendOutput, err, resolve));
  });
}

function createInstallOutputSender(
  window: BrowserWindow | null,
  agentType: CliAgentType,
): (data: string) => void {
  return (data: string) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.AGENT_INSTALL_OUTPUT, { agentType, data });
    }
  };
}

function resolveInstallClose(
  window: BrowserWindow | null,
  onWindowClosed: () => void,
  sendOutput: (data: string) => void,
  code: number | null,
  displayName: string,
  resolve: (value: { success: boolean; error?: string }) => void,
): void {
  if (window && !window.isDestroyed()) window.removeListener('closed', onWindowClosed);
  if (code === 0) {
    sendOutput(`\n✓ ${displayName} installed successfully.\n`);
    resolve({ success: true });
    return;
  }
  sendOutput(`\n✗ Install failed (exit code ${code}).\n`);
  resolve({ success: false, error: `Exit code ${code}` });
}

function resolveInstallError(
  sendOutput: (data: string) => void,
  err: Error,
  resolve: (value: { success: boolean; error?: string }) => void,
): void {
  sendOutput(`\n✗ Error: ${err.message}\n`);
  resolve({ success: false, error: err.message });
}

function safeKill(child: import('node:child_process').ChildProcess): void {
  try {
    child.kill();
  } catch {
    // already exited
  }
}

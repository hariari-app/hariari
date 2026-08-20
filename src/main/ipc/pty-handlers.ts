import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentManager } from '../agent/agent-manager';
import type { PtyManager } from '../pty/pty-manager';
import { validateKillRequest, validateResizeRequest, validateWriteRequest } from './validators';

export function registerPtyHandlers(agentManager: AgentManager, ptyManager: PtyManager): void {
  registerPtyWriteHandler(agentManager, ptyManager);
  registerPtyResizeHandler(ptyManager);
  registerPtyKillHandler(ptyManager);
}

function registerPtyWriteHandler(agentManager: AgentManager, ptyManager: PtyManager): void {
  ipcMain.handle(IPC_CHANNELS.PTY_WRITE, (_event, raw: unknown) =>
    handlePtyWrite(agentManager, ptyManager, raw),
  );
}

function handlePtyWrite(agentManager: AgentManager, ptyManager: PtyManager, raw: unknown): unknown {
  try {
    const request = validateWriteRequest(raw);
    ptyManager.write(request.sessionId, request.data);
    agentManager.clearNeedsInputForSession(request.sessionId);
  } catch (error) {
    console.error('[IPC][pty:write]', error);
    return { error: 'pty_write_failed' };
  }
}

function registerPtyResizeHandler(ptyManager: PtyManager): void {
  ipcMain.handle(IPC_CHANNELS.PTY_RESIZE, (_event, raw: unknown) =>
    handlePtyResize(ptyManager, raw),
  );
}

function handlePtyResize(ptyManager: PtyManager, raw: unknown): unknown {
  try {
    const request = validateResizeRequest(raw);
    ptyManager.resize(request.sessionId, request.cols, request.rows);
  } catch (error) {
    console.error('[IPC][pty:resize]', error);
    return { error: 'pty_resize_failed' };
  }
}

function registerPtyKillHandler(ptyManager: PtyManager): void {
  ipcMain.handle(IPC_CHANNELS.PTY_KILL, (_event, raw: unknown) => handlePtyKill(ptyManager, raw));
}

function handlePtyKill(ptyManager: PtyManager, raw: unknown): unknown {
  try {
    const request = validateKillRequest(raw);
    ptyManager.kill(request.sessionId);
  } catch (error) {
    console.error('[IPC][pty:kill]', error);
    return { error: 'pty_kill_failed' };
  }
}

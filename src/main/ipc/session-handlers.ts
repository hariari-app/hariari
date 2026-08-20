import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentManager } from '../agent/agent-manager';
import { validateAgentId, validateOptionalAgentId } from './validators';

export function registerSessionHandlers(agentManager: AgentManager): void {
  registerSessionListHandler(agentManager);
  registerSessionGetHandler(agentManager);
}

function registerSessionListHandler(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, (_event, raw: unknown) =>
    handleSessionList(agentManager, raw),
  );
}

async function handleSessionList(agentManager: AgentManager, raw: unknown): Promise<unknown> {
  try {
    const agentId = validateOptionalAgentId(raw);
    return await agentManager.getRecorder().getRecordings(agentId);
  } catch (error) {
    console.error('[IPC][session:list]', error);
    return { error: 'session_list_failed' };
  }
}

function registerSessionGetHandler(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_GET, (_event, raw: unknown) =>
    handleSessionGet(agentManager, raw),
  );
}

async function handleSessionGet(agentManager: AgentManager, raw: unknown): Promise<unknown> {
  try {
    const agentId = validateAgentId(raw);
    return await agentManager.getRecorder().getRecordings(agentId);
  } catch (error) {
    console.error('[IPC][session:get]', error);
    return { error: 'session_get_failed' };
  }
}

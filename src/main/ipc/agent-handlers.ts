import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentManager } from '../agent/agent-manager';
import { validateAgentId, validateAgentSpawnRequest } from './validators';

const MAX_AGENTS = 20;

export function registerAgentHandlers(agentManager: AgentManager): void {
  registerAgentSpawnHandler(agentManager);
  registerAgentKillHandler(agentManager);
  registerAgentListHandler(agentManager);
}

function registerAgentSpawnHandler(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, (_event, raw: unknown) =>
    handleAgentSpawn(agentManager, raw),
  );
}

async function handleAgentSpawn(agentManager: AgentManager, raw: unknown): Promise<unknown> {
  try {
    if (agentManager.listAgents().length >= MAX_AGENTS) {
      return { error: 'max_agents_reached' };
    }
    const request = validateAgentSpawnRequest(raw);
    return await agentManager.spawnAgent(request);
  } catch (error) {
    console.error('[IPC][agent:spawn]', error);
    return { error: 'agent_spawn_failed' };
  }
}

function registerAgentKillHandler(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_KILL, (_event, raw: unknown) =>
    handleAgentKill(agentManager, raw),
  );
}

async function handleAgentKill(agentManager: AgentManager, raw: unknown): Promise<unknown> {
  try {
    const agentId = validateAgentId(raw);
    await agentManager.killAgent(agentId);
  } catch (error) {
    console.error('[IPC][agent:kill]', error);
    return { error: 'agent_kill_failed' };
  }
}

function registerAgentListHandler(agentManager: AgentManager): void {
  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, () => handleAgentList(agentManager));
}

function handleAgentList(agentManager: AgentManager): unknown {
  try {
    return agentManager.listAgents();
  } catch (error) {
    console.error('[IPC][agent:list]', error);
    return { error: 'agent_list_failed' };
  }
}

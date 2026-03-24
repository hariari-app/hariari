import { ipcMain } from 'electron';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentType } from '../../shared/agent-types';
import type { AgentManager } from '../agent/agent-manager';
import type { PtyManager } from '../pty/pty-manager';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_AGENT_TYPES = new Set<AgentType>(['claude', 'gemini', 'codex', 'shell']);
const MAX_WRITE_BYTES = 65536;
const MAX_AGENTS = 20;

function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error('Invalid session ID');
  }
  return id;
}

function validateWriteRequest(raw: unknown): { sessionId: string; data: string } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid request');
  const req = raw as Record<string, unknown>;
  const sessionId = validateSessionId(req.sessionId);
  if (typeof req.data !== 'string') throw new Error('Invalid data');
  if (req.data.length > MAX_WRITE_BYTES) throw new Error('Data exceeds maximum size');
  return { sessionId, data: req.data };
}

function validateResizeRequest(raw: unknown): { sessionId: string; cols: number; rows: number } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid request');
  const req = raw as Record<string, unknown>;
  const sessionId = validateSessionId(req.sessionId);
  if (typeof req.cols !== 'number' || typeof req.rows !== 'number') {
    throw new Error('Invalid dimensions');
  }
  if (req.cols < 1 || req.cols > 500 || req.rows < 1 || req.rows > 200) {
    throw new Error('Dimensions out of range');
  }
  const cols = Math.floor(req.cols);
  const rows = Math.floor(req.rows);
  return { sessionId, cols, rows };
}

function validateKillRequest(raw: unknown): { sessionId: string } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid request');
  const req = raw as Record<string, unknown>;
  return { sessionId: validateSessionId(req.sessionId) };
}

function validateAgentSpawnRequest(raw: unknown): { type: AgentType; cwd?: string; label?: string } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid request');
  const req = raw as Record<string, unknown>;
  if (!ALLOWED_AGENT_TYPES.has(req.type as AgentType)) {
    throw new Error('Invalid agent type');
  }
  const result: { type: AgentType; cwd?: string; label?: string } = {
    type: req.type as AgentType,
  };
  if (req.cwd !== undefined) {
    if (typeof req.cwd !== 'string') throw new Error('Invalid cwd');
    result.cwd = path.resolve(req.cwd);
  }
  if (req.label !== undefined) {
    if (typeof req.label !== 'string') throw new Error('Invalid label');
    result.label = req.label.slice(0, 100);
  }
  return result;
}

function validateAgentId(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    throw new Error('Invalid agent ID');
  }
  return raw;
}

export function registerIpcHandlers(
  agentManager: AgentManager,
  ptyManager: PtyManager,
): void {
  ipcMain.handle(IPC_CHANNELS.PTY_WRITE, (_event, raw: unknown) => {
    try {
      const request = validateWriteRequest(raw);
      ptyManager.write(request.sessionId, request.data);
    } catch (error) {
      console.error('[IPC][pty:write]', error);
      return { error: 'pty_write_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_RESIZE, (_event, raw: unknown) => {
    try {
      const request = validateResizeRequest(raw);
      ptyManager.resize(request.sessionId, request.cols, request.rows);
    } catch (error) {
      console.error('[IPC][pty:resize]', error);
      return { error: 'pty_resize_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_KILL, (_event, raw: unknown) => {
    try {
      const request = validateKillRequest(raw);
      ptyManager.kill(request.sessionId);
    } catch (error) {
      console.error('[IPC][pty:kill]', error);
      return { error: 'pty_kill_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, (_event, raw: unknown) => {
    try {
      if (agentManager.listAgents().length >= MAX_AGENTS) {
        return { error: 'max_agents_reached' };
      }
      const request = validateAgentSpawnRequest(raw);
      return agentManager.spawnAgent(request);
    } catch (error) {
      console.error('[IPC][agent:spawn]', error);
      return { error: 'agent_spawn_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_KILL, (_event, raw: unknown) => {
    try {
      const agentId = validateAgentId(raw);
      agentManager.killAgent(agentId);
    } catch (error) {
      console.error('[IPC][agent:kill]', error);
      return { error: 'agent_kill_failed' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, () => {
    try {
      return agentManager.listAgents();
    } catch (error) {
      console.error('[IPC][agent:list]', error);
      return { error: 'agent_list_failed' };
    }
  });
}

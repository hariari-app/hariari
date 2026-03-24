import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { AgentStatus } from '../shared/agent-types';

contextBridge.exposeInMainWorld('api', {
  pty: {
    spawn: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_SPAWN, request),
    write: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_WRITE, request),
    resize: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_RESIZE, request),
    kill: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PTY_KILL, request),
    onData: (callback: (event: { sessionId: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; data: string }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.PTY_DATA, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.PTY_DATA, handler);
      };
    },
  },
  agent: {
    spawn: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SPAWN, request),
    kill: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_KILL, agentId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST),
    onStatus: (callback: (event: { agentId: string; status: AgentStatus }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; status: AgentStatus }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_STATUS, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATUS, handler);
      };
    },
    onExit: (callback: (event: { agentId: string; exitCode: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; exitCode: number }) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.AGENT_EXIT, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.AGENT_EXIT, handler);
      };
    },
  },
});

import { randomUUID } from 'node:crypto';
import type { AgentInfo, AgentStatus } from '../../shared/agent-types';
import type { AgentSpawnRequest } from '../../shared/ipc-types';
import { IPC_CHANNELS } from '../../shared/constants';
import { PtyManager } from '../pty/pty-manager';
import { getDefaultAgentConfig } from './agent-config';
import { AgentRecorder } from './agent-recorder';

export class AgentManager {
  private readonly agents = new Map<string, AgentInfo>();
  private readonly ptyManager: PtyManager;
  private readonly sendToRenderer: (channel: string, ...args: unknown[]) => void;
  private readonly recorder: AgentRecorder;

  constructor(
    ptyManager: PtyManager,
    sendToRenderer: (channel: string, ...args: unknown[]) => void,
  ) {
    this.ptyManager = ptyManager;
    this.sendToRenderer = sendToRenderer;
    this.recorder = new AgentRecorder();
  }

  spawnAgent(request: AgentSpawnRequest): AgentInfo {
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const cwd = request.cwd || process.cwd();
    const config = getDefaultAgentConfig(request.type, cwd);
    const labelledConfig = request.label ? { ...config, label: request.label } : config;

    const session = this.ptyManager.spawn(sessionId, labelledConfig);

    this.recorder.startRecording(agentId, sessionId);

    session.onData((data) => {
      this.recorder.writeChunk(agentId, data);
      this.sendToRenderer(IPC_CHANNELS.PTY_DATA, { sessionId, data });
    });

    session.onExit((exitCode) => {
      this.updateAgentStatus(agentId, 'stopped');
      this.sendToRenderer(IPC_CHANNELS.AGENT_EXIT, { agentId, exitCode });
    });

    const agentInfo: AgentInfo = {
      id: agentId,
      config: labelledConfig,
      status: 'running',
      sessionId,
      startedAt: Date.now(),
      pid: session.getPid(),
    };

    this.agents.set(agentId, agentInfo);
    this.sendToRenderer(IPC_CHANNELS.AGENT_STATUS, {
      agentId,
      status: 'running' as AgentStatus,
    });

    return agentInfo;
  }

  killAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.recorder.stopRecording(agentId);
    this.ptyManager.kill(agent.sessionId);
    this.updateAgentStatus(agentId, 'stopped');
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  getRecorder(): AgentRecorder {
    return this.recorder;
  }

  disposeAll(): void {
    this.recorder.disposeAll();
    for (const agent of this.agents.values()) {
      try {
        this.ptyManager.kill(agent.sessionId);
      } catch {
        // Session may already be dead
      }
    }
    this.agents.clear();
  }

  private updateAgentStatus(agentId: string, status: AgentStatus): void {
    const existing = this.agents.get(agentId);
    if (!existing) return;

    const updated: AgentInfo = { ...existing, status };
    this.agents.set(agentId, updated);
    this.sendToRenderer(IPC_CHANNELS.AGENT_STATUS, { agentId, status });
  }
}

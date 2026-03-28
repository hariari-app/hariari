import { randomUUID } from 'node:crypto';
import type { AgentInfo, AgentStatus } from '../../shared/agent-types';
import type { AgentSpawnRequest } from '../../shared/ipc-types';
import { IPC_CHANNELS } from '../../shared/constants';
import { PtyManager } from '../pty/pty-manager';
import { getDefaultAgentConfig } from './agent-config';
import { AgentRecorder } from './agent-recorder';
import { OutputBuffer, detectNeedsInput } from './input-detector';

const INPUT_CHECK_INTERVAL_MS = 500;

export class AgentManager {
  private readonly agents = new Map<string, AgentInfo>();
  private readonly outputBuffers = new Map<string, OutputBuffer>();
  private readonly inputCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
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

    const outputBuffer = new OutputBuffer();
    this.outputBuffers.set(agentId, outputBuffer);

    session.onData((data) => {
      this.recorder.writeChunk(agentId, data);
      outputBuffer.append(data);
      this.sendToRenderer(IPC_CHANNELS.PTY_DATA, { sessionId, data });
    });

    // Track whether output is actively flowing
    let lastOutputTime = Date.now();
    const originalAppend = outputBuffer.append.bind(outputBuffer);
    outputBuffer.append = (data: string) => {
      lastOutputTime = Date.now();
      originalAppend(data);
    };

    // Periodically check agent state
    const inputCheckTimer = setInterval(() => {
      const agent = this.agents.get(agentId);
      if (!agent || agent.status === 'complete' || agent.status === 'error' || agent.status === 'stopped') {
        this.clearInputCheck(agentId);
        return;
      }

      const needsInput = detectNeedsInput(outputBuffer.getRecent());
      const timeSinceOutput = Date.now() - lastOutputTime;

      if (needsInput && agent.status !== 'needs-input') {
        this.updateAgentStatus(agentId, 'needs-input');
      } else if (!needsInput && agent.status === 'needs-input') {
        this.updateAgentStatus(agentId, 'running');
      } else if (!needsInput && agent.status === 'running' && timeSinceOutput > 3000) {
        // No output for 3 seconds and no input prompt — agent is idle (shell at prompt)
        this.updateAgentStatus(agentId, 'idle');
      } else if (agent.status === 'idle' && timeSinceOutput < 1000) {
        // Output resumed — back to running
        this.updateAgentStatus(agentId, 'running');
      }
    }, INPUT_CHECK_INTERVAL_MS);
    this.inputCheckTimers.set(agentId, inputCheckTimer);

    session.onExit((exitCode) => {
      this.clearInputCheck(agentId);
      this.outputBuffers.delete(agentId);
      // Exit code 0 = complete (blue), non-zero = error (red)
      const exitStatus = exitCode === 0 ? 'complete' : 'error';
      this.updateAgentStatus(agentId, exitStatus);
      this.sendToRenderer(IPC_CHANNELS.AGENT_EXIT, { agentId, exitCode });
    });

    const agentInfo: AgentInfo = {
      id: agentId,
      projectId: request.projectId,
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

    this.clearInputCheck(agentId);
    this.outputBuffers.delete(agentId);
    this.recorder.stopRecording(agentId);
    this.ptyManager.kill(agent.sessionId);
    this.updateAgentStatus(agentId, 'stopped');
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  listAgentsByProject(projectId: string): AgentInfo[] {
    return Array.from(this.agents.values()).filter((a) => a.projectId === projectId);
  }

  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  clearNeedsInputForSession(sessionId: string): void {
    for (const [agentId, agent] of this.agents) {
      if (agent.sessionId === sessionId && agent.status === 'needs-input') {
        const buffer = this.outputBuffers.get(agentId);
        if (buffer) buffer.clear();
        this.updateAgentStatus(agentId, 'running');
        return;
      }
    }
  }

  getRecorder(): AgentRecorder {
    return this.recorder;
  }

  disposeAll(): void {
    for (const agentId of this.inputCheckTimers.keys()) {
      this.clearInputCheck(agentId);
    }
    this.outputBuffers.clear();
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

  private clearInputCheck(agentId: string): void {
    const timer = this.inputCheckTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.inputCheckTimers.delete(agentId);
    }
  }

  private updateAgentStatus(agentId: string, status: AgentStatus): void {
    const existing = this.agents.get(agentId);
    if (!existing) return;

    const updated: AgentInfo = { ...existing, status };
    this.agents.set(agentId, updated);
    this.sendToRenderer(IPC_CHANNELS.AGENT_STATUS, { agentId, status });
  }
}

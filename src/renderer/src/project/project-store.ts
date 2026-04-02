import type { ProjectInfo } from '../../../shared/ipc-types';
import type { AgentInfo, AgentStatus } from '../../../shared/agent-types';

export interface ProjectStoreState {
  readonly projects: ReadonlyArray<ProjectInfo>;
  readonly activeProjectId: string | null;
  readonly agentsByProject: ReadonlyMap<string, ReadonlyArray<AgentInfo>>;
  readonly notificationsByProject: ReadonlyMap<string, number>;
  readonly inSinglePreview: boolean;
}

export type ProjectStoreListener = (state: ProjectStoreState, prev: ProjectStoreState) => void;

export function getNeedsInputCount(state: ProjectStoreState): number {
  let count = 0;
  for (const agents of state.agentsByProject.values()) {
    for (const agent of agents) {
      if (agent.status === 'needs-input') {
        count += 1;
      }
    }
  }
  return count;
}

const INITIAL_STATE: ProjectStoreState = {
  projects: [],
  activeProjectId: null,
  agentsByProject: new Map(),
  notificationsByProject: new Map(),
  inSinglePreview: false,
};

export class ProjectStore {
  private state: ProjectStoreState = INITIAL_STATE;
  private listeners: Set<ProjectStoreListener> = new Set();

  getState(): ProjectStoreState {
    return this.state;
  }

  subscribe(listener: ProjectStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setProjects(projects: ReadonlyArray<ProjectInfo>): void {
    this.setState({ ...this.state, projects });
  }

  setActiveProject(id: string | null): void {
    this.setState({ ...this.state, activeProjectId: id });
  }

  updateAgents(projectId: string, agents: ReadonlyArray<AgentInfo>): void {
    const next = new Map(this.state.agentsByProject);
    next.set(projectId, agents);
    this.setState({ ...this.state, agentsByProject: next });
  }

  updateAgentStatus(agentId: string, status: AgentStatus): void {
    // Find the project containing this agent and check if status actually changed
    for (const [projectId, agents] of this.state.agentsByProject) {
      const idx = agents.findIndex((a) => a.id === agentId);
      if (idx === -1) continue;
      if (agents[idx].status === status) return; // no change
      const updated = agents.map((agent) =>
        agent.id === agentId ? { ...agent, status } : agent,
      );
      const next = new Map(this.state.agentsByProject);
      next.set(projectId, updated);
      this.setState({ ...this.state, agentsByProject: next });
      return;
    }
  }

  incrementNotification(projectId: string, _agentId: string): void {
    const next = new Map(this.state.notificationsByProject);
    next.set(projectId, (next.get(projectId) ?? 0) + 1);
    this.setState({ ...this.state, notificationsByProject: next });
  }

  clearNotifications(projectId: string): void {
    if (!this.state.notificationsByProject.has(projectId)) {
      return;
    }
    const next = new Map(this.state.notificationsByProject);
    next.delete(projectId);
    this.setState({ ...this.state, notificationsByProject: next });
  }

  setInSinglePreview(active: boolean): void {
    this.setState({ ...this.state, inSinglePreview: active });
  }

  updateGitChanges(_projectId: string, _count: number, _files: string[]): void {
    // Git change tracking — state extension point.
    // Currently a no-op; will be wired when ProjectStoreState gains git fields.
  }

  private setState(next: ProjectStoreState): void {
    const prev = this.state;
    this.state = next;
    for (const listener of this.listeners) {
      listener(next, prev);
    }
  }
}

import path from 'node:path';
import { app } from 'electron';
import type { SessionRecording } from '../../shared/session-types';

export class AgentRecorder {
  private readonly basePath: string;

  constructor() {
    this.basePath = path.join(app.getPath('home'), '.hariari', 'sessions');
  }

  startRecording(agentId: string, sessionId: string): void {
    void agentId;
    void sessionId;
  }

  writeChunk(agentId: string, data: string): void {
    void agentId;
    void data;
  }

  stopRecording(agentId: string): void {
    void agentId;
  }

  async getRecordings(agentId?: string): Promise<SessionRecording[]> {
    if (agentId !== undefined) {
      const resolved = path.resolve(this.basePath, agentId);
      if (!resolved.startsWith(this.basePath + path.sep)) {
        throw new Error('Invalid agentId');
      }
    }

    return [];
  }

  disposeAll(): void {
    // Raw terminal output is no longer persisted to disk.
  }
}

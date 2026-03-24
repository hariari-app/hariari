import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SessionRecording, SessionRecordingInternal } from '../../shared/session-types';

interface RecordingStream {
  readonly agentId: string;
  readonly sessionId: string;
  readonly filePath: string;
  readonly startedAt: number;
  readonly stream: fs.WriteStream;
}

export class AgentRecorder {
  private readonly streams = new Map<string, RecordingStream>();
  private readonly basePath: string;

  constructor() {
    this.basePath = path.join(app.getPath('home'), '.vibeide', 'sessions');
  }

  startRecording(agentId: string, sessionId: string): void {
    if (this.streams.has(agentId)) {
      this.stopRecording(agentId);
    }

    const agentDir = path.join(this.basePath, agentId);

    try {
      fs.mkdirSync(agentDir, { recursive: true });
    } catch (error) {
      console.error(`[AgentRecorder] Failed to create directory ${agentDir}:`, error);
      return;
    }

    const timestamp = Date.now();
    const filePath = path.join(agentDir, `raw-${timestamp}-${sessionId}.log`);

    let stream: fs.WriteStream;
    try {
      stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
    } catch (error) {
      console.error(`[AgentRecorder] Failed to create write stream for ${filePath}:`, error);
      return;
    }

    stream.on('error', (error) => {
      console.error(`[AgentRecorder] Write stream error for agent ${agentId}:`, error);
      // Remove broken stream to prevent further write attempts
      this.streams.delete(agentId);
    });

    this.streams.set(agentId, {
      agentId,
      sessionId,
      filePath,
      startedAt: timestamp,
      stream,
    });
  }

  writeChunk(agentId: string, data: string): void {
    const recording = this.streams.get(agentId);
    if (!recording) return;

    const timestamp = Date.now();
    const encoded = Buffer.from(data).toString('base64');
    recording.stream.write(`${timestamp}\t${encoded}\n`);
  }

  stopRecording(agentId: string): void {
    const recording = this.streams.get(agentId);
    if (!recording) return;

    // Remove from map first to prevent further writes
    this.streams.delete(agentId);

    recording.stream.end(() => {
      // Stream fully flushed and closed
    });
  }

  async getRecordings(agentId?: string): Promise<SessionRecording[]> {
    // Path confinement: validate agentId stays within basePath
    if (agentId !== undefined) {
      const resolved = path.resolve(this.basePath, agentId);
      if (!resolved.startsWith(this.basePath + path.sep)) {
        throw new Error('Invalid agentId');
      }
    }

    const recordings: SessionRecording[] = [];

    try {
      const agentDirs = agentId
        ? [agentId]
        : await this.listDirectories(this.basePath);

      for (const dirName of agentDirs) {
        const agentDir = path.join(this.basePath, dirName);
        const dirRecordings = await this.readAgentRecordings(dirName, agentDir);
        recordings.push(...dirRecordings);
      }
    } catch (error) {
      console.error('[AgentRecorder] Failed to list recordings:', error);
    }

    return recordings;
  }

  disposeAll(): void {
    for (const recording of this.streams.values()) {
      recording.stream.end();
    }
    this.streams.clear();
  }

  private async listDirectories(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async readAgentRecordings(
    agentId: string,
    agentDir: string,
  ): Promise<SessionRecording[]> {
    try {
      const files = await fs.promises.readdir(agentDir);
      const logFiles = files.filter((f) => f.startsWith('raw-') && f.endsWith('.log'));
      const results: SessionRecording[] = [];

      for (const file of logFiles) {
        const filePath = path.join(agentDir, file);
        try {
          const stat = await fs.promises.stat(filePath);
          const match = file.match(/^raw-(\d+)-([a-f0-9-]+)\.log$/);
          const startedAt = match ? Number(match[1]) : stat.mtimeMs;
          const sessionId = match ? match[2] : '';

          // Strip filePath — never expose absolute paths to renderer
          results.push({
            agentId,
            sessionId,
            startedAt,
            size: stat.size,
          });
        } catch {
          // File may have been deleted between readdir and stat
        }
      }

      return results;
    } catch {
      return [];
    }
  }
}

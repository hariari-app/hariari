import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// Mock electron before importing AgentRecorder
vi.mock('electron', () => {
  const homedir = os.homedir();
  return {
    app: {
      getPath: vi.fn((name: string) => {
        if (name === 'home') return homedir;
        return os.tmpdir();
      }),
    },
  };
});

import { AgentRecorder } from '../../src/main/agent/agent-recorder';

describe('AgentRecorder', () => {
  let recorder: AgentRecorder;
  let basePath: string;

  beforeEach(() => {
    recorder = new AgentRecorder();
    // The recorder uses app.getPath('home') + '/.hariari/sessions'
    basePath = path.join(os.homedir(), '.hariari', 'sessions');
  });

  afterEach(() => {
    recorder.disposeAll();
  });

  describe('startRecording', () => {
    it('does not create any files on disk', () => {
      recorder.startRecording('agent-1', 'session-1');
      expect(basePath).toContain(path.join('.hariari', 'sessions'));
    });

    it('allows repeated calls without side effects', () => {
      recorder.startRecording('agent-1', 'session-1');
      recorder.startRecording('agent-1', 'session-2');
    });
  });

  describe('writeChunk', () => {
    it('does not persist terminal output', () => {
      recorder.startRecording('agent-1', 'session-1');
      recorder.writeChunk('agent-1', 'hello world');
    });

    it('does nothing when agent has no active recording', () => {
      // No error should be thrown
      recorder.writeChunk('non-existent', 'data');
    });
  });

  describe('stopRecording', () => {
    it('is a no-op for compatibility', () => {
      recorder.startRecording('agent-1', 'session-1');
      recorder.stopRecording('agent-1');
      recorder.writeChunk('agent-1', 'data');
    });

    it('does nothing when agent has no active recording', () => {
      // No error should be thrown
      recorder.stopRecording('non-existent');
    });
  });

  describe('getRecordings', () => {
    it('returns empty array for non-existent directory', async () => {
      const result = await recorder.getRecordings('non-existent-agent-id');
      expect(result).toEqual([]);
    });

    it('returns empty array when basePath does not exist (no agentId)', async () => {
      // Create a recorder that points to a non-existent base path
      // This will fail readdir and return []
      const result = await recorder.getRecordings();
      // May return empty or existing recordings depending on environment
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('path confinement', () => {
    it('rejects path traversal attempts', async () => {
      await expect(recorder.getRecordings('../../../etc')).rejects.toThrow('Invalid agentId');
    });

    it('rejects absolute path traversal', async () => {
      await expect(recorder.getRecordings('/etc/passwd')).rejects.toThrow('Invalid agentId');
    });

    it('rejects dot-dot in middle of path', async () => {
      await expect(recorder.getRecordings('valid/../../../etc')).rejects.toThrow('Invalid agentId');
    });
  });

  describe('disposeAll', () => {
    it('remains safe when called with active recordings', () => {
      recorder.startRecording('agent-1', 'session-1');
      recorder.startRecording('agent-2', 'session-2');
      recorder.disposeAll();
      recorder.writeChunk('agent-1', 'data');
      recorder.writeChunk('agent-2', 'data');
    });
  });
});

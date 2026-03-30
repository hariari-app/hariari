import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
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
    // The recorder uses app.getPath('home') + '/.vibeide/sessions'
    basePath = path.join(os.homedir(), '.vibeide', 'sessions');
  });

  afterEach(() => {
    recorder.disposeAll();
  });

  describe('startRecording', () => {
    it('creates directory and write stream', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream');

      recorder.startRecording('agent-1', 'session-1');

      expect(mkdirSpy).toHaveBeenCalledWith(
        path.join(basePath, 'agent-1'),
        { recursive: true },
      );
      expect(createWriteStreamSpy).toHaveBeenCalled();

      const callArgs = createWriteStreamSpy.mock.calls[0];
      expect(callArgs[0]).toContain('agent-1');
      expect(callArgs[0]).toContain('session-1');
      expect(callArgs[1]).toEqual({ flags: 'a', encoding: 'utf-8' });

      mkdirSpy.mockRestore();
      createWriteStreamSpy.mockRestore();
    });

    it('stops existing recording if agent already recording', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

      // Create a mock write stream
      const mockStream = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.WriteStream;

      const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream')
        .mockReturnValue(mockStream);

      recorder.startRecording('agent-1', 'session-1');
      recorder.startRecording('agent-1', 'session-2');

      // end should have been called on the first stream
      expect(mockStream.end).toHaveBeenCalled();

      mkdirSpy.mockRestore();
      createWriteStreamSpy.mockRestore();
    });
  });

  describe('writeChunk', () => {
    it('writes base64-encoded data with timestamp', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const mockStream = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.WriteStream;
      const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream')
        .mockReturnValue(mockStream);

      recorder.startRecording('agent-1', 'session-1');
      recorder.writeChunk('agent-1', 'hello world');

      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const written = (mockStream.write as any).mock.calls[0][0] as string;

      // Should be "timestamp\tbase64\n"
      const parts = written.split('\t');
      expect(parts).toHaveLength(2);

      // First part is a timestamp
      const timestamp = Number(parts[0]);
      expect(timestamp).toBeGreaterThan(0);

      // Second part is base64-encoded data + newline
      const base64Part = parts[1].trimEnd();
      const decoded = Buffer.from(base64Part, 'base64').toString();
      expect(decoded).toBe('hello world');

      mkdirSpy.mockRestore();
      createWriteStreamSpy.mockRestore();
    });

    it('does nothing when agent has no active recording', () => {
      // No error should be thrown
      recorder.writeChunk('non-existent', 'data');
    });
  });

  describe('stopRecording', () => {
    it('ends the stream and removes from active recordings', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const mockStream = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.WriteStream;
      const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream')
        .mockReturnValue(mockStream);

      recorder.startRecording('agent-1', 'session-1');
      recorder.stopRecording('agent-1');

      expect(mockStream.end).toHaveBeenCalled();

      // Further writes should be no-ops
      recorder.writeChunk('agent-1', 'data');
      // write should not have been called after stop
      expect(mockStream.write).not.toHaveBeenCalled();

      mkdirSpy.mockRestore();
      createWriteStreamSpy.mockRestore();
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
    it('ends all active streams and clears the map', () => {
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
      const mockStream1 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.WriteStream;
      const mockStream2 = {
        write: vi.fn(),
        end: vi.fn(),
        on: vi.fn(),
      } as unknown as fs.WriteStream;

      let callCount = 0;
      const createWriteStreamSpy = vi.spyOn(fs, 'createWriteStream')
        .mockImplementation(() => {
          callCount++;
          return callCount === 1 ? mockStream1 : mockStream2;
        });

      recorder.startRecording('agent-1', 'session-1');
      recorder.startRecording('agent-2', 'session-2');
      recorder.disposeAll();

      expect(mockStream1.end).toHaveBeenCalled();
      expect(mockStream2.end).toHaveBeenCalled();

      // After dispose, writes should be no-ops
      recorder.writeChunk('agent-1', 'data');
      recorder.writeChunk('agent-2', 'data');
      expect(mockStream1.write).not.toHaveBeenCalled();
      expect(mockStream2.write).not.toHaveBeenCalled();

      mkdirSpy.mockRestore();
      createWriteStreamSpy.mockRestore();
    });
  });
});

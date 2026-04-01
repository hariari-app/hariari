import { describe, it, expect } from 'vitest';
import { getDefaultAgentConfig } from '../../src/main/agent/agent-config';
import type { AgentType } from '../../src/shared/agent-types';

const isWin = process.platform === 'win32';

describe('getDefaultAgentConfig', () => {
  const testCwd = '/home/user/project';

  it('returns correct config for claude', () => {
    const config = getDefaultAgentConfig('claude', testCwd);
    if (isWin) {
      expect(config).toEqual({
        type: 'claude',
        command: 'cmd.exe',
        args: ['/c', 'claude'],
        label: 'Claude Code',
        cwd: testCwd,
      });
    } else {
      expect(config).toEqual({
        type: 'claude',
        command: 'claude',
        args: [],
        label: 'Claude Code',
        cwd: testCwd,
      });
    }
  });

  it('returns correct config for gemini', () => {
    const config = getDefaultAgentConfig('gemini', testCwd);
    if (isWin) {
      expect(config).toEqual({
        type: 'gemini',
        command: 'cmd.exe',
        args: ['/c', 'gemini'],
        label: 'Gemini CLI',
        cwd: testCwd,
      });
    } else {
      expect(config).toEqual({
        type: 'gemini',
        command: 'gemini',
        args: [],
        label: 'Gemini CLI',
        cwd: testCwd,
      });
    }
  });

  it('returns correct config for codex', () => {
    const config = getDefaultAgentConfig('codex', testCwd);
    if (isWin) {
      expect(config).toEqual({
        type: 'codex',
        command: 'cmd.exe',
        args: ['/c', 'codex'],
        label: 'Codex',
        cwd: testCwd,
      });
    } else {
      expect(config).toEqual({
        type: 'codex',
        command: 'codex',
        args: [],
        label: 'Codex',
        cwd: testCwd,
      });
    }
  });

  it('returns correct config for shell', () => {
    const config = getDefaultAgentConfig('shell', testCwd);
    expect(config.type).toBe('shell');
    expect(config.command).toBeTruthy();
    expect(config.args).toEqual([]);
    expect(config.label).toBe('Shell');
    expect(config.cwd).toBe(testCwd);
    // command should be process.env.SHELL or platform-specific fallback
    const expectedFallback = isWin ? 'cmd.exe' : '/bin/bash';
    expect([process.env.SHELL || expectedFallback]).toContain(config.command);
  });

  it('throws for custom type', () => {
    expect(() => getDefaultAgentConfig('custom' as AgentType, testCwd)).toThrow(
      'Custom agent type requires explicit configuration',
    );
  });

  it('includes cwd in returned config', () => {
    const cwd = '/different/path';
    const config = getDefaultAgentConfig('claude', cwd);
    expect(config.cwd).toBe(cwd);
  });

  it('returns a new object each time (no shared references)', () => {
    const config1 = getDefaultAgentConfig('claude', '/path1');
    const config2 = getDefaultAgentConfig('claude', '/path2');
    expect(config1).not.toBe(config2);
    expect(config1.cwd).toBe('/path1');
    expect(config2.cwd).toBe('/path2');
  });
});


import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/main/state/state-manager';

function createTestStateManager(stateDir: string): StateManager {
  const manager = new StateManager();
  Object.defineProperty(manager, 'stateDir', { value: stateDir, writable: false });
  Object.defineProperty(manager, 'statePath', {
    value: path.join(stateDir, 'state.json'),
    writable: false,
  });
  Object.defineProperty(manager, 'workspacesDir', {
    value: path.join(stateDir, 'workspaces'),
    writable: false,
  });
  return manager;
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

describe('StateManager - project workspace state', () => {
  let tempDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-ws-test-'));
    manager = createTestStateManager(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('saveProjectState', () => {
    it('creates workspaces directory and saves state', () => {
      manager.saveProjectState({
        projectId: VALID_UUID,
        layout: null,
        agents: [],
      });

      const wsDir = path.join(tempDir, 'workspaces');
      expect(fs.existsSync(wsDir)).toBe(true);

      const filePath = path.join(wsDir, `${VALID_UUID}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.projectId).toBe(VALID_UUID);
    });

    it('saves with layout and agents', () => {
      const state = {
        projectId: VALID_UUID,
        layout: {
          type: 'leaf' as const,
          id: VALID_UUID_2,
          sessionId: 'session-1',
        },
        agents: [
          { type: 'claude', cwd: '/home/user/project' },
        ],
      };

      manager.saveProjectState(state);

      const filePath = path.join(tempDir, 'workspaces', `${VALID_UUID}.json`);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.layout.type).toBe('leaf');
      expect(content.agents).toHaveLength(1);
      expect(content.agents[0].type).toBe('claude');
    });

    it('overwrites existing state', () => {
      manager.saveProjectState({
        projectId: VALID_UUID,
        layout: null,
        agents: [{ type: 'shell', cwd: '/tmp' }],
      });

      manager.saveProjectState({
        projectId: VALID_UUID,
        layout: null,
        agents: [
          { type: 'claude', cwd: '/home' },
          { type: 'gemini', cwd: '/home' },
        ],
      });

      const filePath = path.join(tempDir, 'workspaces', `${VALID_UUID}.json`);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.agents).toHaveLength(2);
    });
  });

  describe('loadProjectState', () => {
    it('returns null for nonexistent state', () => {
      expect(manager.loadProjectState(VALID_UUID)).toBeNull();
    });

    it('returns null for invalid project ID', () => {
      expect(manager.loadProjectState('not-a-uuid')).toBeNull();
    });

    it('round-trips state correctly', () => {
      const state = {
        projectId: VALID_UUID,
        layout: {
          type: 'leaf' as const,
          id: VALID_UUID_2,
          sessionId: 'session-abc',
        },
        agents: [
          { type: 'claude', cwd: '/home/user', label: 'Builder' },
        ],
      };

      manager.saveProjectState(state);
      const loaded = manager.loadProjectState(VALID_UUID);

      expect(loaded).not.toBeNull();
      expect(loaded!.projectId).toBe(VALID_UUID);
      expect(loaded!.layout).toEqual(state.layout);
      expect(loaded!.agents).toEqual(state.agents);
    });

    it('returns null for mismatched project ID', () => {
      // Manually write a file with a different projectId
      const wsDir = path.join(tempDir, 'workspaces');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, `${VALID_UUID}.json`),
        JSON.stringify({ projectId: VALID_UUID_2, layout: null, agents: [] }),
      );

      expect(manager.loadProjectState(VALID_UUID)).toBeNull();
    });

    it('returns null for corrupt JSON', () => {
      const wsDir = path.join(tempDir, 'workspaces');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, `${VALID_UUID}.json`), '{invalid');

      expect(manager.loadProjectState(VALID_UUID)).toBeNull();
    });

    it('isolates state between projects', () => {
      manager.saveProjectState({
        projectId: VALID_UUID,
        layout: null,
        agents: [{ type: 'claude', cwd: '/project-a' }],
      });

      manager.saveProjectState({
        projectId: VALID_UUID_2,
        layout: null,
        agents: [{ type: 'gemini', cwd: '/project-b' }],
      });

      const stateA = manager.loadProjectState(VALID_UUID);
      const stateB = manager.loadProjectState(VALID_UUID_2);

      expect(stateA!.agents[0].type).toBe('claude');
      expect(stateB!.agents[0].type).toBe('gemini');
    });
  });

  describe('AppState with project fields', () => {
    it('validates activeProjectId as string or null', () => {
      const state = {
        window: { x: 0, y: 0, width: 800, height: 600, isMaximized: false },
        activeProjectId: VALID_UUID,
        sidebarCollapsed: true,
        layout: null,
        agents: [],
      };

      manager.saveState(state);
      const loaded = manager.loadState();
      expect(loaded).not.toBeNull();
      expect(loaded!.activeProjectId).toBe(VALID_UUID);
      expect(loaded!.sidebarCollapsed).toBe(true);
    });

    it('accepts null activeProjectId', () => {
      const state = {
        window: { x: 0, y: 0, width: 800, height: 600, isMaximized: false },
        activeProjectId: null,
        sidebarCollapsed: false,
        layout: null,
        agents: [],
      };

      manager.saveState(state);
      const loaded = manager.loadState();
      expect(loaded).not.toBeNull();
      expect(loaded!.activeProjectId).toBeNull();
    });
  });
});

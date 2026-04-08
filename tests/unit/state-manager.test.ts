import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppState } from '../../src/shared/ipc-types';
import type { LayoutNode } from '../../src/shared/layout-types';
import { StateManager } from '../../src/main/state/state-manager';

// Helper: create a StateManager that uses a custom directory instead of ~/.hariari
function createTestStateManager(stateDir: string): StateManager {
  const manager = new StateManager();
  // Override private fields for testing with a temp directory
  Object.defineProperty(manager, 'stateDir', { value: stateDir, writable: false });
  Object.defineProperty(manager, 'statePath', {
    value: path.join(stateDir, 'state.json'),
    writable: false,
  });
  return manager;
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';
const VALID_UUID_3 = '770e8400-e29b-41d4-a716-446655440002';

function makeValidState(overrides?: Partial<AppState>): AppState {
  return {
    window: { x: 100, y: 100, width: 800, height: 600, isMaximized: false },
    activeProjectId: null,
    sidebarCollapsed: false,
    layout: null,
    agents: [],
    ...overrides,
  };
}

function makeLeaf(id: string = VALID_UUID, sessionId: string = 'sess-1'): LayoutNode {
  return { type: 'leaf', id, sessionId };
}

function makeSplit(
  children: [LayoutNode, LayoutNode],
  direction: 'horizontal' | 'vertical' = 'horizontal',
  ratio: number = 0.5,
): LayoutNode {
  return {
    type: 'split',
    id: VALID_UUID_3,
    direction,
    children,
    ratio,
  };
}

describe('StateManager', () => {
  let tmpDir: string;
  let manager: ReturnType<typeof createTestStateManager>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-test-'));
    manager = createTestStateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadState', () => {
    it('returns null when file does not exist', () => {
      const result = manager.loadState();
      expect(result).toBeNull();
    });

    it('returns null for corrupt JSON', () => {
      const statePath = path.join(tmpDir, 'state.json');
      fs.writeFileSync(statePath, '{not valid json!!!', 'utf-8');
      const result = manager.loadState();
      expect(result).toBeNull();
    });

    it('returns null for invalid structure (missing fields)', () => {
      const statePath = path.join(tmpDir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({ window: {} }), 'utf-8');
      const result = manager.loadState();
      expect(result).toBeNull();
    });

    it('returns null for invalid structure (wrong types)', () => {
      const statePath = path.join(tmpDir, 'state.json');
      const invalidState = {
        window: { x: 'not a number', y: 100, width: 800, height: 600, isMaximized: false },
        layout: null,
        agents: [],
      };
      fs.writeFileSync(statePath, JSON.stringify(invalidState), 'utf-8');
      const result = manager.loadState();
      expect(result).toBeNull();
    });

    it('returns valid AppState for correct data', () => {
      const statePath = path.join(tmpDir, 'state.json');
      const validState = makeValidState();
      fs.writeFileSync(statePath, JSON.stringify(validState), 'utf-8');
      const result = manager.loadState();
      expect(result).toEqual(validState);
    });

    it('returns valid AppState with layout and agents', () => {
      const statePath = path.join(tmpDir, 'state.json');
      const state = makeValidState({
        layout: makeLeaf(VALID_UUID, 'sess-abc'),
        agents: [{ type: 'claude', cwd: '/home/user' }],
      });
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');
      const result = manager.loadState();
      expect(result).toEqual(state);
    });
  });

  describe('saveState', () => {
    it('writes JSON atomically via tmp + rename', () => {
      const validState = makeValidState();
      manager.saveState(validState);

      const statePath = path.join(tmpDir, 'state.json');
      expect(fs.existsSync(statePath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      expect(saved).toEqual(validState);

      // tmp file should not remain
      expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
    });

    it('creates directory if needed', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const nestedManager = createTestStateManager(nestedDir);
      nestedManager.saveState(makeValidState());

      const statePath = path.join(nestedDir, 'state.json');
      expect(fs.existsSync(statePath)).toBe(true);
    });
  });

  describe('validateAndParse', () => {
    it('rejects null input', () => {
      expect(manager.validateAndParse(null)).toBeNull();
    });

    it('rejects undefined input', () => {
      expect(manager.validateAndParse(undefined)).toBeNull();
    });

    it('rejects non-object input', () => {
      expect(manager.validateAndParse('string')).toBeNull();
      expect(manager.validateAndParse(42)).toBeNull();
      expect(manager.validateAndParse(true)).toBeNull();
    });

    it('rejects missing window', () => {
      expect(manager.validateAndParse({ layout: null, agents: [] })).toBeNull();
    });

    it('rejects missing agents', () => {
      expect(
        manager.validateAndParse({
          window: { x: 0, y: 0, width: 800, height: 600, isMaximized: false },
          layout: null,
        }),
      ).toBeNull();
    });

    it('accepts valid minimal state', () => {
      const state = makeValidState();
      const result = manager.validateAndParse(state);
      expect(result).toEqual(state);
    });

    it('accepts valid state with layout and agents', () => {
      const state = makeValidState({
        layout: makeSplit([makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)]),
        agents: [
          { type: 'claude', cwd: '/home/user' },
          { type: 'shell', cwd: '/tmp', label: 'My Shell' },
        ],
      });
      const result = manager.validateAndParse(state);
      expect(result).toEqual(state);
    });
  });

  describe('window bounds validation', () => {
    it('rejects width too small', () => {
      const state = makeValidState();
      const invalid = { ...state, window: { ...state.window, width: 50 } };
      expect(manager.validateAndParse(invalid)).toBeNull();
    });

    it('rejects height too small', () => {
      const state = makeValidState();
      const invalid = { ...state, window: { ...state.window, height: 50 } };
      expect(manager.validateAndParse(invalid)).toBeNull();
    });

    it('rejects width too large', () => {
      const state = makeValidState();
      const invalid = { ...state, window: { ...state.window, width: 20000 } };
      expect(manager.validateAndParse(invalid)).toBeNull();
    });

    it('rejects height too large', () => {
      const state = makeValidState();
      const invalid = { ...state, window: { ...state.window, height: 20000 } };
      expect(manager.validateAndParse(invalid)).toBeNull();
    });

    it('accepts minimum valid bounds', () => {
      const state = makeValidState({
        window: { x: 0, y: 0, width: 100, height: 100, isMaximized: false },
      });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('accepts maximum valid bounds', () => {
      const state = makeValidState({
        window: { x: 0, y: 0, width: 10000, height: 10000, isMaximized: true },
      });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects non-boolean isMaximized', () => {
      const state = makeValidState();
      const invalid = { ...state, window: { ...state.window, isMaximized: 'true' } };
      expect(manager.validateAndParse(invalid)).toBeNull();
    });
  });

  describe('layout node validation', () => {
    it('accepts a leaf node with valid UUID', () => {
      const state = makeValidState({ layout: makeLeaf(VALID_UUID) });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects a leaf node with invalid ID', () => {
      const state = makeValidState({
        layout: { type: 'leaf', id: 'not-a-uuid', sessionId: 'sess' },
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('accepts a valid split node', () => {
      const state = makeValidState({
        layout: makeSplit([makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)]),
      });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects split with invalid direction', () => {
      const state = makeValidState({
        layout: {
          type: 'split',
          id: VALID_UUID_3,
          direction: 'diagonal' as 'horizontal',
          children: [makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)],
          ratio: 0.5,
        },
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('rejects split with ratio out of range', () => {
      const state = makeValidState({
        layout: makeSplit([makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)], 'horizontal', 1.5),
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('rejects split with negative ratio', () => {
      const state = makeValidState({
        layout: makeSplit([makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)], 'horizontal', -0.1),
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('accepts nested split nodes (depth > 2)', () => {
      const innerSplit = makeSplit([makeLeaf(VALID_UUID), makeLeaf(VALID_UUID_2)]);
      const outerSplit: LayoutNode = {
        type: 'split',
        id: '880e8400-e29b-41d4-a716-446655440003',
        direction: 'vertical',
        children: [innerSplit, makeLeaf('990e8400-e29b-41d4-a716-446655440004')],
        ratio: 0.6,
      };
      const state = makeValidState({ layout: outerSplit });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects split with only one child', () => {
      const state = makeValidState({
        layout: {
          type: 'split',
          id: VALID_UUID_3,
          direction: 'horizontal',
          children: [makeLeaf(VALID_UUID)] as unknown as readonly [LayoutNode, LayoutNode],
          ratio: 0.5,
        },
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });
  });

  describe('agent array validation', () => {
    it('accepts valid agent types', () => {
      const state = makeValidState({
        agents: [
          { type: 'claude', cwd: '/home/user' },
          { type: 'gemini', cwd: '/home/user' },
          { type: 'codex', cwd: '/home/user' },
          { type: 'shell', cwd: '/home/user' },
        ],
      });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects custom agent type', () => {
      const state = makeValidState({
        agents: [{ type: 'custom', cwd: '/home/user' }],
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('rejects invalid agent type', () => {
      const state = makeValidState({
        agents: [{ type: 'invalid' as 'claude', cwd: '/home/user' }],
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('rejects agent missing cwd', () => {
      const state = makeValidState({
        agents: [{ type: 'claude' } as unknown as { type: 'claude'; cwd: string }],
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });

    it('accepts agent with optional label', () => {
      const state = makeValidState({
        agents: [{ type: 'claude', cwd: '/home/user', label: 'My Agent' }],
      });
      expect(manager.validateAndParse(state)).toEqual(state);
    });

    it('rejects agent with non-string label', () => {
      const state = makeValidState({
        agents: [{ type: 'claude', cwd: '/home/user', label: 42 as unknown as string }],
      });
      expect(manager.validateAndParse(state)).toBeNull();
    });
  });
});

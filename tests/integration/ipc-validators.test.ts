import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateSessionId,
  validateWriteRequest,
  validateResizeRequest,
  validateAgentSpawnRequest,
  validateAgentId,
  validateOptionalAgentId,
  MAX_WRITE_BYTES,
} from '../../src/main/ipc/validators';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('validateSessionId', () => {
  it('accepts a valid UUID v4', () => {
    expect(validateSessionId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('accepts uppercase UUID', () => {
    const upper = VALID_UUID.toUpperCase();
    expect(validateSessionId(upper)).toBe(upper);
  });

  it('rejects empty string', () => {
    expect(() => validateSessionId('')).toThrow('Invalid session ID');
  });

  it('rejects non-string values', () => {
    expect(() => validateSessionId(42)).toThrow('Invalid session ID');
    expect(() => validateSessionId(null)).toThrow('Invalid session ID');
    expect(() => validateSessionId(undefined)).toThrow('Invalid session ID');
    expect(() => validateSessionId(true)).toThrow('Invalid session ID');
    expect(() => validateSessionId({})).toThrow('Invalid session ID');
  });

  it('rejects non-UUID string', () => {
    expect(() => validateSessionId('not-a-uuid')).toThrow('Invalid session ID');
    expect(() => validateSessionId('12345')).toThrow('Invalid session ID');
  });

  it('rejects SQL injection attempt', () => {
    expect(() => validateSessionId("'; DROP TABLE sessions; --")).toThrow('Invalid session ID');
  });

  it('rejects path traversal attempt', () => {
    expect(() => validateSessionId('../../etc/passwd')).toThrow('Invalid session ID');
  });
});

describe('validateWriteRequest', () => {
  it('accepts a valid request', () => {
    const result = validateWriteRequest({ sessionId: VALID_UUID, data: 'hello' });
    expect(result).toEqual({ sessionId: VALID_UUID, data: 'hello' });
  });

  it('rejects null', () => {
    expect(() => validateWriteRequest(null)).toThrow('Invalid request');
  });

  it('rejects non-object', () => {
    expect(() => validateWriteRequest('string')).toThrow('Invalid request');
    expect(() => validateWriteRequest(42)).toThrow('Invalid request');
  });

  it('rejects missing sessionId', () => {
    expect(() => validateWriteRequest({ data: 'hello' })).toThrow('Invalid session ID');
  });

  it('rejects missing data', () => {
    expect(() => validateWriteRequest({ sessionId: VALID_UUID })).toThrow('Invalid data');
  });

  it('rejects non-string data', () => {
    expect(() => validateWriteRequest({ sessionId: VALID_UUID, data: 123 })).toThrow('Invalid data');
    expect(() => validateWriteRequest({ sessionId: VALID_UUID, data: null })).toThrow('Invalid data');
  });

  it('rejects data exceeding MAX_WRITE_BYTES', () => {
    const oversized = 'x'.repeat(MAX_WRITE_BYTES + 1);
    expect(() => validateWriteRequest({ sessionId: VALID_UUID, data: oversized })).toThrow(
      'Data exceeds maximum size',
    );
  });

  it('accepts data exactly at MAX_WRITE_BYTES', () => {
    const exact = 'x'.repeat(MAX_WRITE_BYTES);
    const result = validateWriteRequest({ sessionId: VALID_UUID, data: exact });
    expect(result.data.length).toBe(MAX_WRITE_BYTES);
  });

  it('rejects invalid sessionId in write request', () => {
    expect(() => validateWriteRequest({ sessionId: 'bad', data: 'hello' })).toThrow(
      'Invalid session ID',
    );
  });
});

describe('validateResizeRequest', () => {
  it('accepts a valid request', () => {
    const result = validateResizeRequest({ sessionId: VALID_UUID, cols: 120, rows: 30 });
    expect(result).toEqual({ sessionId: VALID_UUID, cols: 120, rows: 30 });
  });

  it('rejects non-number cols', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: '120', rows: 30 }),
    ).toThrow('Invalid dimensions');
  });

  it('rejects non-number rows', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 120, rows: '30' }),
    ).toThrow('Invalid dimensions');
  });

  it('rejects cols below 1', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 0, rows: 30 }),
    ).toThrow('Dimensions out of range');
  });

  it('rejects rows below 1', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 120, rows: 0 }),
    ).toThrow('Dimensions out of range');
  });

  it('rejects negative cols', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: -1, rows: 30 }),
    ).toThrow('Dimensions out of range');
  });

  it('rejects negative rows', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 120, rows: -5 }),
    ).toThrow('Dimensions out of range');
  });

  it('rejects cols exceeding 500', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 501, rows: 30 }),
    ).toThrow('Dimensions out of range');
  });

  it('rejects rows exceeding 200', () => {
    expect(() =>
      validateResizeRequest({ sessionId: VALID_UUID, cols: 120, rows: 201 }),
    ).toThrow('Dimensions out of range');
  });

  it('floors fractional cols and rows', () => {
    const result = validateResizeRequest({ sessionId: VALID_UUID, cols: 120.9, rows: 30.7 });
    expect(result.cols).toBe(120);
    expect(result.rows).toBe(30);
  });

  it('accepts boundary values', () => {
    const minResult = validateResizeRequest({ sessionId: VALID_UUID, cols: 1, rows: 1 });
    expect(minResult).toEqual({ sessionId: VALID_UUID, cols: 1, rows: 1 });

    const maxResult = validateResizeRequest({ sessionId: VALID_UUID, cols: 500, rows: 200 });
    expect(maxResult).toEqual({ sessionId: VALID_UUID, cols: 500, rows: 200 });
  });

  it('rejects null', () => {
    expect(() => validateResizeRequest(null)).toThrow('Invalid request');
  });
});

describe('validateAgentSpawnRequest', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    process.env.HOME = '/tmp/vibeide-test-home';
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it('accepts valid agent type "claude"', () => {
    const result = validateAgentSpawnRequest({ type: 'claude', projectId: VALID_UUID });
    expect(result).toEqual({ type: 'claude', projectId: VALID_UUID });
  });

  it('accepts valid agent type "gemini"', () => {
    const result = validateAgentSpawnRequest({ type: 'gemini', projectId: VALID_UUID });
    expect(result).toEqual({ type: 'gemini', projectId: VALID_UUID });
  });

  it('accepts valid agent type "codex"', () => {
    const result = validateAgentSpawnRequest({ type: 'codex', projectId: VALID_UUID });
    expect(result).toEqual({ type: 'codex', projectId: VALID_UUID });
  });

  it('accepts valid agent type "shell"', () => {
    const result = validateAgentSpawnRequest({ type: 'shell', projectId: VALID_UUID });
    expect(result).toEqual({ type: 'shell', projectId: VALID_UUID });
  });

  it('rejects "custom" agent type', () => {
    expect(() => validateAgentSpawnRequest({ type: 'custom', projectId: VALID_UUID })).toThrow('Invalid agent type');
  });

  it('rejects unknown agent type', () => {
    expect(() => validateAgentSpawnRequest({ type: 'unknown', projectId: VALID_UUID })).toThrow('Invalid agent type');
  });

  it('rejects missing type', () => {
    expect(() => validateAgentSpawnRequest({ projectId: VALID_UUID })).toThrow('Invalid agent type');
  });

  it('rejects null', () => {
    expect(() => validateAgentSpawnRequest(null)).toThrow('Invalid request');
  });

  it('rejects missing projectId', () => {
    expect(() => validateAgentSpawnRequest({ type: 'claude' })).toThrow('Invalid projectId');
  });

  it('rejects invalid projectId', () => {
    expect(() => validateAgentSpawnRequest({ type: 'claude', projectId: 'not-a-uuid' })).toThrow('Invalid projectId');
  });

  it('accepts cwd within home directory', () => {
    const result = validateAgentSpawnRequest({
      type: 'claude',
      projectId: VALID_UUID,
      cwd: '/tmp/vibeide-test-home/projects',
    });
    // path.resolve may transform the path on Windows
    expect(result.cwd).toBeTruthy();
  });

  it('accepts cwd equal to home directory', () => {
    const result = validateAgentSpawnRequest({
      type: 'claude',
      projectId: VALID_UUID,
      cwd: '/tmp/vibeide-test-home',
    });
    expect(result.cwd).toBeTruthy();
  });

  it('accepts cwd outside home directory', () => {
    // Home directory restriction was removed to support projects anywhere on disk
    const result = validateAgentSpawnRequest({
      type: 'claude',
      projectId: VALID_UUID,
      cwd: '/etc/passwd',
    });
    expect(result.cwd).toBeTruthy();
  });

  it('resolves cwd with path traversal', () => {
    // Path traversal is resolved by path.resolve, but no longer rejected
    const result = validateAgentSpawnRequest({
      type: 'claude',
      projectId: VALID_UUID,
      cwd: '/tmp/vibeide-test-home/../../etc',
    });
    expect(result.cwd).toBeTruthy();
  });

  it('truncates label to 100 characters', () => {
    const longLabel = 'a'.repeat(150);
    const result = validateAgentSpawnRequest({ type: 'claude', projectId: VALID_UUID, label: longLabel });
    expect(result.label).toBe('a'.repeat(100));
  });

  it('accepts short label as-is', () => {
    const result = validateAgentSpawnRequest({ type: 'claude', projectId: VALID_UUID, label: 'my-agent' });
    expect(result.label).toBe('my-agent');
  });

  it('rejects non-string label', () => {
    expect(() =>
      validateAgentSpawnRequest({ type: 'claude', projectId: VALID_UUID, label: 42 }),
    ).toThrow('Invalid label');
  });

  it('rejects non-string cwd', () => {
    expect(() =>
      validateAgentSpawnRequest({ type: 'claude', projectId: VALID_UUID, cwd: 42 }),
    ).toThrow('Invalid cwd');
  });
});

describe('validateAgentId', () => {
  it('accepts a valid UUID', () => {
    expect(validateAgentId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('accepts another valid UUID', () => {
    expect(validateAgentId(VALID_UUID_2)).toBe(VALID_UUID_2);
  });

  it('rejects non-UUID string', () => {
    expect(() => validateAgentId('not-a-uuid')).toThrow('Invalid agent ID');
  });

  it('rejects empty string', () => {
    expect(() => validateAgentId('')).toThrow('Invalid agent ID');
  });

  it('rejects non-string values', () => {
    expect(() => validateAgentId(42)).toThrow('Invalid agent ID');
    expect(() => validateAgentId(null)).toThrow('Invalid agent ID');
    expect(() => validateAgentId(undefined)).toThrow('Invalid agent ID');
    expect(() => validateAgentId({})).toThrow('Invalid agent ID');
  });
});

describe('validateOptionalAgentId', () => {
  it('returns undefined for undefined', () => {
    expect(validateOptionalAgentId(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(validateOptionalAgentId(null)).toBeUndefined();
  });

  it('returns the UUID for a valid UUID', () => {
    expect(validateOptionalAgentId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('rejects invalid string', () => {
    expect(() => validateOptionalAgentId('bad-id')).toThrow('Invalid agent ID');
  });

  it('rejects non-string non-null values', () => {
    expect(() => validateOptionalAgentId(42)).toThrow('Invalid agent ID');
    expect(() => validateOptionalAgentId(true)).toThrow('Invalid agent ID');
    expect(() => validateOptionalAgentId({})).toThrow('Invalid agent ID');
  });
});

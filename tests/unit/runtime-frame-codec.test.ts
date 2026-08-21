import { describe, expect, it } from 'vitest';
import {
  MAX_RUNTIME_FRAME_BYTES,
  RuntimeFrameDecoder,
  RuntimeFrameError,
  encodeRuntimeFrame,
} from '../../src/runtime/frame-codec';

describe('Runtime frame codec', () => {
  it('decodes split prefixes, split payloads, and coalesced frames', () => {
    const first = encodeRuntimeFrame({ kind: 'one', value: 1 });
    const second = encodeRuntimeFrame({ kind: 'two', value: 2 });
    const combined = Buffer.concat([first, second]);
    const decoder = new RuntimeFrameDecoder();

    expect(decoder.push(combined.subarray(0, 2))).toEqual([]);
    expect(decoder.push(combined.subarray(2, first.length - 1))).toEqual([]);
    expect(decoder.push(combined.subarray(first.length - 1))).toEqual([
      { kind: 'one', value: 1 },
      { kind: 'two', value: 2 },
    ]);
  });

  it('rejects an oversized declaration before buffering its payload', () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_RUNTIME_FRAME_BYTES + 1);
    const decoder = new RuntimeFrameDecoder();

    expect(() => decoder.push(prefix)).toThrowError(RuntimeFrameError);
    expect(() => decoder.push(prefix)).toThrow('Runtime frame rejected: frame-too-large');
  });

  it('rejects invalid JSON and non-object roots with stable errors', () => {
    const invalidJson = Buffer.from('{');
    const invalidFrame = Buffer.alloc(4 + invalidJson.length);
    invalidFrame.writeUInt32BE(invalidJson.length);
    invalidJson.copy(invalidFrame, 4);

    expect(() => new RuntimeFrameDecoder().push(invalidFrame)).toThrow(
      'Runtime frame rejected: invalid-json',
    );
    expect(() => new RuntimeFrameDecoder().push(encodeRuntimeFrame(['not-an-object']))).toThrow(
      'Runtime frame rejected: invalid-root',
    );
  });

  it('bounds encoded payloads', () => {
    expect(() => encodeRuntimeFrame({ value: 'x'.repeat(MAX_RUNTIME_FRAME_BYTES) })).toThrow(
      'Runtime frame rejected: frame-too-large',
    );
  });
});

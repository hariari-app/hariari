export const MAX_RUNTIME_FRAME_BYTES = 64 * 1024;
const FRAME_PREFIX_BYTES = 4;

export type RuntimeFrameErrorCode = 'frame-too-large' | 'invalid-json' | 'invalid-root';

export class RuntimeFrameError extends Error {
  readonly code: RuntimeFrameErrorCode;

  constructor(code: RuntimeFrameErrorCode) {
    super(`Runtime frame rejected: ${code}`);
    this.name = 'RuntimeFrameError';
    this.code = code;
  }
}

export function encodeRuntimeFrame(value: unknown): Buffer {
  if (!isObject(value)) throw new RuntimeFrameError('invalid-root');
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_RUNTIME_FRAME_BYTES) {
    throw new RuntimeFrameError('frame-too-large');
  }
  const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, FRAME_PREFIX_BYTES);
  return frame;
}

export class RuntimeFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): readonly Record<string, unknown>[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const decoded: Record<string, unknown>[] = [];

    while (this.buffered.length >= FRAME_PREFIX_BYTES) {
      const payloadBytes = this.buffered.readUInt32BE(0);
      if (payloadBytes > MAX_RUNTIME_FRAME_BYTES) {
        this.buffered = Buffer.alloc(0);
        throw new RuntimeFrameError('frame-too-large');
      }
      const frameBytes = FRAME_PREFIX_BYTES + payloadBytes;
      if (this.buffered.length < frameBytes) break;
      const payload = this.buffered.subarray(FRAME_PREFIX_BYTES, frameBytes);
      this.buffered = this.buffered.subarray(frameBytes);
      decoded.push(parsePayload(payload));
    }

    if (this.buffered.length > MAX_RUNTIME_FRAME_BYTES + FRAME_PREFIX_BYTES) {
      this.buffered = Buffer.alloc(0);
      throw new RuntimeFrameError('frame-too-large');
    }
    return decoded;
  }
}

function parsePayload(payload: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new RuntimeFrameError('invalid-json');
  }
  if (!isObject(value)) throw new RuntimeFrameError('invalid-root');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

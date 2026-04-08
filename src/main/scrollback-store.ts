import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const SCROLLBACK_DIR = join(homedir(), '.hariari', 'scrollback');
const MAX_SIZE_BYTES = 500 * 1024;
const COMPRESS_THRESHOLD = 100 * 1024;
const SESSION_ID_RE = /^[a-f0-9-]+$/i;

async function ensureDir(): Promise<void> {
  await fs.mkdir(SCROLLBACK_DIR, { recursive: true });
}

function sanitizeId(sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

export async function saveScrollback(sessionId: string, data: string): Promise<void> {
  const id = sanitizeId(sessionId);
  if (!id) return;

  try {
    await ensureDir();
    let content = data.slice(0, MAX_SIZE_BYTES);
    const filePath = join(SCROLLBACK_DIR, `${id}.scrollback`);

    if (Buffer.byteLength(content) > COMPRESS_THRESHOLD) {
      const compressed = await gzipAsync(Buffer.from(content));
      await fs.writeFile(filePath + '.gz', compressed);
      // Remove uncompressed version if it exists
      await fs.unlink(filePath).catch(() => {});
    } else {
      await fs.writeFile(filePath, content, 'utf-8');
      await fs.unlink(filePath + '.gz').catch(() => {});
    }
  } catch {
    // Scrollback save is best-effort
  }
}

export async function loadScrollback(sessionId: string): Promise<string | null> {
  const id = sanitizeId(sessionId);
  if (!id) return null;

  try {
    const gzPath = join(SCROLLBACK_DIR, `${id}.scrollback.gz`);
    const plainPath = join(SCROLLBACK_DIR, `${id}.scrollback`);

    // Try compressed first
    try {
      const compressed = await fs.readFile(gzPath);
      const decompressed = await gunzipAsync(compressed);
      return decompressed.toString('utf-8');
    } catch {
      // Not compressed, try plain
    }

    return await fs.readFile(plainPath, 'utf-8');
  } catch {
    return null;
  }
}

export async function deleteScrollback(sessionId: string): Promise<void> {
  const id = sanitizeId(sessionId);
  if (!id) return;

  try {
    await fs.unlink(join(SCROLLBACK_DIR, `${id}.scrollback`)).catch(() => {});
    await fs.unlink(join(SCROLLBACK_DIR, `${id}.scrollback.gz`)).catch(() => {});
  } catch {
    // Best-effort cleanup
  }
}

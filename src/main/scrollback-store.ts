import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SCROLLBACK_DIR = join(homedir(), '.hariari', 'scrollback');
const SESSION_ID_RE = /^[a-f0-9-]+$/i;

function sanitizeId(sessionId: string): string | null {
  return SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

export async function saveScrollback(sessionId: string, data: string): Promise<void> {
  const id = sanitizeId(sessionId);
  if (!id) return;
  void data;
}

export async function loadScrollback(sessionId: string): Promise<string | null> {
  const id = sanitizeId(sessionId);
  if (!id) return null;
  return null;
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

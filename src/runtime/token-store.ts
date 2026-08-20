import { randomBytes as nodeRandomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_BYTES = 32;
const TOKEN_FILE_NAME = 'auth-token';

export class RuntimeTokenError extends Error {
  constructor() {
    super('Runtime credential is unavailable');
    this.name = 'RuntimeTokenError';
  }
}

export class ProtectedRuntimeTokenStore {
  private readonly tokenPath: string;

  constructor(
    private readonly runtimeDirectory: string,
    private readonly randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
  ) {
    this.tokenPath = path.join(runtimeDirectory, TOKEN_FILE_NAME);
  }

  async read(): Promise<Uint8Array | null> {
    try {
      await this.verifyDirectory(false);
      const stats = await fs.promises.lstat(this.tokenPath);
      this.verifyFileStats(stats);
      const encoded = await fs.promises.readFile(this.tokenPath, 'utf8');
      return decodeToken(encoded);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof RuntimeTokenError) throw error;
      throw new RuntimeTokenError();
    }
  }

  async ensure(): Promise<Uint8Array> {
    try {
      await this.verifyDirectory(true);
      const existing = await this.read();
      if (existing) return existing;

      const token = Uint8Array.from(this.randomBytes(TOKEN_BYTES));
      if (token.length !== TOKEN_BYTES) throw new RuntimeTokenError();
      const handle = await fs.promises.open(this.tokenPath, 'wx', 0o600).catch(async (error) => {
        if (!isAlreadyExists(error)) throw error;
        return null;
      });
      if (!handle) {
        return this.readAfterConcurrentCreate();
      }
      try {
        await handle.writeFile(Buffer.from(token).toString('base64url'), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      const stored = await this.read();
      if (!stored) throw new RuntimeTokenError();
      return stored;
    } catch (error) {
      if (error instanceof RuntimeTokenError) throw error;
      throw new RuntimeTokenError();
    }
  }

  private async verifyDirectory(create: boolean): Promise<void> {
    if (create) {
      await fs.promises.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    }
    const stats = await fs.promises.lstat(this.runtimeDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RuntimeTokenError();
    verifyPrivateStats(stats, 0o077);
  }

  private verifyFileStats(stats: fs.Stats): void {
    if (!stats.isFile() || stats.isSymbolicLink()) throw new RuntimeTokenError();
    verifyPrivateStats(stats, 0o077);
  }

  private async readAfterConcurrentCreate(): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const token = await this.read();
        if (token) return token;
      } catch (error) {
        if (!(error instanceof RuntimeTokenError)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new RuntimeTokenError();
  }
}

function decodeToken(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new RuntimeTokenError();
  const token = Buffer.from(encoded, 'base64url');
  if (token.length !== TOKEN_BYTES || token.toString('base64url') !== encoded) {
    throw new RuntimeTokenError();
  }
  return Uint8Array.from(token);
}

function verifyPrivateStats(stats: fs.Stats, disallowedMode: number): void {
  if (process.platform === 'win32') return;
  if ((stats.mode & disallowedMode) !== 0) throw new RuntimeTokenError();
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && stats.uid !== currentUser) throw new RuntimeTokenError();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

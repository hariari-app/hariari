import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeStartupLease, RuntimeStartupLeasePort } from './runtime-ports';

export class FileRuntimeStartupLeasePort implements RuntimeStartupLeasePort {
  private readonly leasePath: string;
  private readonly runtimeDirectory: string;

  constructor(runtimeDirectory: string) {
    this.runtimeDirectory = runtimeDirectory;
    this.leasePath = path.join(runtimeDirectory, 'startup.lock');
  }

  async acquire(_deadlineAt: number): Promise<RuntimeStartupLease | null> {
    await fs.promises.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const directory = await fs.promises.lstat(this.runtimeDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Invalid lease root');
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
      throw new Error('Invalid lease root');
    }
    try {
      await fs.promises.mkdir(this.leasePath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return null;
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await fs.promises.rmdir(this.leasePath).catch(() => undefined);
      },
    };
  }
}

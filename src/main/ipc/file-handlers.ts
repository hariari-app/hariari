import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

const MAX_FILE_LIST_RESULTS = 5000;
const MAX_FILE_READ_SIZE = 512 * 1024;
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '__pycache__',
  '.pytest_cache',
  'target',
  '.cache',
  'coverage',
  '.nyc_output',
  '.turbo',
  '.vercel',
  'vendor',
  'venv',
  '.venv',
  'env',
];

export function registerFileHandlers(): void {
  registerFileWriteHandler();
  registerFileMkdirHandler();
  registerFileRenameHandler();
  registerFileDeleteHandler();
  registerFileListDirHandler();
  registerFileListAllHandler();
  registerFileReadHandler();
}

function registerFileWriteHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, (_event, raw: unknown) => handleFileWrite(raw));
}

async function handleFileWrite(raw: unknown): Promise<unknown> {
  try {
    const request = parseFileWriteRequest(raw);
    fs.writeFileSync(path.resolve(request.path), request.content, 'utf-8');
    return { success: true };
  } catch (error) {
    console.error('[IPC][file:write]', error);
    return { error: 'write_failed' };
  }
}

function registerFileMkdirHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, (_event, raw: unknown) => handleFileMkdir(raw));
}

async function handleFileMkdir(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_request' };
    fs.mkdirSync(path.resolve(raw), { recursive: true });
    return { success: true };
  } catch (error) {
    console.error('[IPC][file:mkdir]', error);
    return { error: 'mkdir_failed' };
  }
}

function registerFileRenameHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, (_event, raw: unknown) => handleFileRename(raw));
}

async function handleFileRename(raw: unknown): Promise<unknown> {
  try {
    const request = parseFileRenameRequest(raw);
    const oldPath = path.resolve(request.oldPath);
    const newPath = path.resolve(request.newPath);
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    return { success: true };
  } catch (error) {
    console.error('[IPC][file:rename]', error);
    return { error: 'rename_failed' };
  }
}

function registerFileDeleteHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, (_event, raw: unknown) => handleFileDelete(raw));
}

async function handleFileDelete(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_request' };
    fs.rmSync(path.resolve(raw), { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    console.error('[IPC][file:delete]', error);
    return { error: 'delete_failed' };
  }
}

function registerFileListDirHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIR, (_event, raw: unknown) => handleFileListDir(raw));
}

async function handleFileListDir(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const resolved = path.resolve(raw);
    const entries = await readDirectoryEntries(resolved);
    return entries.slice(0, 500).map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  } catch (error) {
    console.error('[IPC][file:list-dir]', error);
    return { error: 'list_dir_failed' };
  }
}

function registerFileListAllHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_LIST_ALL, (_event, raw: unknown) => handleFileListAll(raw));
}

async function handleFileListAll(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const ignorePatterns = loadIgnorePatterns(raw);
    const results: string[] = [];
    walkFiles(raw, raw, ignorePatterns, results, 0);
    return results.sort();
  } catch (error) {
    console.error('[IPC][file:list-all]', error);
    return { error: 'list_all_failed' };
  }
}

function registerFileReadHandler(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_READ, (_event, raw: unknown) => handleFileRead(raw));
}

async function handleFileRead(raw: unknown): Promise<unknown> {
  try {
    if (typeof raw !== 'string') return { error: 'invalid_path' };
    const resolved = path.resolve(raw);
    const { stat, open } = await import('node:fs/promises');
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return { error: 'not_a_file' };
    const truncated = fileStat.size > MAX_FILE_READ_SIZE;
    const content = await readFileSlice(open, resolved, fileStat.size);
    return { path: resolved, content, truncated };
  } catch (error) {
    console.error('[IPC][file:read]', error);
    return { error: 'read_failed' };
  }
}

function parseFileWriteRequest(raw: unknown): { path: string; content: string } {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_request');
  const request = raw as Record<string, unknown>;
  if (typeof request.path !== 'string' || typeof request.content !== 'string') {
    throw new Error('invalid_request');
  }
  return { path: request.path, content: request.content };
}

function parseFileRenameRequest(raw: unknown): { oldPath: string; newPath: string } {
  if (!raw || typeof raw !== 'object') throw new Error('invalid_request');
  const request = raw as Record<string, unknown>;
  if (typeof request.oldPath !== 'string' || typeof request.newPath !== 'string') {
    throw new Error('invalid_request');
  }
  return { oldPath: request.oldPath, newPath: request.newPath };
}

async function readDirectoryEntries(resolved: string): Promise<fs.Dirent[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(resolved, { withFileTypes: true });
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function loadIgnorePatterns(rootPath: string): Set<string> {
  const ignorePatterns = new Set(DEFAULT_IGNORE_PATTERNS);
  try {
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return ignorePatterns;
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        ignorePatterns.add(trimmed.replace(/\/$/, '').replace(/^\//, ''));
      }
    }
  } catch {
    // ignore
  }
  return ignorePatterns;
}

function walkFiles(
  rootPath: string,
  dir: string,
  ignorePatterns: ReadonlySet<string>,
  results: string[],
  depth: number,
): void {
  if (results.length >= MAX_FILE_LIST_RESULTS || depth > 15) return;
  const entries = readDirents(dir);
  for (const entry of entries) {
    if (results.length >= MAX_FILE_LIST_RESULTS) break;
    if (entry.name.startsWith('.') || ignorePatterns.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootPath, fullPath, ignorePatterns, results, depth + 1);
    } else if (entry.isFile()) {
      results.push(path.relative(rootPath, fullPath));
    }
  }
}

function readDirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as fs.Dirent[];
  } catch {
    return [];
  }
}

async function readFileSlice(
  open: typeof import('node:fs/promises').open,
  resolved: string,
  fileSize: number,
): Promise<string> {
  const handle = await open(resolved, 'r');
  const buffer = Buffer.alloc(Math.min(fileSize, MAX_FILE_READ_SIZE));
  await handle.read(buffer, 0, buffer.length, 0);
  await handle.close();
  return buffer.toString('utf-8');
}

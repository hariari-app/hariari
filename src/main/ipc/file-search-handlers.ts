import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

const SEARCH_BUFFER_SIZE = 2 * 1024 * 1024;

export function registerFileSearchHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, (_event, raw: unknown) => handleFileSearch(raw));
}

async function handleFileSearch(raw: unknown): Promise<unknown[]> {
  try {
    const request = parseFileSearchRequest(raw);
    if (!request || !request.query.trim()) return [];
    return await searchFiles(request.projectPath, request.query, request.maxResults);
  } catch (error) {
    console.error('[IPC][file:search]', error);
    return [];
  }
}

function parseFileSearchRequest(
  raw: unknown,
): { projectPath: string; query: string; maxResults: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const request = raw as Record<string, unknown>;
  if (typeof request.projectPath !== 'string' || typeof request.query !== 'string') return null;
  return {
    projectPath: request.projectPath,
    query: request.query,
    maxResults: typeof request.maxResults === 'number' ? request.maxResults : 100,
  };
}

async function searchFiles(
  projectPath: string,
  query: string,
  maxResults: number,
): Promise<unknown[]> {
  const { execFile } = await import('node:child_process');
  const ripgrepOutput = await runSearch(
    execFile,
    'rg',
    createRipgrepArgs(projectPath, query, maxResults),
  );
  if (ripgrepOutput.trim()) return parseSearchResults(ripgrepOutput, projectPath, true);
  const grepOutput = await runSearch(execFile, 'grep', createGrepArgs(projectPath, query));
  return grepOutput.trim() ? parseSearchResults(grepOutput, projectPath, false) : [];
}

function runSearch(
  execFile: typeof import('node:child_process').execFile,
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10000, maxBuffer: SEARCH_BUFFER_SIZE }, (_err, stdout) => {
      resolve(stdout || '');
    });
  });
}

function createRipgrepArgs(projectPath: string, query: string, maxResults: number): string[] {
  return [
    '--line-number',
    '--column',
    '--no-heading',
    '--max-count',
    String(maxResults),
    '--glob',
    '!node_modules',
    '--glob',
    '!.git',
    '--glob',
    '!dist',
    '--glob',
    '!out',
    '--',
    query,
    projectPath,
  ];
}

function createGrepArgs(projectPath: string, query: string): string[] {
  return [
    '-rn',
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=dist',
    '--exclude-dir=out',
    '--exclude-dir=__pycache__',
    '--exclude-dir=.cache',
    query,
    projectPath,
  ];
}

function parseSearchResults(output: string, projectPath: string, isRipgrep: boolean): unknown[] {
  const results: unknown[] = [];
  const pathPrefix = projectPath.endsWith('/') ? projectPath : projectPath + '/';
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parsed = isRipgrep ? parseRipgrepLine(line) : parseGrepLine(line);
    if (!parsed) continue;
    results.push(toSearchResult(parsed, pathPrefix));
    if (results.length >= 200) break;
  }
  return results;
}

function parseRipgrepLine(
  line: string,
): { filePath: string; lineNumber: number; lineContent: string; matchStart: number } | null {
  const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
  if (!match) return null;
  return {
    filePath: match[1],
    lineNumber: parseInt(match[2], 10),
    lineContent: match[4],
    matchStart: parseInt(match[3], 10) - 1,
  };
}

function parseGrepLine(
  line: string,
): { filePath: string; lineNumber: number; lineContent: string; matchStart: number } | null {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return null;
  return {
    filePath: match[1],
    lineNumber: parseInt(match[2], 10),
    lineContent: match[3],
    matchStart: 0,
  };
}

function toSearchResult(
  parsed: { filePath: string; lineNumber: number; lineContent: string; matchStart: number },
  pathPrefix: string,
): unknown {
  const filePath = parsed.filePath.startsWith(pathPrefix)
    ? parsed.filePath.slice(pathPrefix.length)
    : parsed.filePath;
  return {
    filePath,
    lineNumber: parsed.lineNumber,
    lineContent: parsed.lineContent.trim(),
    matchStart: parsed.matchStart,
    matchEnd: parsed.matchStart + 1,
  };
}

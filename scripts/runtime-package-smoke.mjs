import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const args = process.argv.slice(2);
const explicitResources = valuesFor('--resources');
const distRoots = valuesFor('--dist');
const resourcesRoots = new Set(explicitResources.map((value) => path.resolve(value)));

const rootsToScan =
  distRoots.length > 0
    ? distRoots
    : explicitResources.length === 0
      ? [path.join(repositoryRoot, 'dist')]
      : [];
for (const distRoot of rootsToScan) {
  for (const root of findResourcesRoots(path.resolve(distRoot))) resourcesRoots.add(root);
}

if (resourcesRoots.size === 0) {
  throw new Error(`No packaged ${platformKey} Runtime resources were found`);
}

const vitestPath = path.join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs');
let smokeCount = 0;
const desktopExecutables = new Set();
for (const resourcesPath of resourcesRoots) {
  const manifestPath = path.join(resourcesPath, 'runtime', platformKey, 'runtime-manifest.json');
  if (!fs.existsSync(manifestPath)) continue;
  smokeCount += 1;
  smokeStandaloneRuntime(resourcesPath);
  const desktopExecutable = resolveDesktopExecutable(resourcesPath);
  if (desktopExecutable) desktopExecutables.add(desktopExecutable);
}
if (smokeCount === 0) {
  throw new Error(`No packaged ${platformKey} Runtime manifest was verified`);
}
if (desktopExecutables.size === 0) {
  throw new Error(`No packaged ${platformKey} Desktop executable was found`);
}
for (const desktopExecutable of desktopExecutables) launchPackagedDesktop(desktopExecutable);

function smokeStandaloneRuntime(resourcesPath) {
  process.stdout.write(`Smoking standalone Runtime resources at ${resourcesPath}\n`);
  const result = spawnSync(
    process.execPath,
    [vitestPath, 'run', 'tests/integration/runtime-packaging-sea.test.ts'],
    {
      cwd: repositoryRoot,
      env: { ...process.env, HARIARI_RUNTIME_PACKAGED_RESOURCES: resourcesPath },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Standalone Runtime smoke failed with status ${result.status ?? 'unknown'}`);
  }
}

function resolveDesktopExecutable(resourcesPath) {
  const parent = path.dirname(resourcesPath);
  const candidates =
    process.platform === 'darwin'
      ? [path.join(parent, 'MacOS', 'Hariari')]
      : process.platform === 'win32'
        ? [path.join(parent, 'Hariari.exe'), path.join(parent, 'hariari.exe')]
        : [path.join(parent, 'hariari'), path.join(parent, 'Hariari')];
  return candidates.find(isExecutableFile);
}

function isExecutableFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function launchPackagedDesktop(desktopExecutable) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-package-smoke-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.HARIARI_RUNTIME_SMOKE_DIRECTORY = path.join(smokeRoot, 'runtime');
  const args = ['--runtime-package-smoke', '--disable-gpu'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  process.stdout.write(`Launching packaged Desktop executable at ${desktopExecutable}\n`);
  try {
    const result = spawnSync(desktopExecutable, args, {
      cwd: path.dirname(desktopExecutable),
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (
      result.error ||
      result.status !== 0 ||
      !result.stdout?.includes('HARIARI_RUNTIME_PACKAGE_SMOKE_OK')
    ) {
      throw new Error(`Packaged Desktop smoke failed with status ${result.status ?? 'unknown'}`);
    }
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function valuesFor(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    values.push(value);
    index += 1;
  }
  return values;
}

function findResourcesRoots(root) {
  if (!fs.existsSync(root)) return [];
  const found = new Set();
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 8) continue;
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(current.directory, entry.name);
      if (entry.name === platformKey && path.basename(current.directory) === 'runtime') {
        const manifestPath = path.join(directory, 'runtime-manifest.json');
        if (fs.existsSync(manifestPath)) found.add(path.dirname(current.directory));
        continue;
      }
      pending.push({ directory, depth: current.depth + 1 });
    }
  }
  return [...found];
}

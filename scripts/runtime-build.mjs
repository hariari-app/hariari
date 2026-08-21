import { builtinModules, createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const platformKey = `${process.platform}-${process.arch}`;
const resourcesRoot = path.join(repositoryRoot, 'out', 'runtime-artifacts');
const platformRoot = path.join(resourcesRoot, 'runtime', platformKey);
const executableName = process.platform === 'win32' ? 'hariari-runtime.exe' : 'hariari-runtime';
const executablePath = path.join(platformRoot, executableName);
const workingRoot = path.join(repositoryRoot, 'out', '.runtime-sea-work', platformKey);
const bundlePath = path.join(workingRoot, 'runtime.cjs');
const blobPath = path.join(workingRoot, 'runtime.blob');
const seaConfigPath = path.join(workingRoot, 'sea-config.json');
const injectedPath = path.join(workingRoot, executableName);

assertSafeBuildPath(platformRoot);
assertSafeBuildPath(workingRoot);
fs.rmSync(platformRoot, { recursive: true, force: true });
fs.rmSync(workingRoot, { recursive: true, force: true });
fs.mkdirSync(platformRoot, { recursive: true });
fs.mkdirSync(workingRoot, { recursive: true });

try {
  const result = await build({
    entryPoints: [path.join(repositoryRoot, 'src', 'runtime', 'index.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    logLevel: 'info',
    metafile: true,
    minify: false,
    platform: 'node',
    sourcemap: false,
    target: 'node20',
  });
  verifyBuiltinsOnly(result.metafile);
  fs.writeFileSync(
    seaConfigPath,
    `${JSON.stringify({
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    })}\n`,
  );
  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
  fs.copyFileSync(process.execPath, injectedPath);
  if (process.platform !== 'win32') fs.chmodSync(injectedPath, 0o755);
  if (process.platform === 'darwin') run('codesign', ['--remove-signature', injectedPath]);

  const postjectArgs = [
    require.resolve('postject/dist/cli.js'),
    injectedPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run(process.execPath, postjectArgs);
  if (process.platform !== 'win32') fs.chmodSync(injectedPath, 0o755);
  fs.renameSync(injectedPath, executablePath);

  const bytes = fs.readFileSync(executablePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const nativeAssets = copyNodePtyAssets(platformRoot);
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: packageJson.version,
    buildId: sha256.slice(0, 20),
    platform: process.platform,
    arch: process.arch,
    executable: executableName,
    nodeVersion: process.versions.node,
    protocolRange: { min: 1, max: 1 },
    sha256,
    size: bytes.length,
    nativeAssets,
  };
  fs.writeFileSync(
    path.join(platformRoot, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`Built Runtime SEA ${platformKey} (${manifest.buildId})\n`);
} finally {
  fs.rmSync(workingRoot, { recursive: true, force: true });
}

function copyNodePtyAssets(destinationRoot) {
  const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json'));
  const assets = [];
  copyNodePtyFile(nodePtyRoot, destinationRoot, 'package.json', assets);
  copyNodePtyDirectory(nodePtyRoot, destinationRoot, 'lib', assets, (name) =>
    name.endsWith('.js') && !name.includes('.test.'),
  );
  const prebuildRoot = path.join('prebuilds', platformKey);
  if (fs.existsSync(path.join(nodePtyRoot, prebuildRoot))) {
    copyNodePtyDirectory(nodePtyRoot, destinationRoot, prebuildRoot, assets, (name) =>
      /\.(node|dll|exe)$/.test(name),
    );
  } else {
    copyNodePtyFile(nodePtyRoot, destinationRoot, path.join('build', 'Release', 'pty.node'), assets);
    const helper = path.join('build', 'Release', 'spawn-helper');
    if (fs.existsSync(path.join(nodePtyRoot, helper))) {
      copyNodePtyFile(nodePtyRoot, destinationRoot, helper, assets);
    }
  }
  if (assets.length < 3) throw new Error('node-pty assets are unavailable for this Runtime platform');
  return assets;
}

function copyNodePtyDirectory(nodePtyRoot, destinationRoot, relativeDirectory, assets, include) {
  const sourceDirectory = path.join(nodePtyRoot, relativeDirectory);
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      copyNodePtyDirectory(nodePtyRoot, destinationRoot, relativePath, assets, include);
    } else if (entry.isFile() && include(entry.name)) {
      copyNodePtyFile(nodePtyRoot, destinationRoot, relativePath, assets);
    } else if (entry.isSymbolicLink()) {
      throw new Error('node-pty asset cannot be a symbolic link');
    }
  }
}

function copyNodePtyFile(nodePtyRoot, destinationRoot, relativePath, assets) {
  const sourcePath = path.join(nodePtyRoot, relativePath);
  const destinationPath = path.join(destinationRoot, 'node_modules', 'node-pty', relativePath);
  const stats = fs.lstatSync(sourcePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('node-pty asset is not a regular file');
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, destinationPath);
  fs.chmodSync(destinationPath, stats.mode & 0o777);
  const bytes = fs.readFileSync(destinationPath);
  assets.push({
    path: path.posix.join('node_modules', 'node-pty', ...relativePath.split(path.sep)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });
}

function verifyBuiltinsOnly(metafile) {
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => (name.startsWith('node:') ? name : `node:${name}`)),
  ]);
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !builtins.has(imported.path)) {
        throw new Error(`Runtime bundle contains external dependency: ${imported.path}`);
      }
    }
  }
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`Runtime build command failed with status ${result.status ?? 'unknown'}`);
  }
}

function assertSafeBuildPath(candidate) {
  const outputRoot = path.join(repositoryRoot, 'out');
  const relative = path.relative(outputRoot, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Runtime build output escaped the repository output directory');
  }
}

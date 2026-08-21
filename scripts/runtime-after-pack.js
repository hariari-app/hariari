const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const linuxAfterPack = require('./after-pack.js').default;

exports.default = async function runtimeAfterPack(context) {
  await linuxAfterPack(context);
  if (context.electronPlatformName !== 'darwin') return;

  const identity = findMacSigningIdentity();
  const entitlementsPath = path.join(
    context.appOutDir,
    `.runtime-entitlements-${process.pid}.plist`,
  );
  fs.writeFileSync(entitlementsPath, runtimeEntitlements());
  try {
    for (const manifestPath of findRuntimeManifests(context)) {
      const { executablePath } = readArtifact(manifestPath);
      const args = [
        '--force',
        '--options',
        'runtime',
        '--entitlements',
        entitlementsPath,
        '--sign',
        identity,
      ];
      if (identity !== '-') args.push('--timestamp');
      args.push(executablePath);
      execFileSync('codesign', args, { stdio: 'inherit' });
      execFileSync('codesign', ['--verify', '--strict', '--verbose=2', executablePath], {
        stdio: 'inherit',
      });
      refreshRuntimeManifest(manifestPath);
    }
  } finally {
    fs.unlinkSync(entitlementsPath);
  }
};

function findMacSigningIdentity() {
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const match = output.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"Developer ID Application:/m);
  return match?.[1] ?? '-';
}

function runtimeEntitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
`;
}

function findRuntimeManifests(context) {
  const resourcesRoot =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const runtimeRoot = path.join(resourcesRoot, 'runtime');
  if (!fs.existsSync(runtimeRoot)) throw new Error('Packaged Runtime resources are missing');
  const manifests = fs
    .readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(runtimeRoot, entry.name, 'runtime-manifest.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath));
  if (manifests.length === 0) throw new Error('Packaged Runtime manifest is missing');
  return manifests;
}

function refreshRuntimeManifest(manifestPath) {
  const { manifest, executablePath } = readArtifact(manifestPath);
  const bytes = fs.readFileSync(executablePath);
  const refreshed = {
    ...manifest,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(refreshed, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
}

function readArtifact(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedExecutable =
    manifest.platform === 'win32' ? 'hariari-runtime.exe' : 'hariari-runtime';
  if (manifest.schemaVersion !== 1 || manifest.executable !== expectedExecutable) {
    throw new Error('Packaged Runtime manifest is invalid');
  }
  const executablePath = path.join(path.dirname(manifestPath), manifest.executable);
  const stats = fs.lstatSync(executablePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Packaged Runtime executable is invalid');
  }
  return { manifest, executablePath };
}

exports.findRuntimeManifests = findRuntimeManifests;
exports.refreshRuntimeManifest = refreshRuntimeManifest;

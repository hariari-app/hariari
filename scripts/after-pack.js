const fs = require('node:fs');
const path = require('node:path');

// On Linux, create a wrapper script that passes --no-sandbox to the
// Electron binary.  Ubuntu 23.10+ disables unprivileged user namespaces
// via AppArmor, and the SUID sandbox requires /dev/shm to be writable —
// both cause renderer crashes (blank white screen) in practice.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const outDir = context.appOutDir;

  // Find the actual Electron executable (not chrome-sandbox, not a .so)
  const files = fs.readdirSync(outDir);
  const execName = context.packager.executableName;

  const execPath = path.join(outDir, execName);
  if (!fs.existsSync(execPath)) {
    console.log(`[afterPack] Executable not found at ${execPath}, files:`, files.filter(f => !f.includes('.')).join(', '));
    return;
  }

  const realPath = path.join(outDir, `${execName}.bin`);

  // Rename real binary → .bin
  fs.renameSync(execPath, realPath);

  // Write wrapper script
  const wrapper = `#!/bin/bash
# Wrapper: pass --no-sandbox so the app works on Linux distros that
# restrict unprivileged user namespaces (Ubuntu 23.10+, Fedora 38+, etc.)
exec "$(dirname "$0")/${execName}.bin" --no-sandbox "$@"
`;
  fs.writeFileSync(execPath, wrapper, { mode: 0o755 });

  // Remove chrome-sandbox — no longer needed
  const sandbox = path.join(outDir, 'chrome-sandbox');
  try { fs.unlinkSync(sandbox); } catch { /* may not exist */ }

  console.log(`[afterPack] Created --no-sandbox wrapper for ${execName}`);
};

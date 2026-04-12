#!/usr/bin/env node

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const GITHUB_OWNER = 'hariari-app';
const GITHUB_REPO = 'hariari';
const APP_DIR = path.join(os.homedir(), '.hariari', 'bin');

// Known distro families from /etc/os-release ID and ID_LIKE fields
const DEB_DISTROS = new Set([
  'debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin',
  'kali', 'parrot', 'mx', 'antix', 'devuan', 'deepin', 'bodhi',
  'peppermint', 'lmde', 'tails', 'pureos', 'raspbian', 'armbian',
  'neon', 'kubuntu', 'xubuntu', 'lubuntu', 'ubuntumate',
  'ubuntubudgie', 'ubuntustudio', 'ubuntukylin', 'ubuntucinnamon',
  'bunsenlabs', 'sparky', 'siduction', 'neptune', 'kaos',
]);

const RPM_DISTROS = new Set([
  'fedora', 'rhel', 'centos', 'rocky', 'alma', 'almalinux',
  'oracle', 'oraclelinux', 'ol', 'scientific', 'amzn', 'amazon',
  'opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'suse', 'sles',
  'mageia', 'openmandriva', 'rosa', 'pclinuxos', 'clearos',
  'eurolinux', 'springdale', 'nobara', 'ultramarine', 'qubes',
]);

// Detect Linux package format from /etc/os-release, then fall back to binary check
function detectLinuxPackageManager() {
  // Phase 1: parse /etc/os-release for ID and ID_LIKE
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    const id = (release.match(/^ID=(.*)$/m) || [])[1]?.replace(/"/g, '').toLowerCase();
    const idLike = (release.match(/^ID_LIKE=(.*)$/m) || [])[1]?.replace(/"/g, '').toLowerCase() || '';
    const ids = [id, ...idLike.split(/\s+/)].filter(Boolean);

    for (const distroId of ids) {
      if (DEB_DISTROS.has(distroId)) return 'deb';
      if (RPM_DISTROS.has(distroId)) return 'rpm';
    }
  } catch {
    // /etc/os-release not available
  }

  // Phase 2: fall back to binary detection for unlisted distros
  try {
    execSync('which dpkg', { stdio: 'ignore' });
    return 'deb';
  } catch {
    // not Debian-based
  }
  try {
    execSync('which rpm', { stdio: 'ignore' });
    return 'rpm';
  } catch {
    // not RPM-based
  }

  return 'appimage';
}

// Map platform + arch to electron-builder artifact names
function getArtifact(version) {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux') {
    const pkgType = detectLinuxPackageManager();
    const debArch = arch === 'x64' ? 'amd64' : 'arm64';
    const appimageArch = arch === 'x64' ? 'x86_64' : 'arm64';

    const linuxMap = {
      deb: { file: `hariari_${version}_${debArch}.deb`, launch: 'deb' },
      rpm: { file: `hariari-${version}.${debArch === 'amd64' ? 'x86_64' : 'aarch64'}.rpm`, launch: 'rpm' },
      appimage: { file: `Hariari-${version}-${appimageArch}.AppImage`, launch: 'appimage' },
    };

    return linuxMap[pkgType];
  }

  const map = {
    'darwin-x64': { file: `Hariari-${version}-x64.dmg`, launch: 'dmg' },
    'darwin-arm64': { file: `Hariari-${version}-arm64.dmg`, launch: 'dmg' },
    'win32-x64': { file: `Hariari-${version}-x64.exe`, launch: 'exe' },
  };

  const key = `${platform}-${arch}`;
  const artifact = map[key];

  if (!artifact) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    console.error(`Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64`);
    process.exit(1);
  }

  return artifact;
}

// Follow redirects and download to a file
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (u) => {
      https.get(u, { headers: { 'User-Agent': 'hariari-launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          const newFile = fs.createWriteStream(dest);
          const followUrl = res.headers.location;
          https.get(followUrl, { headers: { 'User-Agent': 'hariari-launcher' } }, (r2) => {
            if (r2.statusCode !== 200) {
              newFile.close();
              reject(new Error(`Download failed: HTTP ${r2.statusCode}`));
              return;
            }
            const total = parseInt(r2.headers['content-length'], 10);
            let downloaded = 0;
            r2.on('data', (chunk) => {
              downloaded += chunk.length;
              if (total) {
                const pct = Math.round((downloaded / total) * 100);
                process.stdout.write(`\r  Downloading... ${pct}%`);
              }
            });
            r2.pipe(newFile);
            newFile.on('finish', () => {
              newFile.close();
              process.stdout.write('\n');
              resolve();
            });
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'], 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const pct = Math.round((downloaded / total) * 100);
            process.stdout.write(`\r  Downloading... ${pct}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', reject);
    };
    request(url);
  });
}

// Fetch latest release version from GitHub API
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    https.get(url, { headers: { 'User-Agent': 'hariari-launcher', Accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${body}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(data.tag_name.replace(/^v/, ''));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Compute SHA256 of a file
function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Install desktop entry and icon for AppImage
function installDesktopEntry(appImagePath) {
  const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
  const iconDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');
  const iconSource = path.join(__dirname, '..', 'assets', 'hariari.png');
  const iconDest = path.join(iconDir, 'hariari.png');
  const desktopFile = path.join(appsDir, 'hariari.desktop');

  const desktopEntry = `[Desktop Entry]
Name=Hariari
Comment=AI agent terminal orchestrator for vibe coders
Exec="${appImagePath}"
Icon=hariari
Type=Application
Categories=Development;IDE;
StartupWMClass=hariari
Terminal=false
`;

  try {
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });

    if (fs.existsSync(iconSource)) {
      fs.copyFileSync(iconSource, iconDest);
    }

    fs.writeFileSync(desktopFile, desktopEntry);
    console.log('  Desktop entry installed — Hariari is now in your app launcher.');
  } catch (err) {
    console.log(`  Could not create desktop entry: ${err.message}`);
  }
}

// Launch or install the downloaded binary
function launchApp(filePath, type) {
  if (type === 'deb') {
    console.log('  Installing .deb package (requires sudo)...\n');
    const result = spawnSync('sudo', ['dpkg', '-i', filePath], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('\n  Installation failed. You can install manually:');
      console.error(`  sudo dpkg -i "${filePath}"`);
      process.exit(1);
    }
    console.log('\n  Launching Hariari...\n');
    spawn('hariari', { detached: true, stdio: 'ignore' }).unref();
  } else if (type === 'rpm') {
    console.log('  Installing .rpm package (requires sudo)...\n');
    // Use rpm -U (upgrade) so it works for both install and update
    const result = spawnSync('sudo', ['rpm', '-U', '--force', filePath], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('\n  Installation failed. You can install manually:');
      console.error(`  sudo rpm -U "${filePath}"`);
      process.exit(1);
    }
    console.log('\n  Launching Hariari...\n');
    spawn('hariari', { detached: true, stdio: 'ignore' }).unref();
  } else if (type === 'appimage') {
    fs.chmodSync(filePath, 0o755);
    installDesktopEntry(filePath);
    console.log('');
    const child = spawn(filePath, { detached: true, stdio: 'ignore' });
    child.unref();
  } else if (type === 'dmg') {
    // Mount and open the .app inside
    console.log('  Mounting DMG...');
    execSync(`hdiutil attach "${filePath}" -nobrowse -quiet`);
    const mountPoint = execSync(`hdiutil info | grep "Hariari" | awk '{print $NF}'`).toString().trim();
    const appPath = path.join(mountPoint, 'Hariari.app');
    if (fs.existsSync(appPath)) {
      spawn('open', [appPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Fallback: open the DMG and let the user drag to Applications
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
  } else if (type === 'exe') {
    const child = spawn(filePath, { detached: true, stdio: 'ignore', shell: true });
    child.unref();
  }
}

async function main() {
  console.log('\n  Hariari — AI agent terminal orchestrator\n');

  // Check for existing install
  const versionFile = path.join(APP_DIR, '.version');
  let installedVersion = null;
  if (fs.existsSync(versionFile)) {
    installedVersion = fs.readFileSync(versionFile, 'utf8').trim();
  }

  // Fetch latest
  console.log('  Checking for latest version...');
  let latestVersion;
  try {
    latestVersion = await fetchLatestVersion();
  } catch (err) {
    if (installedVersion) {
      console.log(`  Could not reach GitHub. Using installed v${installedVersion}`);
      latestVersion = installedVersion;
    } else {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  }

  const artifact = getArtifact(latestVersion);
  const destPath = path.join(APP_DIR, artifact.file);

  // Download if not cached or outdated
  if (installedVersion === latestVersion && fs.existsSync(destPath)) {
    console.log(`  Hariari v${latestVersion} is up to date.`);
  } else {
    if (installedVersion) {
      console.log(`  Updating: v${installedVersion} → v${latestVersion}`);
    } else {
      console.log(`  Installing Hariari v${latestVersion}...`);
    }

    // Clean old binaries
    fs.mkdirSync(APP_DIR, { recursive: true, mode: 0o700 });
    const existing = fs.readdirSync(APP_DIR).filter((f) => f.startsWith('Hariari-') || f.startsWith('hariari_') || f.startsWith('hariari-'));
    for (const old of existing) {
      fs.unlinkSync(path.join(APP_DIR, old));
    }

    const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${latestVersion}/${artifact.file}`;
    console.log(`  From: ${url}`);

    await download(url, destPath);

    // Verify checksum if available
    const checksumUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${latestVersion}/SHA256SUMS.txt`;
    try {
      const checksumData = await new Promise((resolve, reject) => {
        https.get(checksumUrl, { headers: { 'User-Agent': 'hariari-launcher' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            https.get(res.headers.location, { headers: { 'User-Agent': 'hariari-launcher' } }, (r2) => {
              let b = '';
              r2.on('data', (d) => (b += d));
              r2.on('end', () => resolve(b));
            }).on('error', reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`No checksums file (HTTP ${res.statusCode})`));
            return;
          }
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(b));
        }).on('error', reject);
      });

      const localHash = await sha256(destPath);
      const expectedLine = checksumData.split('\n').find((l) => l.includes(artifact.file));
      if (expectedLine) {
        const expectedHash = expectedLine.split(/\s+/)[0];
        if (localHash !== expectedHash) {
          console.error('  SECURITY: Checksum mismatch! Aborting.');
          console.error(`  Expected: ${expectedHash}`);
          console.error(`  Got:      ${localHash}`);
          fs.unlinkSync(destPath);
          process.exit(1);
        }
        console.log('  Checksum verified.');
      }
    } catch {
      console.log('  Checksum file not available — skipping verification.');
    }

    fs.writeFileSync(versionFile, latestVersion);
    console.log('  Installed successfully.');
  }

  // Launch / install
  console.log('  Launching Hariari...\n');
  launchApp(destPath, artifact.launch);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}`);
  process.exit(1);
});

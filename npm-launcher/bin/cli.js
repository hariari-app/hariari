#!/usr/bin/env node

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const GITHUB_OWNER = 'hariari-app';
const GITHUB_REPO = 'hariari';
const APP_DIR = path.join(os.homedir(), '.hariari', 'bin');

// Map platform + arch to electron-builder artifact names
function getArtifact(version) {
  const platform = process.platform;
  const arch = process.arch;

  const map = {
    'linux-x64': { file: `Hariari-${version}-amd64.AppImage`, launch: 'appimage' },
    'linux-arm64': { file: `Hariari-${version}-arm64.AppImage`, launch: 'appimage' },
    'darwin-x64': { file: `Hariari-${version}-x64.dmg`, launch: 'dmg' },
    'darwin-arm64': { file: `Hariari-${version}-arm64.dmg`, launch: 'dmg' },
    'win32-x64': { file: `Hariari-${version}-x64.exe`, launch: 'exe' },
  };

  const key = `${platform}-${arch}`;
  const artifact = map[key];

  if (!artifact) {
    console.error(`Unsupported platform: ${platform}-${arch}`);
    console.error(`Supported: ${Object.keys(map).join(', ')}`);
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

// Launch the downloaded binary
function launchApp(filePath, type) {
  if (type === 'appimage') {
    fs.chmodSync(filePath, 0o755);
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
    const existing = fs.readdirSync(APP_DIR).filter((f) => f.startsWith('Hariari-'));
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

  // Launch
  console.log('  Launching Hariari...\n');
  launchApp(destPath, artifact.launch);
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}`);
  process.exit(1);
});

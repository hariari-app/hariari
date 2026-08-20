import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('Runtime release update metadata', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['mac', 'zip'],
    ['linux', 'AppImage'],
  ] as const)(
    'retains both native architectures in the %s update manifest',
    (platform, extension) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `hariari-${platform}-updates-`));
      roots.push(root);
      const x64 = path.join(root, `latest-${platform}-x64.yml`);
      const arm64 = path.join(root, `latest-${platform}-arm64.yml`);
      const output = path.join(root, `latest-${platform}.yml`);
      fs.writeFileSync(x64, manifest(platform, extension, 'x64'));
      fs.writeFileSync(arm64, manifest(platform, extension, 'arm64'));

      execFileSync(
        process.execPath,
        [path.resolve('scripts/runtime-merge-architecture-updates.mjs'), x64, arm64, output],
        { stdio: 'pipe' },
      );

      const merged = fs.readFileSync(output, 'utf8');
      expect(merged).toContain(`url: Hariari-0.6.8-x64.${extension}`);
      expect(merged).toContain(`url: Hariari-0.6.8-arm64.${extension}`);
      expect(merged.match(/^files:$/gm)).toHaveLength(1);
    },
  );
});

function manifest(
  platform: 'mac' | 'linux',
  extension: 'zip' | 'AppImage',
  arch: 'x64' | 'arm64',
): string {
  return `version: 0.6.8
files:
  - url: Hariari-0.6.8-${arch}.${extension}
    sha512: ${arch}-digest
    size: 100
path: Hariari-0.6.8-${arch}.${extension}
sha512: ${arch}-digest
releaseDate: '2026-08-20T00:00:00.000Z'
platform: ${platform}
`;
}

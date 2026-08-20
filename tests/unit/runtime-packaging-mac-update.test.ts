import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('macOS Runtime release metadata', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('retains both native architecture downloads in the update manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hariari-mac-updates-'));
    roots.push(root);
    const x64 = path.join(root, 'latest-mac-x64.yml');
    const arm64 = path.join(root, 'latest-mac-arm64.yml');
    const output = path.join(root, 'latest-mac.yml');
    fs.writeFileSync(x64, manifest('x64'));
    fs.writeFileSync(arm64, manifest('arm64'));

    execFileSync(
      process.execPath,
      [path.resolve('scripts/runtime-merge-mac-updates.mjs'), x64, arm64, output],
      { stdio: 'pipe' },
    );

    const merged = fs.readFileSync(output, 'utf8');
    expect(merged).toContain('url: Hariari-0.6.8-x64.zip');
    expect(merged).toContain('url: Hariari-0.6.8-arm64.zip');
    expect(merged.match(/^files:$/gm)).toHaveLength(1);
  });
});

function manifest(arch: 'x64' | 'arm64'): string {
  return `version: 0.6.8
files:
  - url: Hariari-0.6.8-${arch}.zip
    sha512: ${arch}-digest
    size: 100
path: Hariari-0.6.8-${arch}.zip
sha512: ${arch}-digest
releaseDate: '2026-08-20T00:00:00.000Z'
`;
}

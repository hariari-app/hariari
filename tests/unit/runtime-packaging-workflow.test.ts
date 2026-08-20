import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Runtime native release workflow', () => {
  it('builds every advertised Linux architecture on a matching native runner', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/build-release.yml'), 'utf8');
    const supportTable = fs.readFileSync(path.resolve('npm-launcher/README.md'), 'utf8');

    expect(supportTable).toContain('| Linux (other) | x64, arm64 |');
    expect(workflow).toContain('runner: ubuntu-latest\n            arch: x64');
    expect(workflow).toContain('runner: ubuntu-24.04-arm\n            arch: arm64');
    expect(workflow).toContain('npx electron-builder --linux --${{ matrix.arch }} -p never');
    expect(workflow).toContain('name: linux-builds-${{ matrix.arch }}');
    expect(workflow).toContain('mv dist/latest-linux.yml dist/latest-linux-x64.yml');
    expect(workflow).toContain('test -f dist/latest-linux-arm64.yml');
  });
});

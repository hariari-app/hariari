import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function workflowStep(workflow: string, marker: string): string {
  const markerIndex = workflow.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Workflow step marker not found: ${marker}`);

  const stepStart = workflow.lastIndexOf('\n      - ', markerIndex);
  const nextStep = workflow.indexOf('\n      - ', markerIndex);
  return workflow.slice(stepStart < 0 ? 0 : stepStart, nextStep < 0 ? undefined : nextStep);
}

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

  it('publishes updater channel metadata for both Linux architectures', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/build-release.yml'), 'utf8');
    const linuxArtifactUpload = workflowStep(workflow, 'name: linux-builds-${{ matrix.arch }}');
    const linuxArtifactDownload = workflowStep(workflow, 'pattern: linux-builds-*');
    const linuxMetadataMerge = workflowStep(
      workflow,
      'name: Merge Linux architecture update metadata',
    );
    const releaseUpload = workflowStep(workflow, 'uses: softprops/action-gh-release@');

    expect(linuxArtifactUpload).toContain('dist/latest-linux-${{ matrix.arch }}.yml');
    expect(linuxArtifactDownload).toContain('path: artifacts/linux');
    expect(linuxArtifactDownload).toContain('merge-multiple: true');
    expect(linuxMetadataMerge).toContain('artifacts/linux/latest-linux-arm64.yml');
    expect(linuxMetadataMerge).toContain('artifacts/linux/latest-linux.yml');
    expect(releaseUpload).toContain('artifacts/linux/latest-linux.yml');
    expect(releaseUpload).toContain('artifacts/linux/latest-linux-arm64.yml');
    expect(releaseUpload).toContain('artifacts/macos/latest-mac.yml');
  });

  it('launches packaged Desktop executables on each native CI platform', () => {
    const ci = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
    const release = fs.readFileSync(path.resolve('.github/workflows/build-release.yml'), 'utf8');
    const smoke = fs.readFileSync(path.resolve('scripts/runtime-package-smoke.mjs'), 'utf8');

    expect(ci).toContain('xvfb-run -a npm run runtime:package-smoke -- --dist dist');
    expect(release).toContain(
      'xvfb-run -a npm run runtime:package-smoke -- --dist dist/linux-unpacked',
    );
    expect(release).toContain('Verify macOS DMG and ZIP application launch');
    expect(release).toContain('Verify installed Windows application launch');
    expect(smoke).toContain('HARIARI_RUNTIME_PACKAGE_SMOKE_OK');
    expect(smoke).toContain('spawnSync(desktopExecutable');
  });
});

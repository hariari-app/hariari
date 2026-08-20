import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { PackagedRuntimeArtifactPort } from '../../src/main/runtime/packaged-runtime-artifact';

const require = createRequire(import.meta.url);
const { refreshRuntimeManifest } = require('../../scripts/runtime-after-pack.js') as {
  readonly refreshRuntimeManifest: (manifestPath: string) => void;
};

const PLATFORM = 'linux' as const;
const ARCH = 'x64';
const EXECUTABLE_NAME = 'hariari-runtime';
const roots: string[] = [];

describe('packaged Runtime artifact', registerPackagedArtifactTests);

function registerPackagedArtifactTests(): void {
  afterEach(cleanRoots);
  registerArtifactResolutionTest();
  registerInvalidArtifactTests();
  registerTraversalTest();
  registerSignedArtifactTest();
  registerCanonicalRuntimeRootTest();
  registerMaterializationSymlinkTest();
  registerConcurrentMaterializationTest();
  registerWindowsBuildMaterializationTest();
  registerWindowsSignedArtifactMaterializationTest();
}

function registerArtifactResolutionTest(): void {
  it('resolves only the manifest-bound artifact below process.resourcesPath', async () => {
    const fixture = createFixture('resources with spaces-ö');
    const port = createPort(fixture);

    const artifact = await port.resolve();

    expect(artifact.runtimeVersion).toBe('0.6.8');
    expect(artifact.buildId).toBe('build-19');
    expect(artifact.executablePath).toBe(
      path.join(
        fixture.runtimeDirectory,
        'bin',
        '0.6.8-linux-x64',
        'build-19',
        '28b023a1ce5362303db380db0886e2eb5fe7690a86ab1dea9f87b63c4b2d5626',
        EXECUTABLE_NAME,
      ),
    );
    expect(fs.readFileSync(artifact.executablePath, 'utf8')).toBe('standalone-runtime');
    expect(fs.statSync(artifact.executablePath).mode & 0o111).not.toBe(0);
  });
}

function registerInvalidArtifactTests(): void {
  it.each(INVALID_ARTIFACT_CASES)(
    'rejects a %s without falling back to PATH',
    async (_name, mutate) => {
      const fixture = createFixture('invalid-package');
      mutate(fixture);

      await expect(createPort(fixture).resolve()).rejects.toMatchObject({
        code: 'artifact-unavailable',
      });
      expect(fs.existsSync(path.join(fixture.runtimeDirectory, 'bin'))).toBe(false);
    },
  );
}

function registerTraversalTest(): void {
  it('rejects manifest traversal outside the platform resource root', async () => {
    const fixture = createFixture('traversal');
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.executable = '../outside-runtime';
    fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(createPort(fixture).resolve()).rejects.toMatchObject({
      code: 'artifact-unavailable',
    });
  });
}

function registerSignedArtifactTest(): void {
  it('accepts the final signed bytes after the package hook refreshes the manifest', async () => {
    const fixture = createFixture('signed-package');
    fs.appendFileSync(fixture.artifactPath, '-platform-signature');
    refreshRuntimeManifest(fixture.manifestPath);

    await expect(createPort(fixture).resolve()).resolves.toMatchObject({
      buildId: 'build-19',
    });
  });
}

function registerCanonicalRuntimeRootTest(): void {
  it('materializes below the canonical Runtime root through a safe ancestor alias', async () => {
    if (process.platform === 'win32') return;
    const fixture = createFixture('canonical-runtime-root');
    const root = path.dirname(fixture.resourcesPath);
    const canonicalHome = path.join(root, 'canonical home');
    const aliasedHome = path.join(root, 'home alias');
    fs.mkdirSync(canonicalHome, { mode: 0o700 });
    fs.symlinkSync(canonicalHome, aliasedHome, 'dir');
    const runtimeDirectory = path.join(aliasedHome, '.hariari', 'runtime');

    const artifact = await createPort({ ...fixture, runtimeDirectory }).resolve();

    expect(artifact.executablePath).toBe(
      path.join(
        canonicalHome,
        '.hariari',
        'runtime',
        'bin',
        '0.6.8-linux-x64',
        'build-19',
        '28b023a1ce5362303db380db0886e2eb5fe7690a86ab1dea9f87b63c4b2d5626',
        EXECUTABLE_NAME,
      ),
    );
    expect(fs.readFileSync(artifact.executablePath, 'utf8')).toBe('standalone-runtime');
  });
}

function registerMaterializationSymlinkTest(): void {
  it('rejects a materialization symlink outside the per-user Runtime root', async () => {
    if (process.platform === 'win32') return;
    const fixture = createFixture('materialization-traversal');
    const outside = path.join(path.dirname(fixture.runtimeDirectory), 'outside-bin');
    fs.mkdirSync(fixture.runtimeDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.runtimeDirectory, 'bin'));

    await expect(createPort(fixture).resolve()).rejects.toMatchObject({
      code: 'artifact-unavailable',
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
}

function registerConcurrentMaterializationTest(): void {
  it('atomically converges concurrent materialization without partial files', async () => {
    const fixture = createFixture('concurrent-日本語');
    const ports = Array.from({ length: 8 }, () => createPort(fixture));

    const artifacts = await Promise.all(ports.map((port) => port.resolve()));

    expect(new Set(artifacts.map((artifact) => artifact.executablePath))).toHaveLength(1);
    const destinationDirectory = path.dirname(artifacts[0].executablePath);
    expect(fs.readdirSync(destinationDirectory)).toEqual([EXECUTABLE_NAME]);
    expect(fs.readFileSync(artifacts[0].executablePath, 'utf8')).toBe('standalone-runtime');
  });
}

function registerWindowsBuildMaterializationTest(): void {
  it('keeps same-version Windows builds at distinct verified paths', async () => {
    const first = createFixture('windows-build-a', {
      platform: 'win32',
      buildId: 'build-a',
      contents: 'standalone-runtime-a',
    });
    const second = createFixture('windows-build-b', {
      platform: 'win32',
      buildId: 'build-b',
      contents: 'standalone-runtime-b',
      runtimeDirectory: first.runtimeDirectory,
    });

    const firstArtifact = await createPort(first).resolve();
    const secondArtifact = await createPort(second).resolve();

    expect(firstArtifact.executablePath).not.toBe(secondArtifact.executablePath);
    expect(fs.readFileSync(firstArtifact.executablePath, 'utf8')).toBe('standalone-runtime-a');
    expect(fs.readFileSync(secondArtifact.executablePath, 'utf8')).toBe('standalone-runtime-b');
  });
}

function registerWindowsSignedArtifactMaterializationTest(): void {
  it('keeps differently signed same-build Windows artifacts at distinct verified paths', async () => {
    const first = createFixture('windows-signed-a', {
      platform: 'win32',
      buildId: 'unsigned-code-build',
      contents: 'standalone-runtime-signed-a',
    });
    const second = createFixture('windows-signed-b', {
      platform: 'win32',
      buildId: 'unsigned-code-build',
      contents: 'standalone-runtime-signed-b',
      runtimeDirectory: first.runtimeDirectory,
    });

    const firstArtifact = await createPort(first).resolve();
    const secondArtifact = await createPort(second).resolve();

    expect(firstArtifact.buildId).toBe(secondArtifact.buildId);
    expect(firstArtifact.executablePath).not.toBe(secondArtifact.executablePath);
    expect(fs.readFileSync(firstArtifact.executablePath, 'utf8')).toBe(
      'standalone-runtime-signed-a',
    );
    expect(fs.readFileSync(secondArtifact.executablePath, 'utf8')).toBe(
      'standalone-runtime-signed-b',
    );
  });
}

interface FixtureOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly buildId?: string;
  readonly contents?: string;
  readonly runtimeDirectory?: string;
}

function createFixture(label: string, options: FixtureOptions = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hariari-${label}-`));
  roots.push(root);
  const platform = options.platform ?? PLATFORM;
  const arch = options.arch ?? ARCH;
  const buildId = options.buildId ?? 'build-19';
  const executableName = platform === 'win32' ? 'hariari-runtime.exe' : 'hariari-runtime';
  const resourcesPath = path.join(root, 'packaged resources');
  const runtimeDirectory =
    options.runtimeDirectory ?? path.join(root, 'home 用户', '.hariari', 'runtime');
  const platformDirectory = path.join(resourcesPath, 'runtime', `${platform}-${arch}`);
  fs.mkdirSync(platformDirectory, { recursive: true });
  const artifactPath = path.join(platformDirectory, executableName);
  fs.writeFileSync(artifactPath, options.contents ?? 'standalone-runtime', { mode: 0o755 });
  const bytes = fs.readFileSync(artifactPath);
  const manifestPath = path.join(platformDirectory, 'runtime-manifest.json');
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: '0.6.8',
      buildId,
      platform,
      arch,
      executable: executableName,
      nodeVersion: process.versions.node,
      protocolRange: { min: 1, max: 1 },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    })}\n`,
  );
  return { resourcesPath, runtimeDirectory, manifestPath, artifactPath, platform, arch };
}

interface Fixture {
  readonly resourcesPath: string;
  readonly runtimeDirectory: string;
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

const INVALID_ARTIFACT_CASES: ReadonlyArray<readonly [string, (fixture: Fixture) => void]> = [
  ['missing manifest', (fixture) => fs.unlinkSync(fixture.manifestPath)],
  [
    'tampered manifest',
    (fixture) => {
      const manifest = readManifest(fixture);
      manifest.sha256 = '0'.repeat(64);
      writeManifest(fixture, manifest);
    },
  ],
  [
    'manifest without protocol metadata',
    (fixture) => {
      const manifest = readManifest(fixture);
      delete manifest.protocolRange;
      writeManifest(fixture, manifest);
    },
  ],
  [
    'manifest for another Runtime version',
    (fixture) => {
      const manifest = readManifest(fixture);
      manifest.runtimeVersion = '0.6.7';
      writeManifest(fixture, manifest);
    },
  ],
  [
    'manifest with a path-unsafe build ID',
    (fixture) => {
      const manifest = readManifest(fixture);
      manifest.buildId = '../build-19';
      writeManifest(fixture, manifest);
    },
  ],
  ['missing artifact', (fixture) => fs.unlinkSync(fixture.artifactPath)],
  ['tampered artifact', (fixture) => fs.appendFileSync(fixture.artifactPath, '-tampered')],
];

function readManifest(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8')) as Record<string, unknown>;
}

function writeManifest(fixture: Fixture, manifest: Record<string, unknown>): void {
  fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
}

function cleanRoots(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

function createPort(fixture: Fixture): PackagedRuntimeArtifactPort {
  return new PackagedRuntimeArtifactPort({
    resourcesPath: fixture.resourcesPath,
    runtimeDirectory: fixture.runtimeDirectory,
    expectedRuntimeVersion: '0.6.8',
    platform: fixture.platform,
    arch: fixture.arch,
  });
}

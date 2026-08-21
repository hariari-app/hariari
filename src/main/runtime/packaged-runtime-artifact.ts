import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimePortError, type RuntimeArtifact, type RuntimeArtifactPort } from './runtime-ports';

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILE_NAME = 'runtime-manifest.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;

export interface PackagedRuntimeArtifactOptions {
  readonly resourcesPath: string;
  readonly runtimeDirectory: string;
  readonly expectedRuntimeVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

interface RuntimeArtifactManifest {
  readonly schemaVersion: 1;
  readonly runtimeVersion: string;
  readonly buildId: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly executable: string;
  readonly nodeVersion: string;
  readonly protocolRange: { readonly min: 1; readonly max: 1 };
  readonly sha256: string;
  readonly size: number;
  readonly nativeAssets: readonly NativeAssetManifest[];
}

interface NativeAssetManifest {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface NativeAssetSource {
  readonly manifest: NativeAssetManifest;
  readonly sourcePath: string;
}

export class PackagedRuntimeArtifactPort implements RuntimeArtifactPort {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private resolution: Promise<RuntimeArtifact> | null = null;

  constructor(private readonly options: PackagedRuntimeArtifactOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  resolve(): Promise<RuntimeArtifact> {
    if (this.resolution) return this.resolution;
    const resolution = this.resolveVerified().catch((error: unknown) => {
      if (this.resolution === resolution) this.resolution = null;
      throw error;
    });
    this.resolution = resolution;
    return resolution;
  }

  private async resolveVerified(): Promise<RuntimeArtifact> {
    try {
      const source = await this.resolveSource();
      const executablePath = await this.materialize(
        source.manifest,
        source.executablePath,
        source.nativeAssets,
      );
      return {
        executablePath,
        runtimeVersion: source.manifest.runtimeVersion,
        buildId: source.manifest.buildId,
      };
    } catch (error) {
      if (error instanceof RuntimePortError) throw error;
      throw new RuntimePortError('artifact-unavailable', undefined, { cause: error });
    }
  }

  private async resolveSource(): Promise<{
    readonly manifest: RuntimeArtifactManifest;
    readonly executablePath: string;
    readonly nativeAssets: readonly NativeAssetSource[];
  }> {
    if (!path.isAbsolute(this.options.resourcesPath)) throw new Error('Invalid resources root');
    const resourcesRoot = await fs.promises.realpath(this.options.resourcesPath);
    const platformRoot = path.resolve(resourcesRoot, 'runtime', `${this.platform}-${this.arch}`);
    const canonicalPlatformRoot = await fs.promises.realpath(platformRoot);
    assertConfined(resourcesRoot, canonicalPlatformRoot);
    const platformStats = await fs.promises.lstat(canonicalPlatformRoot);
    if (!platformStats.isDirectory() || platformStats.isSymbolicLink()) {
      throw new Error('Invalid platform resource directory');
    }

    const manifestPath = path.join(canonicalPlatformRoot, MANIFEST_FILE_NAME);
    const manifestStats = await fs.promises.lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      throw new Error('Invalid Runtime manifest');
    }
    const manifest = parseManifest(
      JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as unknown,
      this.platform,
      this.arch,
      this.options.expectedRuntimeVersion,
    );
    const executablePath = path.resolve(canonicalPlatformRoot, manifest.executable);
    assertConfined(canonicalPlatformRoot, executablePath);
    const executableStats = await fs.promises.lstat(executablePath);
    if (!executableStats.isFile() || executableStats.isSymbolicLink()) {
      throw new Error('Invalid Runtime artifact');
    }
    if (this.platform !== 'win32' && (executableStats.mode & 0o111) === 0) {
      throw new Error('Runtime artifact is not executable');
    }
    const canonicalExecutablePath = await fs.promises.realpath(executablePath);
    assertConfined(canonicalPlatformRoot, canonicalExecutablePath);
    await verifyFile(canonicalExecutablePath, manifest);
    const nativeAssets = await resolveNativeAssets(canonicalPlatformRoot, manifest.nativeAssets);
    return { manifest, executablePath: canonicalExecutablePath, nativeAssets };
  }

  private async materialize(
    manifest: RuntimeArtifactManifest,
    sourcePath: string,
    nativeAssets: readonly NativeAssetSource[],
  ): Promise<string> {
    const requestedRuntimeRoot = path.resolve(this.options.runtimeDirectory);
    const runtimeRoot = await prepareMaterializationRuntimeRoot(requestedRuntimeRoot);
    const binRoot = path.join(runtimeRoot, 'bin');
    const platformDirectory = path.join(
      binRoot,
      `${manifest.runtimeVersion}-${manifest.platform}-${manifest.arch}`,
    );
    const buildDirectory = path.join(platformDirectory, manifest.buildId);
    const requestedDestinationDirectory = path.join(buildDirectory, manifest.sha256);
    const { buildDirectory: canonicalBuildDirectory, destinationDirectory } =
      await ensureMaterializationDirectories(
        runtimeRoot,
        binRoot,
        platformDirectory,
        buildDirectory,
        requestedDestinationDirectory,
      );
    const destinationPath = path.join(destinationDirectory, manifest.executable);
    assertConfined(binRoot, destinationPath);
    if (!(await isValidMaterializedFile(destinationPath, manifest))) {
      await this.materializeExecutable(sourcePath, destinationPath, canonicalBuildDirectory, manifest);
    }
    await preserveExecutableMode(destinationPath, this.platform);
    await materializeNativeAssets(destinationDirectory, nativeAssets, this.platform);
    await syncDirectory(destinationDirectory);
    await syncDirectory(canonicalBuildDirectory);
    await verifyFile(destinationPath, manifest);
    return destinationPath;
  }

  private async materializeExecutable(
    sourcePath: string,
    destinationPath: string,
    buildDirectory: string,
    manifest: RuntimeArtifactManifest,
  ): Promise<void> {
    const temporaryPath = path.join(buildDirectory, `.${randomUUID()}.tmp`);
    assertConfined(buildDirectory, temporaryPath);
    try {
      await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      await preserveExecutableMode(temporaryPath, this.platform);
      await syncFile(temporaryPath);
      await verifyFile(temporaryPath, manifest);
      try {
        await fs.promises.rename(temporaryPath, destinationPath);
      } catch (error) {
        if (!(await isValidMaterializedFile(destinationPath, manifest))) throw error;
      }
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function prepareMaterializationRuntimeRoot(runtimeRoot: string): Promise<string> {
  await fs.promises.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await verifyPrivateDirectory(runtimeRoot);
  const canonicalRuntimeRoot = await fs.promises.realpath(runtimeRoot);
  await verifyPrivateDirectory(canonicalRuntimeRoot);
  return canonicalRuntimeRoot;
}

function parseManifest(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  expectedRuntimeVersion: string,
): RuntimeArtifactManifest {
  if (!isRecord(value)) throw new Error('Invalid Runtime manifest');
  const expectedExecutable = platform === 'win32' ? 'hariari-runtime.exe' : 'hariari-runtime';
  if (
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    value.platform !== platform ||
    value.arch !== arch ||
    value.executable !== expectedExecutable ||
    typeof value.nodeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.nodeVersion) ||
    !isRecord(value.protocolRange) ||
    value.protocolRange.min !== 1 ||
    value.protocolRange.max !== 1 ||
    typeof value.runtimeVersion !== 'string' ||
    !SAFE_ID_PATTERN.test(value.runtimeVersion) ||
    value.runtimeVersion !== expectedRuntimeVersion ||
    typeof value.buildId !== 'string' ||
    !SAFE_ID_PATTERN.test(value.buildId) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    (value.nativeAssets !== undefined && !isNativeAssetList(value.nativeAssets))
  ) {
    throw new Error('Invalid Runtime manifest');
  }
  return {
    ...(value as unknown as Omit<RuntimeArtifactManifest, 'nativeAssets'>),
    nativeAssets: (value.nativeAssets as readonly NativeAssetManifest[] | undefined) ?? [],
  };
}

function isNativeAssetList(value: unknown): value is readonly NativeAssetManifest[] {
  return (
    Array.isArray(value) &&
    value.every(
      (asset) =>
        isRecord(asset) &&
        typeof asset.path === 'string' &&
        isSafeAssetPath(asset.path) &&
        typeof asset.sha256 === 'string' &&
        SHA256_PATTERN.test(asset.sha256) &&
        typeof asset.size === 'number' &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0,
    ) &&
    new Set(value.map((asset) => asset.path)).size === value.length
  );
}

async function ensureMaterializationDirectories(
  runtimeRoot: string,
  binRoot: string,
  platformDirectory: string,
  buildDirectory: string,
  destinationDirectory: string,
): Promise<{
  readonly buildDirectory: string;
  readonly destinationDirectory: string;
}> {
  for (const directory of [binRoot, platformDirectory, buildDirectory, destinationDirectory]) {
    await createPrivateChildDirectory(directory);
  }
  const canonicalBuildDirectory = await fs.promises.realpath(buildDirectory);
  const canonicalDestination = await fs.promises.realpath(destinationDirectory);
  assertConfined(runtimeRoot, canonicalBuildDirectory);
  assertConfined(canonicalBuildDirectory, canonicalDestination);
  assertConfined(runtimeRoot, canonicalDestination);
  return {
    buildDirectory: canonicalBuildDirectory,
    destinationDirectory: canonicalDestination,
  };
}

async function createPrivateChildDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
  });
  await verifyPrivateDirectory(directory);
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Invalid Runtime bin');
  if (process.platform !== 'win32') {
    if ((stats.mode & 0o077) !== 0) throw new Error('Runtime bin is not private');
    const currentUser = process.getuid?.();
    if (currentUser !== undefined && stats.uid !== currentUser) {
      throw new Error('Runtime bin owner is invalid');
    }
  }
}

async function isValidMaterializedFile(
  filePath: string,
  manifest: RuntimeArtifactManifest,
): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    await verifyFile(filePath, manifest);
    return true;
  } catch {
    return false;
  }
}

async function resolveNativeAssets(
  sourceRoot: string,
  manifests: readonly NativeAssetManifest[],
): Promise<readonly NativeAssetSource[]> {
  return Promise.all(
    manifests.map(async (manifest) => {
      const candidate = path.resolve(sourceRoot, manifest.path);
      assertConfined(sourceRoot, candidate);
      const stats = await fs.promises.lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid Runtime native asset');
      const canonicalPath = await fs.promises.realpath(candidate);
      assertConfined(sourceRoot, canonicalPath);
      await verifyNativeFile(canonicalPath, manifest);
      return { manifest, sourcePath: canonicalPath };
    }),
  );
}

async function materializeNativeAssets(
  destinationRoot: string,
  assets: readonly NativeAssetSource[],
  platform: NodeJS.Platform,
): Promise<void> {
  for (const asset of assets) {
    const destinationPath = path.resolve(destinationRoot, asset.manifest.path);
    assertConfined(destinationRoot, destinationPath);
    await ensurePrivateAssetDirectory(destinationRoot, path.dirname(destinationPath));
    if (await isValidNativeAsset(destinationPath, asset.manifest)) continue;
    const temporaryPath = path.join(path.dirname(destinationPath), `.${randomUUID()}.tmp`);
    try {
      await fs.promises.copyFile(asset.sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      await preserveExecutableMode(temporaryPath, platform);
      await verifyNativeFile(temporaryPath, asset.manifest);
      try {
        await fs.promises.rename(temporaryPath, destinationPath);
      } catch (error) {
        if (!(await isValidNativeAsset(destinationPath, asset.manifest))) throw error;
      }
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function ensurePrivateAssetDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid native asset path');
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await createPrivateChildDirectory(current);
  }
}

async function isValidNativeAsset(
  filePath: string,
  manifest: NativeAssetManifest,
): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    await verifyNativeFile(filePath, manifest);
    return true;
  } catch {
    return false;
  }
}

async function verifyFile(filePath: string, manifest: RuntimeArtifactManifest): Promise<void> {
  await verifyDigest(filePath, manifest, 'Runtime artifact');
}

async function verifyNativeFile(filePath: string, manifest: NativeAssetManifest): Promise<void> {
  await verifyDigest(filePath, manifest, 'Runtime native asset');
}

async function verifyDigest(
  filePath: string,
  manifest: { readonly size: number; readonly sha256: string },
  label: string,
): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  if (stats.size !== manifest.size) throw new Error(`${label} size mismatch`);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  if (hash.digest('hex') !== manifest.sha256) {
    throw new Error(`${label} digest mismatch`);
  }
}

async function preserveExecutableMode(filePath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') await fs.promises.chmod(filePath, 0o755);
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertConfined(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error('Runtime artifact escaped its trusted root');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeAssetPath(value: string): boolean {
  return /^node_modules\/node-pty\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value);
}

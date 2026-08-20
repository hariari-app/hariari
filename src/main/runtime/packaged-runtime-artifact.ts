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
      const executablePath = await this.materialize(source.manifest, source.executablePath);
      return {
        executablePath,
        runtimeVersion: source.manifest.runtimeVersion,
        buildId: source.manifest.buildId,
      };
    } catch (error) {
      if (error instanceof RuntimePortError) throw error;
      throw new RuntimePortError('artifact-unavailable');
    }
  }

  private async resolveSource(): Promise<{
    readonly manifest: RuntimeArtifactManifest;
    readonly executablePath: string;
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
    return { manifest, executablePath: canonicalExecutablePath };
  }

  private async materialize(
    manifest: RuntimeArtifactManifest,
    sourcePath: string,
  ): Promise<string> {
    const runtimeRoot = path.resolve(this.options.runtimeDirectory);
    const binRoot = path.join(runtimeRoot, 'bin');
    const destinationDirectory = path.join(
      binRoot,
      `${manifest.runtimeVersion}-${manifest.platform}-${manifest.arch}`,
    );
    const destinationPath = path.join(destinationDirectory, manifest.executable);
    assertConfined(binRoot, destinationPath);
    await ensureMaterializationDirectories(runtimeRoot, binRoot, destinationDirectory);
    if (await isValidMaterializedFile(destinationPath, manifest)) {
      await preserveExecutableMode(destinationPath, this.platform);
      return destinationPath;
    }

    const temporaryPath = path.join(
      destinationDirectory,
      `.${manifest.executable}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      await preserveExecutableMode(temporaryPath, this.platform);
      const handle = await fs.promises.open(temporaryPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await verifyFile(temporaryPath, manifest);
      try {
        await fs.promises.rename(temporaryPath, destinationPath);
      } catch (error) {
        if (!(await isValidMaterializedFile(destinationPath, manifest))) throw error;
      }
      await syncDirectory(destinationDirectory);
      await verifyFile(destinationPath, manifest);
      await preserveExecutableMode(destinationPath, this.platform);
      return destinationPath;
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
    }
  }
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
    value.size <= 0
  ) {
    throw new Error('Invalid Runtime manifest');
  }
  return value as unknown as RuntimeArtifactManifest;
}

async function ensureMaterializationDirectories(
  runtimeRoot: string,
  binRoot: string,
  destinationDirectory: string,
): Promise<void> {
  await fs.promises.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await verifyPrivateDirectory(runtimeRoot);
  await createPrivateChildDirectory(binRoot);
  await createPrivateChildDirectory(destinationDirectory);
  const canonicalRuntimeRoot = await fs.promises.realpath(runtimeRoot);
  const canonicalDestination = await fs.promises.realpath(destinationDirectory);
  if (process.platform !== 'win32' && canonicalRuntimeRoot !== runtimeRoot) {
    throw new Error('Runtime root contains a symbolic link');
  }
  assertConfined(canonicalRuntimeRoot, canonicalDestination);
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

async function verifyFile(filePath: string, manifest: RuntimeArtifactManifest): Promise<void> {
  const stats = await fs.promises.stat(filePath);
  if (stats.size !== manifest.size) throw new Error('Runtime artifact size mismatch');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  if (hash.digest('hex') !== manifest.sha256) {
    throw new Error('Runtime artifact digest mismatch');
  }
}

async function preserveExecutableMode(filePath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') await fs.promises.chmod(filePath, 0o755);
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

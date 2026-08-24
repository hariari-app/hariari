import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActiveExecution,
  ExecutionRecoveryObservation,
  ExecutionResourceObservation,
  PrivateExecutionBinding,
} from './generic-cli-execution-adapter';

const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 4 * 1024;
const MAX_TASK_MARKERS = 9;

interface RecoveryOwnershipMarker {
  readonly version: 1;
  readonly taskId: string;
  readonly contextId: string;
  readonly processId: string;
  readonly ptyId: string;
  readonly pid: number;
  readonly processFingerprint: string | null;
}

/** Records private opaque ownership needed for observation after Runtime restart. */
export function recordRecoveryOwnership(
  runtimeDirectory: string,
  taskId: string,
  context: ActiveExecution['context'],
  pid: number,
): void {
  ensurePrivateDirectory(markerRoot(runtimeDirectory));
  const directory = taskMarkerDirectory(runtimeDirectory, taskId);
  ensurePrivateDirectory(directory);
  const marker: RecoveryOwnershipMarker = {
    version: MARKER_VERSION,
    taskId,
    contextId: context.id,
    processId: context.processId,
    ptyId: context.ptyId,
    pid,
    processFingerprint: processFingerprint(pid),
  };
  const name = hash(context.id);
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  const destination = path.join(directory, `${name}.json`);
  try {
    assertReplaceableMarker(destination);
    fs.writeFileSync(temporary, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* The bounded temp did not exist. */ }
    throw error;
  }
}

function assertReplaceableMarker(destination: string): void {
  try {
    const stats = fs.lstatSync(destination);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MARKER_BYTES) {
      throw new Error('unsafe recovery marker');
    }
    const marker = parseMarker(JSON.parse(fs.readFileSync(destination, 'utf8')));
    if (!marker || processExists(marker.pid)) throw new Error('live recovery marker');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
  }
}

/** Merges restart-safe private markers into a production recovery observation. */
export async function observeRecoveryOwnership(
  runtimeDirectory: string,
  binding: PrivateExecutionBinding,
  baseline: ExecutionRecoveryObservation,
): Promise<ExecutionRecoveryObservation> {
  const markers = await readTaskMarkers(runtimeDirectory, binding.task.id);
  const matching = markers.filter((marker) => marker !== null &&
    marker.contextId === binding.context.id && marker.processId === binding.context.processId &&
    marker.ptyId === binding.context.ptyId) as RecoveryOwnershipMarker[];
  const owned = matching.length === 1 ? expectedMarkerResources(matching[0]!) :
    matching.length > 1 ? duplicatedExpectedResources(matching[0]!, matching.length) : null;
  const resources = baseline.resources.map((resource) => {
    if (!owned || resource.state !== 'unknown') return resource;
    if (resource.kind === 'provider-session' && binding.providerSession) {
      return { ...resource, state: 'inactive' as const, identity: 'matching' as const,
        fingerprint: 'matching' as const, copies: 1 };
    }
    if (resource.kind === 'process') return owned[0];
    if (resource.kind === 'pty') return owned[1];
    return resource;
  });
  const orphans = markers.flatMap((marker) => orphanResources(marker, binding));
  return { resources: [...resources, ...orphans] };
}

function expectedMarkerResources(
  marker: RecoveryOwnershipMarker,
): readonly [ExecutionResourceObservation, ExecutionResourceObservation] {
  const resources = markerResources(marker, true);
  if (resources[0].state !== 'active' || resources[0].fingerprint !== 'matching') {
    return resources;
  }
  return [unknownResource('process', true), unknownResource('pty', true)];
}

/** Reports only a verified dead owned process; live markers cannot restore a PTY handle. */
export async function observeLostRecoveryOwnership(
  runtimeDirectory: string,
  binding: PrivateExecutionBinding,
): Promise<'lost' | 'unknown'> {
  const markers = await readTaskMarkers(runtimeDirectory, binding.task.id);
  const matching = markers.filter((marker) => marker !== null &&
    marker.contextId === binding.context.id && marker.processId === binding.context.processId &&
    marker.ptyId === binding.context.ptyId) as RecoveryOwnershipMarker[];
  if (matching.length !== 1) return 'unknown';
  return observedProcessState(matching[0]!).state === 'absent' ? 'lost' : 'unknown';
}

function orphanResources(
  marker: RecoveryOwnershipMarker | null,
  binding: PrivateExecutionBinding,
): readonly ExecutionResourceObservation[] {
  if (marker === null) return [unknownResource('process', false), unknownResource('pty', false)];
  const expected = marker.contextId === binding.context.id &&
    marker.processId === binding.context.processId && marker.ptyId === binding.context.ptyId;
  if (expected) return [];
  const resources = markerResources(marker, false);
  return resources[0].state === 'absent' ? [] : resources;
}

function markerResources(
  marker: RecoveryOwnershipMarker,
  expected: boolean,
): readonly [ExecutionResourceObservation, ExecutionResourceObservation] {
  const state = observedProcessState(marker);
  return [
    observedResource('process', expected, state),
    observedResource('pty', expected, state),
  ];
}

function duplicatedExpectedResources(
  marker: RecoveryOwnershipMarker,
  copies: number,
): readonly [ExecutionResourceObservation, ExecutionResourceObservation] {
  const resources = markerResources(marker, true);
  return [
    { ...resources[0], copies },
    { ...resources[1], copies },
  ];
}

function observedProcessState(
  marker: RecoveryOwnershipMarker,
): Pick<ExecutionResourceObservation, 'state' | 'identity' | 'fingerprint'> {
  if (!processExists(marker.pid)) {
    return { state: 'absent', identity: 'matching', fingerprint: 'matching' };
  }
  const current = processFingerprint(marker.pid);
  if (current === null || marker.processFingerprint === null) {
    return { state: 'unknown', identity: 'unknown', fingerprint: 'unknown' };
  }
  return current === marker.processFingerprint
    ? { state: 'active', identity: 'matching', fingerprint: 'matching' }
    : { state: 'active', identity: 'matching', fingerprint: 'changed' };
}

function observedResource(
  kind: 'process' | 'pty',
  expected: boolean,
  state: Pick<ExecutionResourceObservation, 'state' | 'identity' | 'fingerprint'>,
): ExecutionResourceObservation {
  return { kind, expected, ...state, copies: state.state === 'absent' ? 0 : 1, adoptable: false };
}

function unknownResource(
  kind: 'process' | 'pty',
  expected: boolean,
): ExecutionResourceObservation {
  return { kind, expected, state: 'unknown', identity: 'unknown', fingerprint: 'unknown',
    copies: 0, adoptable: false };
}

async function readTaskMarkers(
  runtimeDirectory: string,
  taskId: string,
): Promise<readonly (RecoveryOwnershipMarker | null)[]> {
  const directory = taskMarkerDirectory(runtimeDirectory, taskId);
  let entries: readonly fs.Dirent[];
  try {
    const rootStats = await fs.promises.lstat(markerRoot(runtimeDirectory));
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return [null];
    const stats = await fs.promises.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return [null];
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? [] : [null];
  }
  const selected = entries.slice(0, MAX_TASK_MARKERS);
  const overflow = entries.length > MAX_TASK_MARKERS ? [null] : [];
  return [...await Promise.all(selected.map((entry) => readMarker(directory, entry))), ...overflow];
}

async function readMarker(
  directory: string,
  entry: fs.Dirent,
): Promise<RecoveryOwnershipMarker | null> {
  if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) return null;
  try {
    const candidate = path.join(directory, entry.name);
    const stats = await fs.promises.lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MARKER_BYTES) return null;
    return parseMarker(JSON.parse(await fs.promises.readFile(candidate, 'utf8')));
  } catch {
    return null;
  }
}

function parseMarker(value: unknown): RecoveryOwnershipMarker | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (marker.version !== MARKER_VERSION || !identifier(marker.taskId) ||
    !identifier(marker.contextId) || !identifier(marker.processId) || !identifier(marker.ptyId) ||
    !Number.isSafeInteger(marker.pid) || (marker.pid as number) < 1 ||
    (marker.processFingerprint !== null && !fingerprint(marker.processFingerprint))) return null;
  return marker as unknown as RecoveryOwnershipMarker;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('unsafe recovery marker root');
}

function taskMarkerDirectory(runtimeDirectory: string, taskId: string): string {
  return path.join(markerRoot(runtimeDirectory), hash(taskId));
}

function markerRoot(runtimeDirectory: string): string {
  return path.join(runtimeDirectory, 'recovery-resources');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function processFingerprint(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

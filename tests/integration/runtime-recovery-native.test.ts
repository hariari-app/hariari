import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  LocalGenericCliExecutionAdapter,
  loadNodePty,
  runtimeEnvironment,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  createSubject,
  createTestRepository,
  registerRuntimeTaskTestCleanup,
  shellTask,
} from './runtime-task-test-harness';

registerRuntimeTaskTestCleanup();

it('archives a terminal task from real process, PTY, worktree, and branch observations', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('native-recovery-create', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-recovery-start' });
  await runtime.disconnect();
  await subject.restartWith(
    new LocalGenericCliExecutionAdapter({
      runtimeDirectory: subject.runtimeDirectory,
    }),
  );
  const restarted = await subject.connect();

  const recovery = await restarted.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'native-recovery-reconcile',
  });

  expect(recovery).toMatchObject({
    status: 'ready',
    decision: 'archive',
    resources: [
      { kind: 'provider-session', classification: 'healthy' },
      { kind: 'process', classification: 'missing' },
      { kind: 'pty', classification: 'missing' },
      { kind: 'worktree', classification: 'healthy' },
      { kind: 'branch', classification: 'healthy' },
    ],
    attention: null,
  });
  await restarted.disconnect();
});

it('surfaces a real related branch created outside Runtime as orphaned', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('native-orphan-create', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-orphan-start' });
  execFileSync(
    'git',
    ['branch', `hariari/task-${task.id}/external-orphan`, repository.baseCommit],
    { cwd: repository.path },
  );

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'native-orphan-reconcile',
  });

  expect(recovery.resources).toEqual(
    expect.arrayContaining([{ kind: 'branch', classification: 'orphaned' }]),
  );
  expect(recovery).toMatchObject({
    status: 'attention',
    decision: 'fail',
    attention: { reason: 'ambiguous-recovery' },
  });
  await runtime.disconnect();
});

it('chooses adoption for a verified orphan worktree without mutating it', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('native-adopt-create', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-adopt-start' });
  const orphanBranch = `hariari/task-${task.id}/external-adoptable`;
  const orphanPath = path.join(subject.runtimeDirectory, 'task-worktrees', 'external-adoptable');
  execFileSync('git', ['worktree', 'add', '-b', orphanBranch, orphanPath, repository.baseCommit], {
    cwd: repository.path,
  });

  const recovery = await runtime.reconcileTask({
    taskId: task.id,
    idempotencyKey: 'native-adopt-reconcile',
  });
  const decision = await runtime.recoverTask({
    taskId: task.id,
    recoveryId: recovery.id,
    idempotencyKey: 'native-adopt-recover',
  });

  expect(recovery.resources).toEqual(expect.arrayContaining([
    { kind: 'worktree', classification: 'orphaned' },
    { kind: 'branch', classification: 'orphaned' },
  ]));
  expect(recovery, JSON.stringify(recovery)).toMatchObject({
    status: 'ready', decision: 'adopt', attention: null,
  });
  expect(decision).toMatchObject({ status: 'decided', decision: 'adopt', attention: null });
  expect(fs.statSync(orphanPath).isDirectory()).toBe(true);
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: orphanPath, encoding: 'utf8' }).trim())
    .toBe(orphanBranch);
  await runtime.disconnect();
});

it.skipIf(process.platform !== 'linux')(
  'surfaces live orphan process and PTY markers without attaching or exposing identifiers',
  async () => {
    const repository = createTestRepository();
    const subject = await createSubject(
      (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    );
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('native-process-orphan-create', repository.path));
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-process-orphan-start' });
    const orphan = spawnOwnedOrphanPty(subject.runtimeDirectory, task.id, repository.path);
    try {
      const recovery = await runtime.reconcileTask({
        taskId: task.id,
        idempotencyKey: 'native-process-orphan-reconcile',
      });

      expect(recovery.resources).toEqual(expect.arrayContaining([
        { kind: 'process', classification: 'orphaned' },
        { kind: 'pty', classification: 'orphaned' },
      ]));
      expect(recovery).toMatchObject({
        status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
      });
      expect(JSON.stringify(recovery)).not.toMatch(/pid|processId|ptyId|contextId/);
      expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    } finally {
      orphan.kill();
      await orphan.exited;
      await runtime.disconnect();
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'fails closed when an owned process survives restart without its PTY handle',
  async () => {
    const repository = createTestRepository();
    const subject = await createSubject(
      (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    );
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('live-restart-create', repository.path));
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'live-restart-start' });
    const survivor = spawnNativePty(repository.path);
    replaceExpectedMarkerProcess(subject.runtimeDirectory, task.id, survivor.pid);
    await runtime.disconnect();
    await subject.restartWith(new LocalGenericCliExecutionAdapter({
      runtimeDirectory: subject.runtimeDirectory,
    }));
    const restarted = await subject.connect();
    try {
      const recovery = await restarted.reconcileTask({
        taskId: task.id, idempotencyKey: 'live-restart-reconcile',
      });
      expect(recovery.resources).toEqual(expect.arrayContaining([
        { kind: 'process', classification: 'unknown' },
        { kind: 'pty', classification: 'unknown' },
      ]));
      expect(recovery).toMatchObject({
        status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
      });
      expect(() => process.kill(survivor.pid, 0)).not.toThrow();
    } finally {
      survivor.kill();
      await survivor.exited;
      await restarted.disconnect();
    }
  },
);

it('fails closed on an incomplete private ownership marker at a crash boundary', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('marker-crash-create', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'marker-crash-start' });
  await waitForTerminalExecution(runtime, task.id);
  const marker = path.join(taskMarkerDirectory(subject.runtimeDirectory, task.id), 'partial.json');
  fs.writeFileSync(marker, '{"version":1', { mode: 0o600 });
  const before = await runtime.getTaskExecution(task.id);

  const recovery = await runtime.reconcileTask({
    taskId: task.id, idempotencyKey: 'marker-crash-reconcile',
  });
  await runtime.recoverTask({
    taskId: task.id, recoveryId: recovery.id, idempotencyKey: 'marker-crash-recover',
  });

  expect(recovery.resources).toEqual(expect.arrayContaining([
    { kind: 'process', classification: 'unknown' },
    { kind: 'pty', classification: 'unknown' },
  ]));
  expect(recovery).toMatchObject({
    status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
  });
  await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(before);
  expect(fs.readFileSync(marker, 'utf8')).toBe('{"version":1');
  await runtime.disconnect();
});

it.skipIf(process.platform === 'win32')(
  'fails closed on an unsafe orphan worktree without following or deleting it',
  async () => {
    const repository = createTestRepository();
    const subject = await createSubject(
      (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
    );
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('unsafe-worktree-create', repository.path));
    await runtime.startTask({ taskId: task.id, idempotencyKey: 'unsafe-worktree-start' });
    const candidate = path.join(subject.runtimeDirectory, 'task-worktrees', 'unsafe-link');
    fs.symlinkSync(repository.path, candidate, 'dir');

    const recovery = await runtime.reconcileTask({
      taskId: task.id, idempotencyKey: 'unsafe-worktree-reconcile',
    });

    expect(recovery.resources).toEqual(expect.arrayContaining([
      { kind: 'worktree', classification: 'unknown' },
    ]));
    expect(recovery).toMatchObject({
      status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
    });
    expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
    await runtime.disconnect();
  },
);

function spawnOwnedOrphanPty(runtimeDirectory: string, taskId: string, cwd: string) {
  const pty = spawnNativePty(cwd);
  const markerDirectory = taskMarkerDirectory(runtimeDirectory, taskId);
  fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(markerDirectory, 'external.json'), JSON.stringify({
    version: 1, taskId, contextId: 'external-context', processId: 'external-process',
    ptyId: 'external-pty', pid: pty.pid, processFingerprint: linuxProcessFingerprint(pty.pid),
  }), { mode: 0o600 });
  return pty;
}

function spawnNativePty(cwd: string) {
  const pty = loadNodePty(undefined).spawn(process.execPath, [
    '-e', 'setInterval(() => undefined, 1000)',
  ], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: runtimeEnvironment() });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  return { pid: pty.pid, kill: () => pty.kill(), exited };
}

function taskMarkerDirectory(runtimeDirectory: string, taskId: string): string {
  return path.join(runtimeDirectory, 'recovery-resources',
    createHash('sha256').update(taskId).digest('hex'));
}

function replaceExpectedMarkerProcess(
  runtimeDirectory: string,
  taskId: string,
  pid: number,
): void {
  const directory = taskMarkerDirectory(runtimeDirectory, taskId);
  const markerPath = path.join(directory, fs.readdirSync(directory)
    .find((entry) => entry.endsWith('.json'))!);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(markerPath, JSON.stringify({
    ...marker, pid, processFingerprint: linuxProcessFingerprint(pid),
  }));
}

function linuxProcessFingerprint(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19]!;
}

async function waitForTerminalExecution(
  runtime: Awaited<ReturnType<Awaited<ReturnType<typeof createSubject>>['connect']>>,
  taskId: string,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const execution = await runtime.getTaskExecution(taskId);
    if (execution.task.executionState === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('expected native shell task to complete');
}

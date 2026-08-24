import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  LocalGenericCliExecutionAdapter,
  loadNodePty,
  runtimeEnvironment,
  type ExecutionAdapter,
  type PtyPort,
  type PtyProcess,
} from '../../src/runtime/generic-cli-execution-adapter';
import {
  createSubject,
  createTestRepository,
  deferred,
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

it('classifies two valid orphan worktree and branch pairs as duplicated', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('native-duplicates-create', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'native-duplicates-start' });
  const worktreeRoot = path.join(subject.runtimeDirectory, 'task-worktrees');
  const candidates = ['duplicate-one', 'duplicate-two'].map((name) => ({
    branch: `hariari/task-${task.id}/${name}`,
    worktree: path.join(worktreeRoot, name),
  }));
  for (const candidate of candidates) {
    execFileSync(
      'git',
      ['worktree', 'add', '-b', candidate.branch, candidate.worktree, repository.baseCommit],
      { cwd: repository.path },
    );
  }

  const recovery = await runtime.reconcileTask({
    taskId: task.id, idempotencyKey: 'native-duplicates-reconcile',
  });
  const decision = await runtime.recoverTask({
    taskId: task.id, recoveryId: recovery.id, idempotencyKey: 'native-duplicates-recover',
  });

  expect(recovery.resources.filter((resource) => resource.kind === 'worktree')).toEqual([
    { kind: 'worktree', classification: 'healthy' },
    { kind: 'worktree', classification: 'duplicated' },
  ]);
  expect(recovery.resources.filter((resource) => resource.kind === 'branch')).toEqual([
    { kind: 'branch', classification: 'healthy' },
    { kind: 'branch', classification: 'duplicated' },
  ]);
  expect(recovery).toMatchObject({
    status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
  });
  expect(decision).toMatchObject({ status: 'attention', decision: 'fail' });
  for (const candidate of candidates) expect(fs.statSync(candidate.worktree).isDirectory()).toBe(true);
  await runtime.disconnect();
});

it('keeps two concurrently healthy Tasks isolated in the shared Runtime worktree root', async () => {
  const repository = createTestRepository();
  const pty = holdingPtyPort();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory, pty }),
  );
  const runtime = await subject.connect();
  const first = await runtime.createTask(shellTask('shared-root-first-create', repository.path));
  const second = await runtime.createTask(shellTask('shared-root-second-create', repository.path));
  await runtime.startTask({ taskId: first.id, idempotencyKey: 'shared-root-first-start' });
  await runtime.startTask({ taskId: second.id, idempotencyKey: 'shared-root-second-start' });

  const firstRecovery = await runtime.reconcileTask({
    taskId: first.id, idempotencyKey: 'shared-root-first-reconcile',
  });
  const secondRecovery = await runtime.reconcileTask({
    taskId: second.id, idempotencyKey: 'shared-root-second-reconcile',
  });

  for (const recovery of [firstRecovery, secondRecovery]) {
    expect(recovery).toMatchObject({ status: 'ready', decision: 'resume', attention: null });
    expect(recovery.resources.filter((resource) => resource.kind === 'worktree')).toEqual([
      { kind: 'worktree', classification: 'healthy' },
    ]);
    expect(recovery.resources.filter((resource) => resource.kind === 'branch')).toEqual([
      { kind: 'branch', classification: 'healthy' },
    ]);
  }
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

it.skipIf(process.platform !== 'linux')(
  'recovers a spawn-marker-before-context crash through a restarted Runtime',
  async () => {
    const repository = createTestRepository();
    const crashBoundary = deferred();
    const nativePtys = longLivedNativePtyPort();
    const subject = await createSubject((runtimeDirectory) => crashAfterOwnershipMarker(
      new LocalGenericCliExecutionAdapter({ runtimeDirectory, pty: nativePtys.port }),
      crashBoundary,
    ));
    const runtime = await subject.connect();
    const task = await runtime.createTask(shellTask('pre-context-crash-create', repository.path));
    const interruptedStart = runtime.startTask({ taskId: task.id,
      idempotencyKey: 'pre-context-crash-start' }).catch((error: unknown) => error);
    await crashBoundary.promise;
    expect(fs.readdirSync(taskMarkerDirectory(subject.runtimeDirectory, task.id))).not.toHaveLength(0);

    await subject.restartWith(new LocalGenericCliExecutionAdapter({
      runtimeDirectory: subject.runtimeDirectory,
    }));
    await interruptedStart;
    const restarted = await subject.connect();
    try {
      await expect(restarted.getTaskExecution(task.id)).resolves.toMatchObject({
        task: { executionState: 'starting' }, context: null,
      });

      const recovery = await restarted.reconcileTask({
        taskId: task.id, idempotencyKey: 'pre-context-crash-reconcile',
      });
      const decision = await restarted.recoverTask({
        taskId: task.id, recoveryId: recovery.id, idempotencyKey: 'pre-context-crash-recover',
      });

      expect(recovery.resources).toEqual(expect.arrayContaining([
        { kind: 'process', classification: 'orphaned' },
        { kind: 'pty', classification: 'orphaned' },
        { kind: 'worktree', classification: 'orphaned' },
        { kind: 'branch', classification: 'orphaned' },
      ]));
      expect(recovery).toMatchObject({
        status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
      });
      expect(decision).toMatchObject({ status: 'attention', decision: 'fail' });
      expect(JSON.stringify(recovery)).not.toMatch(/pid|processId|ptyId|contextId|worktreeId|branchName/);
      expect(nativePtys.isAlive()).toBe(true);
    } finally {
      await nativePtys.killAll();
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

it('fails closed when another Task identity is substituted into an ownership marker', async () => {
  const repository = createTestRepository();
  const subject = await createSubject(
    (runtimeDirectory) => new LocalGenericCliExecutionAdapter({ runtimeDirectory }),
  );
  const runtime = await subject.connect();
  const task = await runtime.createTask(shellTask('marker-owner-create', repository.path));
  const other = await runtime.createTask(shellTask('marker-owner-other', repository.path));
  await runtime.startTask({ taskId: task.id, idempotencyKey: 'marker-owner-start' });
  await waitForTerminalExecution(runtime, task.id);
  const markerPath = expectedMarkerPath(subject.runtimeDirectory, task.id);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, taskId: other.id }));
  const before = await runtime.getTaskExecution(task.id);

  const recovery = await runtime.reconcileTask({
    taskId: task.id, idempotencyKey: 'marker-owner-reconcile',
  });
  const decision = await runtime.recoverTask({
    taskId: task.id, recoveryId: recovery.id, idempotencyKey: 'marker-owner-recover',
  });

  expect(recovery.resources).toEqual(expect.arrayContaining([
    { kind: 'process', classification: 'unknown' },
    { kind: 'pty', classification: 'unknown' },
  ]));
  expect(recovery).toMatchObject({
    status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
  });
  expect(decision).toMatchObject({
    status: 'attention', decision: 'fail', attention: { reason: 'ambiguous-recovery' },
  });
  await expect(runtime.getTaskExecution(task.id)).resolves.toEqual(before);
  expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({ taskId: other.id });
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
    version: 2, taskId, contextId: 'external-context', worktreeId: 'external-worktree',
    branchName: `hariari/task-${taskId}/external-marker`, baseCommit: 'external-base',
    processId: 'external-process',
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

function holdingPtyPort(): PtyPort {
  return {
    spawn: (): PtyProcess => {
      const exitListeners = new Set<(event: { readonly exitCode: number }) => void>();
      return {
        pid: process.pid,
        onData: () => ({ dispose: () => undefined }),
        onExit: (listener) => {
          exitListeners.add(listener);
          return { dispose: () => exitListeners.delete(listener) };
        },
        kill: () => {
          for (const listener of exitListeners) listener({ exitCode: 143 });
        },
      };
    },
  };
}

function crashAfterOwnershipMarker(
  delegate: ExecutionAdapter,
  boundary: ReturnType<typeof deferred>,
): ExecutionAdapter {
  return {
    capabilities: (task) => delegate.capabilities(task),
    observe: (binding) => delegate.observe(binding),
    observeRecovery: (binding) => delegate.observeRecovery(binding),
    launch: async (plan) => {
      await delegate.launch(plan);
      boundary.resolve();
      return new Promise(() => undefined);
    },
  };
}

function longLivedNativePtyPort(): {
  readonly port: PtyPort;
  readonly isAlive: () => boolean;
  readonly killAll: () => Promise<void>;
} {
  const processes: PtyProcess[] = [];
  const exits: Promise<void>[] = [];
  return {
    port: {
      spawn: (_file, _args, options) => {
        const pty = loadNodePty(undefined).spawn(process.execPath, [
          '-e', 'setInterval(() => undefined, 1000)',
        ], options);
        processes.push(pty);
        exits.push(new Promise<void>((resolve) => pty.onExit(() => resolve())));
        return pty;
      },
    },
    isAlive: () => processes.every((candidate) => {
      try {
        process.kill(candidate.pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
    killAll: async () => {
      for (const candidate of processes) {
        try { candidate.kill(); } catch { /* The crash survivor already exited. */ }
      }
      await Promise.all(exits);
    },
  };
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
  const markerPath = expectedMarkerPath(runtimeDirectory, taskId);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(markerPath, JSON.stringify({
    ...marker, pid, processFingerprint: linuxProcessFingerprint(pid),
  }));
}

function expectedMarkerPath(runtimeDirectory: string, taskId: string): string {
  const directory = taskMarkerDirectory(runtimeDirectory, taskId);
  return path.join(directory, fs.readdirSync(directory)
    .find((entry) => entry.endsWith('.json'))!);
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

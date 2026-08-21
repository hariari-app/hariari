import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RuntimeFrameDecoder, RuntimeFrameError, encodeRuntimeFrame } from './frame-codec';

export interface RuntimeLocalEndpoint {
  readonly kind: 'unix' | 'windows-pipe';
  readonly address: string;
  readonly runtimeDirectory: string;
}

export type RuntimeTransportErrorCode =
  | 'endpoint-unavailable'
  | 'connect-failed'
  | 'deadline'
  | 'closed'
  | 'protocol';

export class RuntimeTransportError extends Error {
  readonly code: RuntimeTransportErrorCode;

  constructor(code: RuntimeTransportErrorCode) {
    super(`Runtime transport failed: ${code}`);
    this.name = 'RuntimeTransportError';
    this.code = code;
  }
}

export interface RuntimeFrameConnection {
  readFrame(deadlineMs: number): Promise<Record<string, unknown>>;
  writeFrame(frame: Record<string, unknown>, deadlineMs: number): Promise<void>;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface RuntimeTransportListener {
  close(): Promise<void>;
}

export interface RuntimeLocalTransport {
  connect(endpoint: RuntimeLocalEndpoint, deadlineMs: number): Promise<RuntimeFrameConnection>;
  listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener>;
}

export interface NodeLocalRuntimeTransportOptions {
  readonly chmod?: (filePath: string, mode: number) => Promise<void>;
  readonly lstat?: (filePath: string) => Promise<fs.Stats>;
}

interface PendingRead {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: RuntimeTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class NodeRuntimeFrameConnection implements RuntimeFrameConnection {
  private readonly decoder = new RuntimeFrameDecoder();
  private readonly queued: Record<string, unknown>[] = [];
  private readonly closeListeners = new Set<() => void>();
  private pendingRead: PendingRead | null = null;
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.receive(chunk));
    socket.once('close', () => this.finishClose());
    socket.once('error', () => this.finishClose());
  }

  readFrame(deadlineMs: number): Promise<Record<string, unknown>> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new RuntimeTransportError('closed'));
    if (this.pendingRead) return Promise.reject(new RuntimeTransportError('protocol'));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRead || this.pendingRead.timer !== timer) return;
        this.pendingRead = null;
        reject(new RuntimeTransportError('deadline'));
      }, boundedDeadline(deadlineMs));
      this.pendingRead = { resolve, reject, timer };
    });
  }

  writeFrame(frame: Record<string, unknown>, deadlineMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new RuntimeTransportError('closed'));
    let encoded: Buffer;
    try {
      encoded = encodeRuntimeFrame(frame);
    } catch (error) {
      if (error instanceof RuntimeFrameError) {
        return Promise.reject(new RuntimeTransportError('protocol'));
      }
      return Promise.reject(new RuntimeTransportError('closed'));
    }

    return new Promise((resolve, reject) => {
      const complete = createTimeoutSettlement(boundedDeadline(deadlineMs), () => {
        this.socket.destroy();
        this.finishClose();
        reject(new RuntimeTransportError('deadline'));
      });
      this.socket.write(encoded, (error?: Error | null) => {
        complete(() => {
          if (error) reject(new RuntimeTransportError('closed'));
          else resolve();
        });
      });
    });
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.socket.destroy();
    this.finishClose();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    let frames: readonly Record<string, unknown>[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.socket.destroy();
      this.failPending(new RuntimeTransportError('protocol'));
      this.finishClose();
      return;
    }
    for (const frame of frames) {
      this.deliver(frame);
    }
  }

  private deliver(frame: Record<string, unknown>): void {
    const pending = this.pendingRead;
    if (!pending) {
      this.queued.push(frame);
      return;
    }
    this.pendingRead = null;
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new RuntimeTransportError('closed'));
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }

  private failPending(error: RuntimeTransportError): void {
    const pending = this.pendingRead;
    if (!pending) return;
    this.pendingRead = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

export class NodeLocalRuntimeTransport implements RuntimeLocalTransport {
  constructor(private readonly options: NodeLocalRuntimeTransportOptions = {}) {}

  connect(endpoint: RuntimeLocalEndpoint, deadlineMs: number): Promise<RuntimeFrameConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: endpoint.address });
      const complete = createTimeoutSettlement(boundedDeadline(deadlineMs), () =>
        finishConnection(new RuntimeTransportError('deadline')),
      );
      const finish = (error?: RuntimeTransportError): void => {
        complete(() => finishConnection(error));
      };
      const connected = (): void => finish();
      const failed = (error: NodeJS.ErrnoException): void =>
        finish(
          new RuntimeTransportError(
            error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
              ? 'endpoint-unavailable'
              : 'connect-failed',
          ),
        );
      const finishConnection = (error?: RuntimeTransportError): void => {
        socket.removeListener('connect', connected);
        socket.removeListener('error', failed);
        if (!error) return resolve(new NodeRuntimeFrameConnection(socket));
        socket.destroy();
        reject(error);
      };
      socket.once('connect', connected);
      socket.once('error', failed);
    });
  }

  async listen(
    endpoint: RuntimeLocalEndpoint,
    onConnection: (connection: RuntimeFrameConnection) => Promise<void>,
  ): Promise<RuntimeTransportListener> {
    if (endpoint.kind === 'unix') {
      await fs.promises.mkdir(path.dirname(endpoint.address), { recursive: true, mode: 0o700 });
      await verifyPrivateDirectory(path.dirname(endpoint.address));
      await removeOwnedStaleSocket(endpoint.address);
    }
    const server = net.createServer((socket) => {
      const connection = new NodeRuntimeFrameConnection(socket);
      void onConnection(connection).catch(() => connection.close());
    });

    await listen(server, endpoint);
    let identity: SocketIdentity | null = null;
    if (endpoint.kind !== 'unix') {
      return new NodeRuntimeTransportListener(server, endpoint, identity);
    }
    try {
      const lstat = this.options.lstat ?? fs.promises.lstat;
      const chmod = this.options.chmod ?? fs.promises.chmod;
      identity = socketIdentity(await lstat(endpoint.address));
      await chmod(endpoint.address, 0o600);
    } catch {
      await closeBoundServer(server);
      if (identity) await unlinkIfOwned(endpoint.address, identity);
      throw new RuntimeTransportError('connect-failed');
    }
    return new NodeRuntimeTransportListener(server, endpoint, identity);
  }
}

function closeBoundServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

class NodeRuntimeTransportListener implements RuntimeTransportListener {
  private closed = false;

  constructor(
    private readonly server: net.Server,
    private readonly endpoint: RuntimeLocalEndpoint,
    private readonly identity: SocketIdentity | null,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.endpoint.kind === 'unix' && this.identity) {
      await unlinkIfOwned(this.endpoint.address, this.identity);
    }
  }
}

function listen(server: net.Server, endpoint: RuntimeLocalEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (): void => {
      server.removeListener('listening', ready);
      reject(new RuntimeTransportError('connect-failed'));
    };
    const ready = (): void => {
      server.removeListener('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen({
      path: endpoint.address,
      readableAll: false,
      writableAll: false,
    });
  });
}

function boundedDeadline(deadlineMs: number): number {
  return Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs) : 1;
}

interface SocketIdentity {
  readonly device: number;
  readonly inode: number;
}

async function verifyPrivateDirectory(directoryPath: string): Promise<void> {
  const stats = await fs.promises.lstat(directoryPath);
  const currentUser = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (currentUser !== undefined && stats.uid !== currentUser)
  ) {
    throw new RuntimeTransportError('connect-failed');
  }
}

async function removeOwnedStaleSocket(socketPath: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw new RuntimeTransportError('connect-failed');
  }
  const currentUser = process.getuid?.();
  if (
    !stats.isSocket() ||
    stats.isSymbolicLink() ||
    (currentUser !== undefined && stats.uid !== currentUser)
  ) {
    throw new RuntimeTransportError('connect-failed');
  }
  if (await socketIsReachable(socketPath)) throw new RuntimeTransportError('connect-failed');
  await unlinkIfOwned(socketPath, socketIdentity(stats));
}

function socketIsReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const complete = createTimeoutSettlement(100, () => finish(true));
    const finish = (result: boolean, error?: RuntimeTransportError): void =>
      complete(() => {
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      });
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
      else finish(false, new RuntimeTransportError('connect-failed'));
    });
  });
}

function createTimeoutSettlement(
  timeoutMs: number,
  onTimeout: () => void,
): (effect: () => void) => void {
  let settled = false;
  const complete = (effect: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    effect();
  };
  const timer = setTimeout(() => complete(onTimeout), timeoutMs);
  return complete;
}

async function unlinkIfOwned(socketPath: string, expected: SocketIdentity): Promise<void> {
  try {
    const current = socketIdentity(await fs.promises.lstat(socketPath));
    if (current.device === expected.device && current.inode === expected.inode) {
      await fs.promises.unlink(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw new RuntimeTransportError('connect-failed');
    }
  }
}

function socketIdentity(stats: fs.Stats): SocketIdentity {
  return { device: stats.dev, inode: stats.ino };
}

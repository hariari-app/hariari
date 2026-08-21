import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

// Lazy-load electron-updater so dev mode never crashes on missing native deps
type AutoUpdater = typeof import('electron-updater').autoUpdater;
export type AutoUpdaterPort = Pick<
  AutoUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'autoRunAppAfterInstall'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'on'
  | 'quitAndInstall'
  | 'removeAllListeners'
>;

let cachedAutoUpdater: AutoUpdater | undefined;

function getAutoUpdater(): AutoUpdater {
  if (cachedAutoUpdater) return cachedAutoUpdater;

  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  cachedAutoUpdater = autoUpdater;
  return autoUpdater;
}

export type UpdateState =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'manual-available'
  | 'error';

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly version?: string;
  readonly progress?: number;
  readonly error?: string;
  readonly downloadUrl?: string;
}

/** On Linux, auto-update only works for AppImage. Detect non-AppImage installs. */
function isLinuxNonAppImage(): boolean {
  return process.platform === 'linux' && !process.env.APPIMAGE;
}

const CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export class AutoUpdateManager {
  private window: BrowserWindow | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private currentStatus: UpdateStatus = { state: 'not-available' };
  private isChecking = false;
  private installTriggered = false;
  private updater: AutoUpdaterPort | undefined;

  constructor(
    private readonly prepareForInstall: () => Promise<void>,
    updater?: AutoUpdaterPort,
  ) {
    this.updater = updater;
    // Don't run in dev mode — electron-updater requires a packaged app
    if (!app.isPackaged) {
      console.log('[AutoUpdater] Skipping — app is not packaged (dev mode)');
      return;
    }

    this.configureUpdater();
    this.registerEvents();
    this.registerIpcHandlers();
  }

  /** Call after the main window is created. Starts the check schedule. */
  start(mainWindow: BrowserWindow): void {
    this.window = mainWindow;

    if (!app.isPackaged) return;

    // Initial check after a short delay (don't compete with app startup)
    setTimeout(() => {
      this.checkForUpdates();
    }, CHECK_DELAY_MS);

    // Periodic checks
    this.intervalId = setInterval(() => {
      this.checkForUpdates();
    }, CHECK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Remove IPC handlers so they can be re-registered on reload
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_CHECK);
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_DOWNLOAD);
    ipcMain.removeHandler(IPC_CHANNELS.UPDATE_INSTALL);
    // Remove autoUpdater event listeners to prevent stacking on reload
    if (app.isPackaged) this.getUpdater().removeAllListeners();
  }

  private readonly manualUpdateOnly = isLinuxNonAppImage();

  private configureUpdater(): void {
    // Non-AppImage Linux installs can't auto-update — only check for new versions
    this.getUpdater().autoDownload = !this.manualUpdateOnly;
    // Installation must use the guarded IPC path so Runtime stops before Desktop quits.
    this.getUpdater().autoInstallOnAppQuit = false;
    this.getUpdater().autoRunAppAfterInstall = true;
  }

  private registerEvents(): void {
    this.getUpdater().on('checking-for-update', () => {
      this.sendStatus({ state: 'checking' });
    });

    this.getUpdater().on('update-available', (info: { version: string }) => {
      if (this.manualUpdateOnly) {
        // Non-AppImage Linux: direct user to download from GitHub
        const downloadUrl = `https://github.com/hariari-app/hariari/releases/tag/v${info.version}`;
        this.sendStatus({
          state: 'manual-available',
          version: info.version,
          downloadUrl,
        });
        return;
      }
      this.sendStatus({
        state: 'available',
        version: info.version,
      });
    });

    this.getUpdater().on('update-not-available', () => {
      this.sendStatus({ state: 'not-available' });
    });

    this.getUpdater().on('download-progress', (progress: { percent: number }) => {
      this.sendStatus({
        state: 'downloading',
        progress: Math.round(progress.percent),
      });
    });

    this.getUpdater().on('update-downloaded', (info: { version: string }) => {
      this.sendStatus({
        state: 'downloaded',
        version: info.version,
      });
    });

    this.getUpdater().on('error', (err: Error) => {
      console.error('[AutoUpdater] Error:', err.message);
      // Sanitize error — don't expose internal paths or API responses to renderer
      const safeError = err.message.includes('net::')
        ? 'Network error — check your internet connection'
        : err.message.includes('403')
          ? 'GitHub rate limit reached — try again later'
          : 'Update check failed';
      this.sendStatus({
        state: 'error',
        error: safeError,
      });
    });
  }

  private registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
      await this.checkForUpdates();
      return { ok: true };
    });

    ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
      if (this.currentStatus.state === 'downloading') {
        return { ok: false, error: 'Download already in progress' };
      }
      try {
        await this.getUpdater().downloadUpdate();
        return { ok: true };
      } catch (err) {
        console.error('[AutoUpdater] Download failed:', err);
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, async () => this.installUpdate());
  }

  private async installUpdate(): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (this.currentStatus.state !== 'downloaded') {
      return { ok: false, error: 'No update downloaded' };
    }
    if (this.installTriggered) return { ok: false, error: 'Install already triggered' };
    this.installTriggered = true;
    try {
      await this.prepareForInstall();
    } catch (error) {
      this.installTriggered = false;
      console.error('[AutoUpdater] Runtime shutdown preparation failed:', error);
      return { ok: false, error: 'Unable to prepare update installation — try again' };
    }
    this.getUpdater().quitAndInstall(false, true);
    return { ok: true };
  }

  private async checkForUpdates(): Promise<void> {
    if (this.isChecking) return;
    // Don't re-check while a download is active or update is ready to install
    if (this.currentStatus.state === 'downloading' || this.currentStatus.state === 'downloaded')
      return;
    this.isChecking = true;
    try {
      await this.getUpdater().checkForUpdates();
    } catch (err) {
      console.warn('[AutoUpdater] Check failed:', (err as Error).message);
    } finally {
      this.isChecking = false;
    }
  }

  private sendStatus(status: UpdateStatus): void {
    this.currentStatus = status;
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status);
    }
  }

  private getUpdater(): AutoUpdaterPort {
    this.updater ??= getAutoUpdater();
    return this.updater;
  }
}

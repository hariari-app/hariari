import { autoUpdater } from 'electron-updater';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';

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

  constructor() {
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
    autoUpdater.removeAllListeners();
  }

  private readonly manualUpdateOnly = isLinuxNonAppImage();

  private configureUpdater(): void {
    // Non-AppImage Linux installs can't auto-update — only check for new versions
    autoUpdater.autoDownload = !this.manualUpdateOnly;
    autoUpdater.autoInstallOnAppQuit = !this.manualUpdateOnly;
    autoUpdater.autoRunAppAfterInstall = true;
  }

  private registerEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.sendStatus({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      if (this.manualUpdateOnly) {
        // Non-AppImage Linux: direct user to download from GitHub
        const downloadUrl = `https://github.com/vibeide-app/vibeide/releases/tag/v${info.version}`;
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

    autoUpdater.on('update-not-available', () => {
      this.sendStatus({ state: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.sendStatus({
        state: 'downloading',
        progress: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.sendStatus({
        state: 'downloaded',
        version: info.version,
      });
    });

    autoUpdater.on('error', (err) => {
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
        await autoUpdater.downloadUpdate();
        return { ok: true };
      } catch (err) {
        console.error('[AutoUpdater] Download failed:', err);
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
      if (this.currentStatus.state !== 'downloaded') {
        return { ok: false, error: 'No update downloaded' };
      }
      if (this.installTriggered) {
        return { ok: false, error: 'Install already triggered' };
      }
      this.installTriggered = true;
      autoUpdater.quitAndInstall(false, true);
    });
  }

  private async checkForUpdates(): Promise<void> {
    if (this.isChecking) return;
    // Don't re-check while a download is active or update is ready to install
    if (this.currentStatus.state === 'downloading' || this.currentStatus.state === 'downloaded') return;
    this.isChecking = true;
    try {
      await autoUpdater.checkForUpdates();
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
}

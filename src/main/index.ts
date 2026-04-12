import { app, session, type BrowserWindow } from 'electron';
import { createMainWindow } from './window/main-window';
import { PtyManager } from './pty/pty-manager';
import { AgentManager } from './agent/agent-manager';
import { ProjectManager } from './project/project-manager';
import { NotificationManager } from './notification/notification-manager';
import { registerIpcHandlers } from './ipc/handlers';
import { StateManager } from './state/state-manager';
import { AutoUpdateManager } from './updater/auto-updater';

let ptyManager: PtyManager;
let agentManager: AgentManager;
let stateManager: StateManager;
let projectManager: ProjectManager;
let notificationManager: NotificationManager;
let autoUpdateManager: AutoUpdateManager;

// These imports must be at top-level for early IPC handler registration
const { ipcMain: earlyIpcMain } = require('electron');
const earlyFs = require('node:fs');
const earlyPath = require('node:path');
const earlyOs = require('node:os');

// Register settings/keybinding handlers IMMEDIATELY at module load —
// before app.whenReady() — because the renderer may request them on first paint.
console.log('[EARLY] Registering keybindings:load handler');
try { earlyIpcMain.removeHandler('keybindings:load'); } catch { /* */ }
try { earlyIpcMain.removeHandler('keybindings:save'); } catch { /* */ }
try { earlyIpcMain.removeHandler('settings:load'); } catch { /* */ }
try { earlyIpcMain.removeHandler('settings:save'); } catch { /* */ }
earlyIpcMain.handle('keybindings:load', () => {
  try {
    const filePath = earlyPath.join(earlyOs.homedir(), '.hariari', 'keybindings.json');
    if (!earlyFs.existsSync(filePath)) return {};
    const raw = earlyFs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
});

earlyIpcMain.handle('keybindings:save', (_event: unknown, raw: unknown) => {
  try {
    if (typeof raw !== 'object' || raw === null) return;
    const dir = earlyPath.join(earlyOs.homedir(), '.hariari');
    earlyFs.mkdirSync(dir, { recursive: true });
    earlyFs.writeFileSync(earlyPath.join(dir, 'keybindings.json'), JSON.stringify(raw, null, 2), 'utf-8');
  } catch { /* */ }
});

earlyIpcMain.handle('settings:load', () => {
  try {
    const filePath = earlyPath.join(earlyOs.homedir(), '.hariari', 'settings.json');
    if (!earlyFs.existsSync(filePath)) return {};
    const raw = earlyFs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
});

earlyIpcMain.handle('settings:save', (_event: unknown, raw: unknown) => {
  try {
    if (typeof raw !== 'object' || raw === null) return;
    const dir = earlyPath.join(earlyOs.homedir(), '.hariari');
    earlyFs.mkdirSync(dir, { recursive: true });
    earlyFs.writeFileSync(earlyPath.join(dir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8');
  } catch { /* */ }
});

// Window controls (for custom title bar)
earlyIpcMain.handle('window:minimize', (event: { sender: { getOwnerBrowserWindow: () => { minimize: () => void } | null } }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) win.minimize();
});
earlyIpcMain.handle('window:maximize', (event: { sender: { getOwnerBrowserWindow: () => { isMaximized: () => boolean; maximize: () => void; unmaximize: () => void } | null } }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});
earlyIpcMain.handle('window:close', (event: { sender: { getOwnerBrowserWindow: () => { close: () => void } | null } }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) win.close();
});

// Zoom controls — use Electron's zoom level to scale everything
earlyIpcMain.handle('window:zoom-in', (event: { sender: unknown }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) {
    const current = win.webContents.getZoomLevel();
    win.webContents.setZoomLevel(Math.min(current + 0.5, 5));
  }
});
earlyIpcMain.handle('window:zoom-out', (event: { sender: unknown }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) {
    const current = win.webContents.getZoomLevel();
    win.webContents.setZoomLevel(Math.max(current - 0.5, -3));
  }
});
earlyIpcMain.handle('window:zoom-reset', (event: { sender: unknown }) => {
  const { BrowserWindow: BW } = require('electron');
  const win = BW.fromWebContents(event.sender);
  if (win) {
    win.webContents.setZoomLevel(0);
  }
});

// Open external URL in the user's default browser
earlyIpcMain.handle('shell:open-external', (_event: unknown, url: string) => {
  // Only allow https URLs to prevent shell injection
  if (typeof url !== 'string' || !url.startsWith('https://')) return;
  const { shell } = require('electron');
  shell.openExternal(url);
});

// Clipboard IPC — reliable clipboard access from renderer
earlyIpcMain.handle('clipboard:read', () => {
  const { clipboard } = require('electron');
  return clipboard.readText();
});

earlyIpcMain.handle('clipboard:read-image', async () => {
  const { clipboard, app } = require('electron');
  const path = require('path');
  const fs = require('fs/promises');
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  // Guard against excessively large images (max 8K resolution)
  const size = image.getSize();
  if (size.width * size.height > 7680 * 4320) return null;
  const png = image.toPNG();
  const dir = path.join(app.getPath('temp'), 'hariari-clipboard');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `screenshot-${Date.now()}.png`);
  await fs.writeFile(filePath, png);
  // Clean up old files (keep last 10)
  try {
    const files = (await fs.readdir(dir)).sort();
    if (files.length > 10) {
      for (const f of files.slice(0, files.length - 10)) {
        await fs.unlink(path.join(dir, f)).catch(() => {});
      }
    }
  } catch { /* cleanup is best-effort */ }
  // Return forward-slash path for POSIX shell compatibility
  return filePath.replace(/\\/g, '/');
});

earlyIpcMain.handle('clipboard:write', (_event: unknown, text: unknown) => {
  if (typeof text !== 'string' || text.length > 10 * 1024 * 1024) return;
  const { clipboard } = require('electron');
  clipboard.writeText(text);
});

// Pop-out file viewer in a new window
earlyIpcMain.handle('window:popout-file', async (_event: unknown, args: { projectPath: string; filePath?: string }) => {
  const { BrowserWindow: BW } = require('electron');
  const nodePath = require('node:path');

  const projectName = nodePath.basename(args.projectPath);

  const popout = new BW({
    width: 1000,
    height: 750,
    title: `${projectName} — File Viewer — Hariari`,
    webPreferences: {
      preload: nodePath.join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  // Load the same renderer URL with popout query params
  const mainWindow = BW.getAllWindows().find((w: { id: number }) => w.id !== popout.id);
  if (mainWindow) {
    const url = mainWindow.webContents.getURL();
    const baseUrl = url.split('?')[0].split('#')[0];
    const params = new URLSearchParams({
      popout: 'file-viewer',
      project: args.projectPath,
      ...(args.filePath ? { file: args.filePath } : {}),
    });
    popout.loadURL(`${baseUrl}?${params.toString()}`);
  }

  popout.setMenuBarVisibility(false);
});

// Editor windows — keyed by root path so each worktree gets its own window
const editorWindows = new Map<string, InstanceType<typeof import('electron').BrowserWindow>>();

earlyIpcMain.handle('window:popout-editor', async (_event: unknown, raw: unknown) => {
  try {
    if (typeof raw !== 'object' || raw === null) return { error: 'popout_editor_invalid_request' };
    const args = raw as { projectPath?: string; branchName?: string };
    if (typeof args.projectPath !== 'string' || !args.projectPath) return { error: 'popout_editor_missing_path' };

    const { BrowserWindow: BW } = require('electron');
    const nodePath = require('node:path');

    const rootPath = args.projectPath;

    // Focus existing window for this path if still open
    const existing = editorWindows.get(rootPath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { ok: true };
    }

    const projectName = nodePath.basename(rootPath);
    const branchLabel = args.branchName ? ` [${args.branchName}]` : '';

    const win = new BW({
      width: 1200,
      height: 800,
      minWidth: 600,
      minHeight: 400,
      title: `${projectName}${branchLabel} — Hariari`,
      // Match the main window's frameless chrome so both windows share
      // the same title-bar design language. The editor window's
      // .ew-titlebar element (see editor-window-app.ts) takes over
      // title/drag/controls, and on macOS the native traffic lights
      // render on the left via trafficLightPosition below.
      frame: false,
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin' ? {
        trafficLightPosition: { x: 13, y: 10 },
      } : {}),
      webPreferences: {
        preload: nodePath.join(__dirname, '../preload/index.js'),
        sandbox: false,
      },
    });

    editorWindows.set(rootPath, win);

    const mainWindow = BW.getAllWindows().find((w: { id: number }) => w.id !== win.id);
    if (!mainWindow) {
      win.close();
      editorWindows.delete(rootPath);
      return { error: 'popout_editor_no_main_window' };
    }

    const url = mainWindow.webContents.getURL();
    const baseUrl = url.split('?')[0].split('#')[0];
    const params = new URLSearchParams({
      popout: 'editor-window',
      project: rootPath,
    });
    if (args.branchName) {
      params.set('branch', args.branchName);
    }
    win.loadURL(`${baseUrl}?${params.toString()}`);
    win.setMenuBarVisibility(false);
    win.on('closed', () => { editorWindows.delete(rootPath); });
  } catch (error) {
    console.error('[IPC][window:popout-editor]', error);
    return { error: 'popout_editor_failed' };
  }
});

// Enable speech recognition on Linux
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');
// Disable SUID sandbox for environments where chrome-sandbox is not setuid root
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => {
  // Set CSP via response headers (more authoritative than <meta> tag)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.google.com https://*.googleapis.com wss://*.google.com https://api.openai.com https://api.deepgram.com https://api.groq.com; img-src 'self' data:; font-src 'self'; media-src 'self' mediastream:; frame-ancestors 'none'",
        ],
      },
    });
  });

  // Allow microphone, speech, and clipboard access
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'speech', 'microphone', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    callback(allowedPermissions.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowedPermissions = ['media', 'audioCapture', 'speech', 'microphone', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    return allowedPermissions.includes(permission);
  });

  stateManager = new StateManager();
  const savedState = stateManager.loadState();

  ptyManager = new PtyManager();
  projectManager = new ProjectManager();
  notificationManager = new NotificationManager();

  // Create AgentManager with a deferred sendToRenderer (window doesn't exist yet)
  let mainWindow: Electron.BrowserWindow | null = null;
  agentManager = new AgentManager(ptyManager, (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  });

  // Register IPC handlers BEFORE creating window so renderer can call them immediately
  registerIpcHandlers(agentManager, ptyManager, stateManager, projectManager, notificationManager);

  // Now create the window — renderer will load and IPC handlers are ready
  mainWindow = createMainWindow(savedState?.window);

  // Auto-updater — checks GitHub Releases for new versions
  autoUpdateManager = new AutoUpdateManager();
  autoUpdateManager.start(mainWindow);

  // Ctrl+Shift+V: intercept before Chromium's native "paste as plain text"
  // handler consumes it. before-input-event fires before any renderer JS or
  // Chromium default handlers. We preventDefault and push our own IPC instead.
  // Note: input.key is uppercase 'V' when Shift is held — match both cases.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      (input.key === 'V' || input.key === 'v')
    ) {
      event.preventDefault();
      mainWindow!.webContents.send('clipboard:trigger-paste');
    }
  });

  // Save window bounds on before-quit
  app.on('before-quit', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const bounds = mainWindow.getBounds();
        const isMaximized = mainWindow.isMaximized();
        const previousState = stateManager.loadState();

        const windowState = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized,
        };

        // Save window bounds; layout and agents are saved by the renderer
        stateManager.saveState({
          window: windowState,
          activeProjectId: previousState?.activeProjectId ?? null,
          sidebarCollapsed: previousState?.sidebarCollapsed ?? false,
          layout: previousState?.layout ?? null,
          agents: previousState?.agents ?? [],
        });
      }
    } catch (error) {
      console.error('[Main] Failed to save window state on quit:', error);
    }

    autoUpdateManager?.dispose();
    agentManager?.disposeAll();
    ptyManager?.disposeAll();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

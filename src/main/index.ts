import { app, session, type BrowserWindow } from 'electron';
import { createMainWindow } from './window/main-window';
import { PtyManager } from './pty/pty-manager';
import { AgentManager } from './agent/agent-manager';
import { ProjectManager } from './project/project-manager';
import { NotificationManager } from './notification/notification-manager';
import { registerIpcHandlers } from './ipc/handlers';
import { StateManager } from './state/state-manager';

let ptyManager: PtyManager;
let agentManager: AgentManager;
let stateManager: StateManager;
let projectManager: ProjectManager;
let notificationManager: NotificationManager;

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
    const filePath = earlyPath.join(earlyOs.homedir(), '.vibeide', 'keybindings.json');
    if (!earlyFs.existsSync(filePath)) return {};
    const raw = earlyFs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
});

earlyIpcMain.handle('keybindings:save', (_event: unknown, raw: unknown) => {
  try {
    if (typeof raw !== 'object' || raw === null) return;
    const dir = earlyPath.join(earlyOs.homedir(), '.vibeide');
    earlyFs.mkdirSync(dir, { recursive: true });
    earlyFs.writeFileSync(earlyPath.join(dir, 'keybindings.json'), JSON.stringify(raw, null, 2), 'utf-8');
  } catch { /* */ }
});

earlyIpcMain.handle('settings:load', () => {
  try {
    const filePath = earlyPath.join(earlyOs.homedir(), '.vibeide', 'settings.json');
    if (!earlyFs.existsSync(filePath)) return {};
    const raw = earlyFs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
});

earlyIpcMain.handle('settings:save', (_event: unknown, raw: unknown) => {
  try {
    if (typeof raw !== 'object' || raw === null) return;
    const dir = earlyPath.join(earlyOs.homedir(), '.vibeide');
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

// Pop-out file viewer in a new window
earlyIpcMain.handle('window:popout-file', async (_event: unknown, args: { filePath: string; content: string }) => {
  const { BrowserWindow: BW } = require('electron');
  const nodePath = require('node:path');
  const fileName = nodePath.basename(args.filePath);
  const escaped = args.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${fileName} — VibeIDE</title>
<style>
  body { margin: 0; background: #1a1b26; color: #c0caf5; font-family: 'JetBrains Mono', 'Cascadia Code', monospace; font-size: 13px; }
  .header { padding: 8px 16px; background: #16161e; border-bottom: 1px solid #2a2b3d; font-size: 12px; color: #737aa2; display: flex; justify-content: space-between; }
  .path { color: #7aa2f7; }
  pre { margin: 0; padding: 16px; overflow: auto; line-height: 1.6; tab-size: 4; white-space: pre; }
  .line-num { display: inline-block; width: 48px; text-align: right; color: #414868; margin-right: 16px; user-select: none; }
</style></head><body>
<div class="header"><span class="path">${args.filePath}</span><span>${escaped.split('\n').length} lines</span></div>
<pre>${escaped.split('\n').map((line, i) => `<span class="line-num">${i + 1}</span>${line}`).join('\n')}</pre>
</body></html>`;

  const popout = new BW({
    width: 900,
    height: 700,
    title: `${fileName} — VibeIDE`,
  });

  popout.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  popout.setMenuBarVisibility(false);
});

// Enable speech recognition on Linux
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI');

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

    agentManager?.disposeAll();
    ptyManager?.disposeAll();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

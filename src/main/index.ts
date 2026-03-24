import { app, session } from 'electron';
import { createMainWindow } from './window/main-window';
import { PtyManager } from './pty/pty-manager';
import { AgentManager } from './agent/agent-manager';
import { registerIpcHandlers } from './ipc/handlers';

let ptyManager: PtyManager;
let agentManager: AgentManager;

app.whenReady().then(() => {
  // Set CSP via response headers (more authoritative than <meta> tag)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'",
        ],
      },
    });
  });

  ptyManager = new PtyManager();
  const mainWindow = createMainWindow();

  agentManager = new AgentManager(ptyManager, (channel, ...args) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  });

  registerIpcHandlers(agentManager, ptyManager);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  agentManager?.disposeAll();
  ptyManager?.disposeAll();
});

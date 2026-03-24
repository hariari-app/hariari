import { app, session } from 'electron';
import { createMainWindow } from './window/main-window';
import { PtyManager } from './pty/pty-manager';
import { AgentManager } from './agent/agent-manager';
import { registerIpcHandlers } from './ipc/handlers';
import { StateManager } from './state/state-manager';

let ptyManager: PtyManager;
let agentManager: AgentManager;
let stateManager: StateManager;

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

  stateManager = new StateManager();
  const savedState = stateManager.loadState();

  ptyManager = new PtyManager();
  const mainWindow = createMainWindow(savedState?.window);

  agentManager = new AgentManager(ptyManager, (channel, ...args) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  });

  registerIpcHandlers(agentManager, ptyManager, stateManager);

  // Save window bounds on before-quit
  app.on('before-quit', () => {
    try {
      if (!mainWindow.isDestroyed()) {
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

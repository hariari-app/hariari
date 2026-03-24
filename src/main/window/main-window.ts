import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

export interface SavedWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

function areBoundsVisible(bounds: SavedWindowBounds): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    // Check that at least part of the window is within this display
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    );
  });
}

export function createMainWindow(savedBounds?: SavedWindowBounds): BrowserWindow {
  const useSaved = savedBounds && areBoundsVisible(savedBounds);

  const mainWindow = new BrowserWindow({
    width: useSaved ? savedBounds.width : 1400,
    height: useSaved ? savedBounds.height : 900,
    ...(useSaved ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1b26',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  if (useSaved && savedBounds.isMaximized) {
    mainWindow.maximize();
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('ELECTRON_RENDERER_URL must point to localhost');
    }
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Prevent navigation away from the app origin
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsed = new URL(navigationUrl);
    if (parsed.protocol !== 'file:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      event.preventDefault();
    }
  });

  // Block popup windows
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return mainWindow;
}

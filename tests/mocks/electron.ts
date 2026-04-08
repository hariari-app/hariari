import { vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

export const app = {
  getPath: vi.fn((name: string) => {
    if (name === 'home') return os.homedir();
    if (name === 'userData') return path.join(os.tmpdir(), 'hariari-test');
    return os.tmpdir();
  }),
  getName: vi.fn(() => 'hariari'),
  getVersion: vi.fn(() => '0.1.0'),
  quit: vi.fn(),
  on: vi.fn(),
  whenReady: vi.fn().mockResolvedValue(undefined),
};

export const ipcMain = {
  on: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
};

export const BrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  webContents: {
    send: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
  },
  getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
  setBounds: vi.fn(),
  isMaximized: vi.fn(() => false),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
}));

export default {
  app,
  ipcMain,
  BrowserWindow,
};

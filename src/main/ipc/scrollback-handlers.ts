import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { deleteScrollback, loadScrollback, saveScrollback } from '../scrollback-store';

export function registerScrollbackHandlers(): void {
  registerScrollbackSaveHandler();
  registerScrollbackLoadHandler();
  registerScrollbackDeleteHandler();
}

function registerScrollbackSaveHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_SAVE, (_event, raw: unknown) => handleScrollbackSave(raw));
}

async function handleScrollbackSave(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const request = raw as { sessionId: string; data: string };
  if (typeof request.sessionId !== 'string' || typeof request.data !== 'string') return;
  await saveScrollback(request.sessionId, request.data);
}

function registerScrollbackLoadHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_LOAD, (_event, sessionId: unknown) =>
    handleScrollbackLoad(sessionId),
  );
}

function handleScrollbackLoad(sessionId: unknown): Promise<string | null> | null {
  return typeof sessionId === 'string' ? loadScrollback(sessionId) : null;
}

function registerScrollbackDeleteHandler(): void {
  ipcMain.handle(IPC_CHANNELS.SCROLLBACK_DELETE, (_event, sessionId: unknown) =>
    handleScrollbackDelete(sessionId),
  );
}

async function handleScrollbackDelete(sessionId: unknown): Promise<void> {
  if (typeof sessionId !== 'string') return;
  await deleteScrollback(sessionId);
}

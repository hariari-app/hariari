import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { StateManager } from '../state/state-manager';

export function registerStateHandlers(stateManager: StateManager): void {
  registerStateLoadHandler(stateManager);
  registerStateSaveHandler(stateManager);
}

function registerStateLoadHandler(stateManager: StateManager): void {
  ipcMain.handle(IPC_CHANNELS.STATE_LOAD, () => handleStateLoad(stateManager));
}

function handleStateLoad(stateManager: StateManager): unknown {
  try {
    return stateManager.loadState();
  } catch (error) {
    console.error('[IPC][state:load]', error);
    return null;
  }
}

function registerStateSaveHandler(stateManager: StateManager): void {
  ipcMain.handle(IPC_CHANNELS.STATE_SAVE, (_event, raw: unknown) =>
    handleStateSave(stateManager, raw),
  );
}

function handleStateSave(stateManager: StateManager, raw: unknown): unknown {
  try {
    const validated = stateManager.validateAndParse(raw);
    if (!validated) return { error: 'invalid_state' };
    stateManager.saveState(validated);
  } catch (error) {
    console.error('[IPC][state:save]', error);
    return { error: 'state_save_failed' };
  }
}

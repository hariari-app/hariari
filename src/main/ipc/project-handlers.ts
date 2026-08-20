import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { ProjectManager } from '../project/project-manager';
import type { StateManager } from '../state/state-manager';
import {
  validateProjectCreateRequest,
  validateProjectId,
  validateProjectUpdateRequest,
  validateProjectWorkspaceState,
} from './validators';

export function registerProjectHandlers(
  projectManager: ProjectManager,
  stateManager: StateManager,
): void {
  registerProjectListHandler(projectManager);
  registerProjectCreateHandler(projectManager);
  registerProjectRemoveHandler(projectManager);
  registerProjectUpdateHandler(projectManager);
  registerProjectPickDirHandler();
  registerProjectStateLoadHandler(stateManager);
  registerProjectStateSaveHandler(stateManager);
}

function registerProjectListHandler(projectManager: ProjectManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => handleProjectList(projectManager));
}

function handleProjectList(projectManager: ProjectManager): unknown {
  try {
    return projectManager.listProjects();
  } catch (error) {
    console.error('[IPC][project:list]', error);
    return { error: 'project_list_failed' };
  }
}

function registerProjectCreateHandler(projectManager: ProjectManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_event, raw: unknown) =>
    handleProjectCreate(projectManager, raw),
  );
}

function handleProjectCreate(projectManager: ProjectManager, raw: unknown): unknown {
  try {
    const request = validateProjectCreateRequest(raw);
    return projectManager.createProject(request);
  } catch (error) {
    console.error('[IPC][project:create]', error);
    return { error: error instanceof Error ? error.message : 'project_create_failed' };
  }
}

function registerProjectRemoveHandler(projectManager: ProjectManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_REMOVE, (_event, raw: unknown) =>
    handleProjectRemove(projectManager, raw),
  );
}

function handleProjectRemove(projectManager: ProjectManager, raw: unknown): unknown {
  try {
    projectManager.removeProject(validateProjectId(raw));
  } catch (error) {
    console.error('[IPC][project:remove]', error);
    return { error: 'project_remove_failed' };
  }
}

function registerProjectUpdateHandler(projectManager: ProjectManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_event, raw: unknown) =>
    handleProjectUpdate(projectManager, raw),
  );
}

function handleProjectUpdate(projectManager: ProjectManager, raw: unknown): unknown {
  try {
    const request = validateProjectUpdateRequest(raw);
    return projectManager.updateProject(request);
  } catch (error) {
    console.error('[IPC][project:update]', error);
    return { error: 'project_update_failed' };
  }
}

function registerProjectPickDirHandler(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_PICK_DIR, (event) => handleProjectPickDir(event.sender));
}

async function handleProjectPickDir(sender: WebContents): Promise<string | null> {
  try {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Select Project Directory',
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  } catch (error) {
    console.error('[IPC][project:pick-dir]', error);
    return null;
  }
}

function registerProjectStateLoadHandler(stateManager: StateManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_STATE_LOAD, (_event, raw: unknown) =>
    handleProjectStateLoad(stateManager, raw),
  );
}

function handleProjectStateLoad(stateManager: StateManager, raw: unknown): unknown {
  try {
    return stateManager.loadProjectState(validateProjectId(raw));
  } catch (error) {
    console.error('[IPC][project:state:load]', error);
    return null;
  }
}

function registerProjectStateSaveHandler(stateManager: StateManager): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_STATE_SAVE, (_event, raw: unknown) =>
    handleProjectStateSave(stateManager, raw),
  );
}

function handleProjectStateSave(stateManager: StateManager, raw: unknown): unknown {
  try {
    const validated = validateProjectWorkspaceState(raw);
    if (!validated) return { error: 'invalid_project_state' };
    stateManager.saveProjectState(validated);
  } catch (error) {
    console.error('[IPC][project:state:save]', error);
    return { error: 'project_state_save_failed' };
  }
}

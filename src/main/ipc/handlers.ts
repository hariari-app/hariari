import type { AgentManager } from '../agent/agent-manager';
import { registerAgentHandlers } from './agent-handlers';
import { registerAgentInstallHandlers } from './agent-install-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerFileSearchHandlers } from './file-search-handlers';
import type { NotificationManager } from '../notification/notification-manager';
import { registerGitHandlers } from './git-handlers';
import { registerNotificationHandlers } from './notification-handlers';
import { registerOnboardingHandlers } from './onboarding-handlers';
import type { ProjectManager } from '../project/project-manager';
import { registerProjectHandlers } from './project-handlers';
import type { PtyManager } from '../pty/pty-manager';
import { registerPtyHandlers } from './pty-handlers';
import { registerScrollbackHandlers } from './scrollback-handlers';
import { registerSessionHandlers } from './session-handlers';
import { registerSkillsHandlers } from './skills-handlers';
import type { StateManager } from '../state/state-manager';
import { registerStateHandlers } from './state-handlers';
import { registerVoiceHandlers } from './voice-handlers';
import { registerWorktreeHandlers } from './worktree-handlers';

export function registerIpcHandlers(
  agentManager: AgentManager,
  ptyManager: PtyManager,
  stateManager: StateManager,
  projectManager: ProjectManager,
  notificationManager?: NotificationManager,
): void {
  registerPtyHandlers(agentManager, ptyManager);
  registerAgentHandlers(agentManager);
  registerSessionHandlers(agentManager);
  registerStateHandlers(stateManager);
  registerVoiceHandlers();
  registerProjectHandlers(projectManager, stateManager);
  registerFileHandlers();

  // NOTE: keybindings and settings handlers are registered early in index.ts
  // to avoid race conditions with the renderer.
  registerGitHandlers();
  registerFileSearchHandlers();
  registerNotificationHandlers(notificationManager);
  registerAgentInstallHandlers();
  registerSkillsHandlers();
  registerOnboardingHandlers();
  registerWorktreeHandlers(agentManager.getWorktreeManager());
  registerScrollbackHandlers();
}

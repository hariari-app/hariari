export const IPC_CHANNELS = {
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',
  AGENT_SPAWN: 'agent:spawn',
  AGENT_KILL: 'agent:kill',
  AGENT_LIST: 'agent:list',
  AGENT_STATUS: 'agent:status',
  AGENT_EXIT: 'agent:exit',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  STATE_SAVE: 'state:save',
  STATE_LOAD: 'state:load',
} as const;

export const FRAME_COALESCE_MS = 16;
export const DEFAULT_SCROLLBACK = 10_000;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;

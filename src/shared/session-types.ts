export interface SessionRecording {
  readonly agentId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly size: number;
}

// Internal type used only in main process — includes filePath
export interface SessionRecordingInternal extends SessionRecording {
  readonly filePath: string;
}

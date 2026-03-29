export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export type GitStageGroup = 'staged' | 'unstaged' | 'untracked';

export interface GitFileChange {
  readonly path: string;
  readonly status: GitFileStatus;
  readonly group: GitStageGroup;
  readonly oldPath?: string;
}

export interface GitStatusResult {
  readonly changes: readonly GitFileChange[];
  readonly branch: string;
  readonly isRepo: boolean;
}

export interface GitCommitRequest {
  readonly projectPath: string;
  readonly message: string;
  readonly amend?: boolean;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly shortHash: string;
  readonly message: string;
  readonly author: string;
  readonly date: string;
  readonly parentHashes: readonly string[];
  readonly refs: readonly string[];
}

export interface GitLogResult {
  readonly entries: readonly GitLogEntry[];
  readonly branchName: string;
}

export interface GitAheadBehind {
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
}

export interface GitDiffResult {
  readonly originalContent: string;
  readonly modifiedContent: string;
  readonly filePath: string;
  readonly isNewFile: boolean;
  readonly isDeleted: boolean;
  readonly isBinary: boolean;
}

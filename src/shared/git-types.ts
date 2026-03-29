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

export interface GitDiffResult {
  readonly originalContent: string;
  readonly modifiedContent: string;
  readonly filePath: string;
  readonly isNewFile: boolean;
  readonly isDeleted: boolean;
  readonly isBinary: boolean;
}

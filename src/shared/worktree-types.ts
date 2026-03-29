export interface WorktreeInfo {
  readonly agentId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly projectPath: string;
}

export interface WorktreeMergeResult {
  readonly success: boolean;
  readonly mergedBranch: string;
  readonly conflicts?: readonly string[];
  readonly error?: string;
}

export interface WorktreeDiffSummary {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly files: readonly WorktreeDiffFile[];
}

export interface WorktreeDiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly insertions: number;
  readonly deletions: number;
}

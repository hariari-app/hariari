import { oneDark } from '@codemirror/theme-one-dark';
import { isCurrentThemeLight } from '../terminal/terminal-theme';
import type { FileEntry } from '../../../shared/ipc-types';

// oneDark only applies on dark app themes. See editor-pane.ts for the
// same pattern — evaluated at editor-create time; a theme switch requires
// reopening the file to take effect.
export function syntaxThemeExtensions(): readonly [] | readonly [typeof oneDark] {
  return isCurrentThemeLight() ? [] : [oneDark];
}

export type ViewMode = 'files' | 'changes';

export interface FileTreeNode {
  readonly entry: FileEntry;
  expanded: boolean;
  children: FileTreeNode[] | null;
  readonly depth: number;
}

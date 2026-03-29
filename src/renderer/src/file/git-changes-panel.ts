import type { GitFileChange, GitStageGroup } from '../../../shared/git-types';

export type FileSelectCallback = (filePath: string, group: GitStageGroup) => void;

const STATUS_ICONS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

const STATUS_COLORS: Record<string, string> = {
  modified: 'var(--warning)',
  added: 'var(--success)',
  deleted: 'var(--error)',
  renamed: 'var(--accent)',
  untracked: 'var(--fg-dim)',
};

const GROUP_LABELS: Record<GitStageGroup, string> = {
  staged: 'STAGED',
  unstaged: 'UNSTAGED',
  untracked: 'UNTRACKED',
};

export class GitChangesPanel {
  private readonly container: HTMLElement;
  private readonly onFileSelect: FileSelectCallback;

  constructor(container: HTMLElement, onFileSelect: FileSelectCallback) {
    this.container = container;
    this.onFileSelect = onFileSelect;
  }

  render(changes: readonly GitFileChange[], branch: string): void {
    this.container.replaceChildren();

    // Branch header
    if (branch) {
      const branchEl = document.createElement('div');
      branchEl.className = 'git-branch-header';
      branchEl.textContent = `\u2387 ${branch}`;
      this.container.appendChild(branchEl);
    }

    if (changes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'git-changes-empty';
      empty.textContent = 'No changes';
      this.container.appendChild(empty);
      return;
    }

    // Group by stage
    const groups: Record<GitStageGroup, GitFileChange[]> = {
      staged: [],
      unstaged: [],
      untracked: [],
    };

    for (const change of changes) {
      groups[change.group].push(change);
    }

    for (const group of ['staged', 'unstaged', 'untracked'] as GitStageGroup[]) {
      const files = groups[group];
      if (files.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'git-changes-section';

      const header = document.createElement('div');
      header.className = 'git-changes-group-header';
      header.textContent = `${GROUP_LABELS[group]} (${files.length})`;
      section.appendChild(header);

      for (const file of files) {
        const row = document.createElement('div');
        row.className = 'git-change-row';
        row.addEventListener('click', () => this.onFileSelect(file.path, file.group));

        const icon = document.createElement('span');
        icon.className = 'git-change-icon';
        icon.textContent = STATUS_ICONS[file.status] ?? '?';
        icon.style.color = STATUS_COLORS[file.status] ?? 'var(--fg-dim)';

        const name = document.createElement('span');
        name.className = 'git-change-name';
        // Show filename, with directory dimmed
        const lastSlash = file.path.lastIndexOf('/');
        if (lastSlash >= 0) {
          const dir = document.createElement('span');
          dir.className = 'git-change-dir';
          dir.textContent = file.path.slice(0, lastSlash + 1);
          name.appendChild(dir);
          const fname = document.createTextNode(file.path.slice(lastSlash + 1));
          name.appendChild(fname);
        } else {
          name.textContent = file.path;
        }

        row.appendChild(icon);
        row.appendChild(name);
        section.appendChild(row);
      }

      this.container.appendChild(section);
    }
  }

  renderNotRepo(): void {
    this.container.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'git-changes-empty';
    msg.textContent = 'Not a git repository';
    this.container.appendChild(msg);
  }

  renderLoading(): void {
    this.container.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'git-changes-empty';
    msg.textContent = 'Loading changes...';
    this.container.appendChild(msg);
  }
}

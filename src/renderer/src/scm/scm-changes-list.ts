import type { GitFileChange, GitStageGroup } from '../../../shared/git-types';

export interface ChangesListCallbacks {
  readonly onFileSelect: (filePath: string, group: GitStageGroup) => void;
  readonly onStage: (filePath: string) => void;
  readonly onUnstage: (filePath: string) => void;
  readonly onDiscard: (filePath: string) => void;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
  readonly onDiscardAll: () => void;
}

const STATUS_LETTERS: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U',
};

const STATUS_CLASSES: Record<string, string> = {
  modified: 'scm-status-M', added: 'scm-status-A', deleted: 'scm-status-D',
  renamed: 'scm-status-R', untracked: 'scm-status-U',
};

interface SectionState { collapsed: boolean; }

export class ScmChangesList {
  private readonly container: HTMLElement;
  private readonly callbacks: ChangesListCallbacks;
  private readonly sectionStates: Record<string, SectionState> = {
    staged: { collapsed: false },
    unstaged: { collapsed: false },
    untracked: { collapsed: false },
  };

  constructor(container: HTMLElement, callbacks: ChangesListCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
  }

  render(changes: readonly GitFileChange[]): void {
    this.container.replaceChildren();

    const groups: Record<GitStageGroup, GitFileChange[]> = {
      staged: [], unstaged: [], untracked: [],
    };
    for (const c of changes) groups[c.group].push(c);

    if (groups.staged.length > 0) {
      this.renderSection('staged', 'Staged Changes', groups.staged, [
        { label: '\u2212', title: 'Unstage All', action: this.callbacks.onUnstageAll },
      ]);
    }

    if (groups.unstaged.length > 0 || groups.untracked.length > 0) {
      const combined = [...groups.unstaged, ...groups.untracked];
      this.renderSection('unstaged', 'Changes', combined, [
        { label: '\u21A9', title: 'Discard All', action: this.callbacks.onDiscardAll },
        { label: '+', title: 'Stage All', action: this.callbacks.onStageAll },
      ]);
    }

    if (changes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scm-empty';
      empty.textContent = 'No changes';
      this.container.appendChild(empty);
    }
  }

  private renderSection(
    id: string,
    title: string,
    files: GitFileChange[],
    headerActions: Array<{ label: string; title: string; action: () => void }>,
  ): void {
    const section = document.createElement('div');
    section.className = 'scm-section';

    const state = this.sectionStates[id] ?? { collapsed: false };

    // Header
    const header = document.createElement('div');
    header.className = 'scm-section-header';
    header.dataset.collapsed = String(state.collapsed);

    const arrow = document.createElement('span');
    arrow.className = 'scm-section-arrow';
    arrow.textContent = state.collapsed ? '\u25B8' : '\u25BE';

    const titleEl = document.createElement('span');
    titleEl.className = 'scm-section-title';
    titleEl.textContent = title;

    const count = document.createElement('span');
    count.className = 'scm-section-count';
    count.textContent = String(files.length);

    const actions = document.createElement('div');
    actions.className = 'scm-section-actions';
    for (const a of headerActions) {
      const btn = document.createElement('button');
      btn.className = 'scm-icon-btn';
      btn.textContent = a.label;
      btn.title = a.title;
      btn.addEventListener('click', (e) => { e.stopPropagation(); a.action(); });
      actions.appendChild(btn);
    }

    header.appendChild(arrow);
    header.appendChild(titleEl);
    header.appendChild(count);
    header.appendChild(actions);

    header.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      header.dataset.collapsed = String(state.collapsed);
      arrow.textContent = state.collapsed ? '\u25B8' : '\u25BE';
      body.style.display = state.collapsed ? 'none' : '';
    });

    // Body
    const body = document.createElement('div');
    body.className = 'scm-section-body';
    body.style.display = state.collapsed ? 'none' : '';

    for (const file of files) {
      const row = this.createFileRow(file);
      body.appendChild(row);
    }

    section.appendChild(header);
    section.appendChild(body);
    this.container.appendChild(section);
  }

  private createFileRow(file: GitFileChange): HTMLElement {
    const row = document.createElement('div');
    row.className = 'scm-file-row';

    row.addEventListener('click', () => {
      this.container.querySelectorAll('.scm-file-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      this.callbacks.onFileSelect(file.path, file.group);
    });

    // Filename
    const lastSlash = file.path.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
    const dirName = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';

    const nameEl = document.createElement('span');
    nameEl.className = 'scm-file-name';
    nameEl.textContent = fileName;

    const dirEl = document.createElement('span');
    dirEl.className = 'scm-file-dir';
    dirEl.textContent = dirName;

    // Hover actions
    const actions = document.createElement('div');
    actions.className = 'scm-file-actions';

    if (file.group === 'staged') {
      const unstageBtn = document.createElement('button');
      unstageBtn.className = 'scm-icon-btn';
      unstageBtn.textContent = '\u2212';
      unstageBtn.title = 'Unstage';
      unstageBtn.addEventListener('click', (e) => { e.stopPropagation(); this.callbacks.onUnstage(file.path); });
      actions.appendChild(unstageBtn);
    } else {
      if (file.status !== 'untracked') {
        const discardBtn = document.createElement('button');
        discardBtn.className = 'scm-icon-btn';
        discardBtn.textContent = '\u21A9';
        discardBtn.title = 'Discard';
        discardBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Discard changes to ${file.path}?`)) this.callbacks.onDiscard(file.path);
        });
        actions.appendChild(discardBtn);
      }
      const stageBtn = document.createElement('button');
      stageBtn.className = 'scm-icon-btn';
      stageBtn.textContent = '+';
      stageBtn.title = 'Stage';
      stageBtn.addEventListener('click', (e) => { e.stopPropagation(); this.callbacks.onStage(file.path); });
      actions.appendChild(stageBtn);
    }

    // Status letter
    const statusEl = document.createElement('span');
    statusEl.className = `scm-file-status ${STATUS_CLASSES[file.status] ?? ''}`;
    statusEl.textContent = STATUS_LETTERS[file.status] ?? '?';

    row.appendChild(nameEl);
    row.appendChild(dirEl);
    row.appendChild(actions);
    row.appendChild(statusEl);

    return row;
  }
}

export interface CommitBoxCallbacks {
  readonly onCommit: (message: string, amend: boolean) => void;
  readonly onCommitAndPush: (message: string) => void;
}

export class ScmCommitBox {
  private readonly container: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly commitBtn: HTMLButtonElement;
  private readonly amendCheckbox: HTMLInputElement;
  private readonly callbacks: CommitBoxCallbacks;
  private hasStagedChanges = false;

  constructor(container: HTMLElement, callbacks: CommitBoxCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const box = document.createElement('div');
    box.className = 'scm-commit-box';

    // Textarea
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'scm-commit-input';
    this.textarea.placeholder = "Message (Ctrl+Enter to commit)";
    this.textarea.rows = 1;
    this.textarea.addEventListener('input', () => {
      this.autoGrow();
      this.updateCommitBtn();
    });
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.doCommit();
      }
    });

    // Actions row
    const actions = document.createElement('div');
    actions.className = 'scm-commit-actions';

    // Amend checkbox
    const amendLabel = document.createElement('label');
    amendLabel.className = 'scm-amend-label';
    this.amendCheckbox = document.createElement('input');
    this.amendCheckbox.type = 'checkbox';
    this.amendCheckbox.className = 'scm-amend-checkbox';
    const amendText = document.createElement('span');
    amendText.textContent = 'Amend';
    amendText.className = 'scm-amend-text';
    amendLabel.appendChild(this.amendCheckbox);
    amendLabel.appendChild(amendText);

    // Commit button with dropdown
    const commitGroup = document.createElement('div');
    commitGroup.className = 'scm-commit-group';

    this.commitBtn = document.createElement('button');
    this.commitBtn.className = 'scm-commit-btn';
    this.commitBtn.textContent = 'Commit';
    this.commitBtn.disabled = true;
    this.commitBtn.addEventListener('click', () => this.doCommit());

    const dropdownBtn = document.createElement('button');
    dropdownBtn.className = 'scm-commit-dropdown-btn';
    dropdownBtn.textContent = '\u25BE';
    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDropdown(commitGroup);
    });

    commitGroup.appendChild(this.commitBtn);
    commitGroup.appendChild(dropdownBtn);

    actions.appendChild(amendLabel);
    actions.appendChild(commitGroup);

    box.appendChild(this.textarea);
    box.appendChild(actions);
    this.container.appendChild(box);
  }

  updateBranch(branch: string): void {
    this.textarea.placeholder = `Message (Ctrl+Enter to commit on '${branch}')`;
  }

  updateStagedCount(count: number): void {
    this.hasStagedChanges = count > 0;
    this.updateCommitBtn();
  }

  setLoading(loading: boolean): void {
    this.commitBtn.disabled = loading;
    this.commitBtn.textContent = loading ? 'Committing...' : 'Commit';
  }

  private doCommit(): void {
    const message = this.textarea.value.trim();
    if (!message) return;
    if (!this.hasStagedChanges && !this.amendCheckbox.checked) return;
    this.callbacks.onCommit(message, this.amendCheckbox.checked);
    this.textarea.value = '';
    this.autoGrow();
    this.amendCheckbox.checked = false;
    this.updateCommitBtn();
  }

  private updateCommitBtn(): void {
    const hasMessage = this.textarea.value.trim().length > 0;
    const canCommit = hasMessage && (this.hasStagedChanges || this.amendCheckbox.checked);
    this.commitBtn.disabled = !canCommit;
  }

  private showDropdown(parent: HTMLElement): void {
    const existing = parent.querySelector('.scm-commit-dropdown');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.className = 'scm-commit-dropdown';

    const items = [
      { label: 'Commit', action: () => this.doCommit() },
      { label: 'Commit & Push', action: () => {
        const msg = this.textarea.value.trim();
        if (!msg) return;
        this.callbacks.onCommitAndPush(msg);
        this.textarea.value = '';
        this.autoGrow();
      }},
      { label: 'Commit (Amend)', action: () => {
        this.amendCheckbox.checked = true;
        this.doCommit();
      }},
    ];

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'scm-commit-dropdown-item';
      el.textContent = item.label;
      el.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.appendChild(el);
    }

    parent.appendChild(menu);

    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  private autoGrow(): void {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 120)}px`;
  }
}

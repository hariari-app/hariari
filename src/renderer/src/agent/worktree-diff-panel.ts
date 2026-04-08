// Worktree diff review panel — shows agent changes before merge/discard

import type { WorktreeDiffSummary, WorktreeDiffFile } from '../../../shared/worktree-types';

export type DiffPanelAction = 'merge' | 'discard' | 'cancel';

export class WorktreeDiffPanel {
  private overlay: HTMLElement | null = null;
  private visible = false;

  async show(
    agentId: string,
    branchName: string,
    onAction: (action: DiffPanelAction) => void,
  ): Promise<void> {
    if (this.visible) return;
    this.visible = true;

    const diff = await window.api.worktree.diff(agentId);
    this.renderOverlay(agentId, branchName, diff, onAction);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private renderOverlay(
    agentId: string,
    branchName: string,
    diff: WorktreeDiffSummary | null,
    onAction: (action: DiffPanelAction) => void,
  ): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'wt-diff-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) { this.hide(); onAction('cancel'); }
    });

    const card = document.createElement('div');
    card.className = 'wt-diff-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Review Agent Changes');
    card.setAttribute('aria-modal', 'true');

    // Header
    const header = document.createElement('div');
    header.className = 'wt-diff-header';

    const title = document.createElement('span');
    title.className = 'wt-diff-title';
    title.textContent = 'Agent Changes';

    const branch = document.createElement('span');
    branch.className = 'wt-diff-branch';
    branch.textContent = branchName.replace('hariari/', '');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'file-viewer-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.setAttribute('aria-label', 'Close review panel');
    closeBtn.addEventListener('click', () => { this.hide(); onAction('cancel'); });

    header.appendChild(title);
    header.appendChild(branch);
    header.appendChild(closeBtn);

    card.appendChild(header);

    if (!diff || diff.filesChanged === 0) {
      const empty = document.createElement('div');
      empty.className = 'wt-diff-empty';
      empty.textContent = 'No changes detected in this worktree.';
      card.appendChild(empty);
    } else {
      // Summary
      const summary = document.createElement('div');
      summary.className = 'wt-diff-summary';
      summary.textContent = `${diff.filesChanged} file${diff.filesChanged === 1 ? '' : 's'} changed, `
        + `+${diff.insertions} -${diff.deletions}`;
      card.appendChild(summary);

      // File list
      const fileList = document.createElement('div');
      fileList.className = 'wt-diff-files';

      // Diff content area (shows per-file diff when clicked)
      const diffContent = document.createElement('div');
      diffContent.className = 'wt-diff-content';

      for (const file of diff.files) {
        const row = this.createFileRow(file, agentId, diffContent);
        fileList.appendChild(row);
      }

      card.appendChild(fileList);
      card.appendChild(diffContent);
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'wt-diff-actions';

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn-danger';
    discardBtn.textContent = 'Discard Changes';
    discardBtn.addEventListener('click', () => { this.hide(); onAction('discard'); });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { this.hide(); onAction('cancel'); });

    const mergeBtn = document.createElement('button');
    mergeBtn.className = 'btn-primary';
    mergeBtn.textContent = 'Merge into Main';
    mergeBtn.style.background = 'var(--success)';
    if (!diff || diff.filesChanged === 0) {
      mergeBtn.disabled = true;
    }
    mergeBtn.addEventListener('click', () => { this.hide(); onAction('merge'); });

    actions.appendChild(discardBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(mergeBtn);
    card.appendChild(actions);

    this.overlay.appendChild(card);
    document.body.appendChild(this.overlay);

    // Escape to close
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide();
        onAction('cancel');
        document.removeEventListener('keydown', onEsc);
      }
    };
    document.addEventListener('keydown', onEsc);
  }

  private createFileRow(
    file: WorktreeDiffFile,
    agentId: string,
    diffContent: HTMLElement,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'wt-diff-file-row';
    row.style.cursor = 'pointer';

    const icon = document.createElement('span');
    icon.className = `wt-diff-file-icon wt-diff-file-${file.status}`;
    icon.textContent = file.status === 'added' ? '+' : file.status === 'deleted' ? '-' : '~';

    const name = document.createElement('span');
    name.className = 'wt-diff-file-name';
    name.textContent = file.path;

    const stats = document.createElement('span');
    stats.className = 'wt-diff-file-stats';
    const parts: string[] = [];
    if (file.insertions > 0) parts.push(`+${file.insertions}`);
    if (file.deletions > 0) parts.push(`-${file.deletions}`);
    stats.textContent = parts.join(' ');

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(stats);

    row.addEventListener('click', async () => {
      // Highlight selected row
      row.parentElement?.querySelectorAll('.wt-diff-file-row').forEach((r) =>
        r.classList.remove('selected'));
      row.classList.add('selected');

      // Load per-file diff
      diffContent.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'wt-diff-loading';
      loading.textContent = 'Loading diff...';
      diffContent.appendChild(loading);

      try {
        const result = await window.api.worktree.diffFile({ agentId, filePath: file.path });
        diffContent.replaceChildren();

        if (!result) {
          diffContent.textContent = 'Unable to load diff';
          return;
        }

        const pre = document.createElement('pre');
        pre.className = 'wt-diff-code';

        // Simple side-by-side display with line-by-line comparison
        const origLines = result.original.split('\n');
        const modLines = result.modified.split('\n');
        const maxLines = Math.max(origLines.length, modLines.length);

        for (let i = 0; i < maxLines; i++) {
          const orig = origLines[i] ?? '';
          const mod = modLines[i] ?? '';
          const line = document.createElement('div');

          if (orig !== mod) {
            if (!orig && mod) {
              line.className = 'wt-diff-line-added';
              line.textContent = `+ ${mod}`;
            } else if (orig && !mod) {
              line.className = 'wt-diff-line-removed';
              line.textContent = `- ${orig}`;
            } else {
              const removed = document.createElement('div');
              removed.className = 'wt-diff-line-removed';
              removed.textContent = `- ${orig}`;
              const added = document.createElement('div');
              added.className = 'wt-diff-line-added';
              added.textContent = `+ ${mod}`;
              pre.appendChild(removed);
              pre.appendChild(added);
              continue;
            }
          } else {
            line.className = 'wt-diff-line';
            line.textContent = `  ${orig}`;
          }
          pre.appendChild(line);
        }

        diffContent.appendChild(pre);
      } catch {
        diffContent.replaceChildren();
        diffContent.textContent = 'Failed to load diff';
      }
    });

    return row;
  }
}

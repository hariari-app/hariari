import { ScmCommitBox } from '../scm/scm-commit-box';
import { ScmChangesList } from '../scm/scm-changes-list';
import { ScmCommitGraph } from '../scm/scm-commit-graph';
import type { GitStageGroup } from '../../../shared/git-types';

export interface ScmPanelCallbacks {
  readonly onFileSelect: (filePath: string, group: GitStageGroup) => void;
}

export class ScmPanel {
  readonly el: HTMLElement;
  private readonly callbacks: ScmPanelCallbacks;
  private readonly projectPath: string;

  private commitBox: ScmCommitBox | null = null;
  private changesList: ScmChangesList | null = null;
  private commitGraph: ScmCommitGraph | null = null;
  private branchLabel: HTMLElement | null = null;
  private aheadBehindLabel: HTMLElement | null = null;
  private graphCollapsed = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private isRefreshing = false;

  constructor(container: HTMLElement, projectPath: string, callbacks: ScmPanelCallbacks) {
    this.projectPath = projectPath;
    this.callbacks = callbacks;

    this.el = document.createElement('div');
    this.el.className = 'ew-scm-panel';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Source control');
    container.appendChild(this.el);
  }

  async init(): Promise<void> {
    this.el.replaceChildren();

    // Header
    const header = document.createElement('div');
    header.className = 'scm-header';

    const title = document.createElement('span');
    title.className = 'scm-header-title';
    title.textContent = 'Source Control';

    const actions = document.createElement('div');
    actions.className = 'scm-header-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'scm-icon-btn';
    refreshBtn.textContent = '\u21BB';
    refreshBtn.title = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Refresh source control');
    refreshBtn.addEventListener('click', () => this.refresh());

    actions.appendChild(refreshBtn);
    header.appendChild(title);
    header.appendChild(actions);

    // Scrollable body
    const body = document.createElement('div');
    body.className = 'scm-body';

    // Commit box
    const commitContainer = document.createElement('div');
    this.commitBox = new ScmCommitBox(commitContainer, {
      onCommit: (message, amend) => this.doCommit(message, amend),
      onCommitAndPush: (message) => this.doCommitAndPush(message),
    });

    // Branch + sync section
    const branchSection = document.createElement('div');
    branchSection.className = 'scm-branch-section';

    this.branchLabel = document.createElement('span');
    this.branchLabel.className = 'scm-branch-label';
    this.branchLabel.textContent = '\u2387 main';

    this.aheadBehindLabel = document.createElement('span');
    this.aheadBehindLabel.className = 'scm-ahead-behind';

    const pullBtn = document.createElement('button');
    pullBtn.className = 'scm-sync-btn btn-secondary';
    pullBtn.textContent = '\u2193 Pull';
    pullBtn.title = 'Pull from remote';
    pullBtn.addEventListener('click', () => this.doPull(pullBtn));

    const pushBtn = document.createElement('button');
    pushBtn.className = 'scm-sync-btn btn-secondary';
    pushBtn.textContent = '\u2191 Push';
    pushBtn.title = 'Push to remote';
    pushBtn.addEventListener('click', () => this.doPush(pushBtn));

    branchSection.appendChild(this.branchLabel);
    branchSection.appendChild(this.aheadBehindLabel);
    branchSection.appendChild(pullBtn);
    branchSection.appendChild(pushBtn);

    // Changes list
    const changesContainer = document.createElement('div');
    this.changesList = new ScmChangesList(changesContainer, {
      onFileSelect: (path, group) => this.callbacks.onFileSelect(path, group),
      onStage: (path) => this.doStage(path),
      onUnstage: (path) => this.doUnstage(path),
      onDiscard: (path) => this.doDiscard(path),
      onStageAll: () => this.doStageAll(),
      onUnstageAll: () => this.doUnstageAll(),
      onDiscardAll: () => this.doDiscardAll(),
    });

    // Graph section
    const graphSection = document.createElement('div');
    graphSection.className = 'scm-section';

    const graphHeader = document.createElement('div');
    graphHeader.className = 'scm-section-header';
    graphHeader.dataset.collapsed = String(this.graphCollapsed);

    const graphArrow = document.createElement('span');
    graphArrow.className = 'scm-section-arrow';
    graphArrow.textContent = this.graphCollapsed ? '\u25B8' : '\u25BE';

    const graphTitle = document.createElement('span');
    graphTitle.className = 'scm-section-title';
    graphTitle.textContent = 'Graph';

    graphHeader.appendChild(graphArrow);
    graphHeader.appendChild(graphTitle);

    const graphBody = document.createElement('div');
    graphBody.className = 'scm-section-body scm-graph-body';
    graphBody.style.display = this.graphCollapsed ? 'none' : '';

    graphHeader.addEventListener('click', () => {
      this.graphCollapsed = !this.graphCollapsed;
      graphHeader.dataset.collapsed = String(this.graphCollapsed);
      graphArrow.textContent = this.graphCollapsed ? '\u25B8' : '\u25BE';
      graphBody.style.display = this.graphCollapsed ? 'none' : '';
    });

    this.commitGraph = new ScmCommitGraph(graphBody);

    graphSection.appendChild(graphHeader);
    graphSection.appendChild(graphBody);

    body.appendChild(commitContainer);
    body.appendChild(branchSection);
    body.appendChild(changesContainer);
    body.appendChild(graphSection);

    this.el.appendChild(header);
    this.el.appendChild(body);

    await this.refresh();
    this.startAutoRefresh();
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing || !this.projectPath) return;
    this.isRefreshing = true;

    try {
      const status = await window.api.git.status(this.projectPath);
      if (!status.isRepo) {
        this.el.replaceChildren();
        const msg = document.createElement('div');
        msg.className = 'scm-empty';
        msg.textContent = 'Not a git repository';
        this.el.appendChild(msg);
        return;
      }

      this.commitBox?.updateBranch(status.branch);
      if (this.branchLabel) this.branchLabel.textContent = `\u2387 ${status.branch}`;
      const stagedCount = status.changes.filter((c: { group: string }) => c.group === 'staged').length;
      this.commitBox?.updateStagedCount(stagedCount);
      this.changesList?.render(status.changes);

      // Ahead/behind
      try {
        const ab = await window.api.git.aheadBehind(this.projectPath);
        if (this.aheadBehindLabel) {
          if (ab.hasUpstream) {
            const parts: string[] = [];
            if (ab.ahead > 0) parts.push(`\u2191${ab.ahead}`);
            if (ab.behind > 0) parts.push(`\u2193${ab.behind}`);
            this.aheadBehindLabel.textContent = parts.length > 0 ? parts.join(' ') : '\u2713 synced';
          } else {
            this.aheadBehindLabel.textContent = 'no upstream';
          }
        }
      } catch { /* ignore */ }

      // Load commit graph
      if (this.commitGraph && !this.graphCollapsed) {
        try {
          const log = await window.api.git.log({ projectPath: this.projectPath, maxCount: 50 });
          if (log.entries) {
            this.commitGraph.render(log.entries);
          }
        } catch { /* ignore graph errors */ }
      }
    } catch (error) {
      console.error('[EditorWindow][SCM] Refresh failed:', error);
    } finally {
      this.isRefreshing = false;
    }
  }

  // --- Git operations ---

  private async doCommit(message: string, amend: boolean): Promise<void> {
    this.commitBox?.setLoading(true);
    try {
      const result = await window.api.git.commit({ projectPath: this.projectPath, message, amend });
      if (!result.success) alert(`Commit failed: ${result.error}`);
    } catch (error) {
      console.error('[EditorWindow][SCM] Commit failed:', error);
    } finally {
      this.commitBox?.setLoading(false);
      await this.refresh();
    }
  }

  private async doCommitAndPush(message: string): Promise<void> {
    this.commitBox?.setLoading(true);
    try {
      const commitResult = await window.api.git.commit({ projectPath: this.projectPath, message });
      if (!commitResult.success) { alert(`Commit failed: ${commitResult.error}`); return; }
      const pushResult = await window.api.git.push({ projectPath: this.projectPath, setUpstream: true });
      if (!pushResult.success) alert(`Push failed: ${pushResult.error}`);
    } catch (error) {
      console.error('[EditorWindow][SCM] Commit & Push failed:', error);
    } finally {
      this.commitBox?.setLoading(false);
      await this.refresh();
    }
  }

  private async doPull(btn: HTMLButtonElement): Promise<void> {
    const orig = btn.textContent;
    btn.textContent = 'Pulling...';
    btn.disabled = true;
    try {
      const result = await window.api.git.pull(this.projectPath);
      if (!result.success) alert(`Pull failed: ${result.error}`);
    } catch (error) { console.error('[EditorWindow][SCM] Pull failed:', error); }
    finally { btn.textContent = orig; btn.disabled = false; await this.refresh(); }
  }

  private async doPush(btn: HTMLButtonElement): Promise<void> {
    const orig = btn.textContent;
    btn.textContent = 'Pushing...';
    btn.disabled = true;
    try {
      const result = await window.api.git.push({ projectPath: this.projectPath, setUpstream: true });
      if (!result.success) alert(`Push failed: ${result.error}`);
    } catch (error) { console.error('[EditorWindow][SCM] Push failed:', error); }
    finally { btn.textContent = orig; btn.disabled = false; await this.refresh(); }
  }

  private async doStage(filePath: string): Promise<void> {
    await window.api.git.stage({ projectPath: this.projectPath, filePath });
    await this.refresh();
  }

  private async doUnstage(filePath: string): Promise<void> {
    await window.api.git.unstage({ projectPath: this.projectPath, filePath });
    await this.refresh();
  }

  private async doDiscard(filePath: string): Promise<void> {
    await window.api.git.discard({ projectPath: this.projectPath, filePath });
    await this.refresh();
  }

  private async doStageAll(): Promise<void> {
    await window.api.git.stageAll(this.projectPath);
    await this.refresh();
  }

  private async doUnstageAll(): Promise<void> {
    await window.api.git.unstageAll(this.projectPath);
    await this.refresh();
  }

  private async doDiscardAll(): Promise<void> {
    if (!confirm('Discard ALL changes? This cannot be undone.')) return;
    await window.api.git.discardAll(this.projectPath);
    await this.refresh();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.refreshTimer = setInterval(() => this.refresh(), 5000);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.commitBox = null;
    this.changesList = null;
    this.commitGraph = null;
    this.el.remove();
  }
}

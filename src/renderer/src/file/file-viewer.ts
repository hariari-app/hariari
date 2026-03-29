import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { MergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { go } from '@codemirror/lang-go';
import { search } from '@codemirror/search';
import { GitChangesPanel } from './git-changes-panel';
import type { FileEntry, FileContent } from '../../../shared/ipc-types';
import type { GitStageGroup } from '../../../shared/git-types';
import type { Extension } from '@codemirror/state';

function getLanguageExtension(filePath: string): Extension {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
    case 'py': case 'pyw': return python();
    case 'html': case 'htm': case 'svelte': case 'vue': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'json': case 'jsonc': return json();
    case 'md': case 'mdx': return markdown();
    case 'rs': return rust();
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'cxx': return cpp();
    case 'java': case 'kt': case 'kts': return java();
    case 'xml': case 'svg': case 'plist': return xml();
    case 'sql': return sql();
    case 'yaml': case 'yml': return yaml();
    case 'go': return go();
    default: return [];
  }
}

const cmTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  '.cm-gutters': { minWidth: '48px' },
});

type ViewMode = 'files' | 'changes';

export class FileViewer {
  private readonly overlay: HTMLElement;
  private readonly treeContainer: HTMLElement;
  private readonly editorContainer: HTMLElement;
  private readonly breadcrumb: HTMLElement;
  private readonly editToggle: HTMLButtonElement;
  private readonly saveIndicator: HTMLElement;
  private readonly filesTab: HTMLButtonElement;
  private readonly changesTab: HTMLButtonElement;
  private rootPath = '';
  private visible = false;
  private mode: ViewMode = 'files';
  private editorView: EditorView | null = null;
  private mergeView: MergeView | null = null;
  private currentFilePath = '';
  private isEditing = false;
  private hasUnsavedChanges = false;
  private readonly readOnlyCompartment = new Compartment();
  private readonly languageCompartment = new Compartment();
  private gitChangesPanel: GitChangesPanel | null = null;
  private _rightPane!: HTMLElement;
  private treeNodes: Array<{ entry: FileEntry; expanded: boolean; children: any[] | null; depth: number }> = [];

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'file-viewer-overlay';
    this.overlay.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'file-viewer-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'file-viewer-header';

    // Tab buttons
    this.filesTab = document.createElement('button');
    this.filesTab.className = 'file-viewer-tab active';
    this.filesTab.textContent = 'Files';
    this.filesTab.addEventListener('click', () => this.switchMode('files'));

    this.changesTab = document.createElement('button');
    this.changesTab.className = 'file-viewer-tab';
    this.changesTab.textContent = 'Changes';
    this.changesTab.addEventListener('click', () => this.switchMode('changes'));

    this.breadcrumb = document.createElement('span');
    this.breadcrumb.className = 'file-viewer-breadcrumb';

    this.saveIndicator = document.createElement('span');
    this.saveIndicator.className = 'file-viewer-unsaved';

    const shortcutSave = document.createElement('span');
    shortcutSave.className = 'file-viewer-shortcut';
    shortcutSave.innerHTML = '<kbd>Ctrl+S</kbd> Save';

    const shortcutFind = document.createElement('span');
    shortcutFind.className = 'file-viewer-shortcut';
    shortcutFind.innerHTML = '<kbd>Ctrl+F</kbd> Find';

    this.editToggle = document.createElement('button');
    this.editToggle.className = 'file-viewer-edit-btn';
    this.editToggle.textContent = 'Edit';
    this.editToggle.title = 'Toggle edit mode';
    this.editToggle.addEventListener('click', () => this.toggleEdit());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'file-viewer-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => this.hide());

    header.appendChild(this.filesTab);
    header.appendChild(this.changesTab);
    header.appendChild(this.breadcrumb);
    header.appendChild(this.saveIndicator);
    header.appendChild(shortcutSave);
    header.appendChild(shortcutFind);
    header.appendChild(this.editToggle);
    header.appendChild(closeBtn);

    // Body
    const body = document.createElement('div');
    body.className = 'file-viewer-body';

    this.treeContainer = document.createElement('div');
    this.treeContainer.className = 'file-tree';

    // Right side: editor + action bar in a column
    const rightPane = document.createElement('div');
    rightPane.className = 'file-viewer-right';

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'file-editor-container';

    rightPane.appendChild(this.editorContainer);

    body.appendChild(this.treeContainer);
    body.appendChild(rightPane);

    // Store reference for appending action bar
    this._rightPane = rightPane;

    panel.appendChild(header);
    panel.appendChild(body);
    this.overlay.appendChild(panel);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    document.body.appendChild(this.overlay);
  }

  isVisible(): boolean { return this.visible; }

  toggle(rootPath: string): void {
    if (this.visible) this.hide();
    else this.show(rootPath);
  }

  async show(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    this.visible = true;
    this.overlay.style.display = '';
    this.breadcrumb.textContent = '';
    this.saveIndicator.textContent = '';
    this.isEditing = false;
    this.editToggle.textContent = 'Edit';
    this.editToggle.classList.remove('active');
    this.showPlaceholder('Select a file to view');
    this.destroyEditor();
    this.destroyMergeView();
    this.switchMode(this.mode);
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
    this.destroyEditor();
    this.destroyMergeView();
  }

  async showChanges(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    this.visible = true;
    this.overlay.style.display = '';
    this.switchMode('changes');
  }

  async openFile(filePath: string): Promise<void> {
    try {
      const result: FileContent = await window.api.file.read(filePath);
      if ('error' in (result as unknown as Record<string, unknown>)) {
        this.showPlaceholder('Failed to read file');
        return;
      }

      this.currentFilePath = filePath;
      this.hasUnsavedChanges = false;
      this.saveIndicator.textContent = '';
      this.editToggle.style.display = '';

      const relativePath = filePath.startsWith(this.rootPath)
        ? filePath.slice(this.rootPath.length + 1) : filePath;
      this.breadcrumb.textContent = relativePath;

      this.destroyMergeView();
      this.createEditor(result.content, filePath);
    } catch {
      this.showPlaceholder('Failed to read file');
    }
  }

  // --- Mode switching ---

  private switchMode(mode: ViewMode): void {
    this.mode = mode;
    this.filesTab.classList.toggle('active', mode === 'files');
    this.changesTab.classList.toggle('active', mode === 'changes');

    if (mode === 'files') {
      this.editToggle.style.display = '';
      this.loadTree(this.rootPath);
    } else {
      this.editToggle.style.display = 'none';
      this.loadGitChanges();
    }
  }

  private async loadGitChanges(): Promise<void> {
    this.destroyEditor();
    this.destroyMergeView();
    this.showPlaceholder('Select a changed file to view diff');

    if (!this.gitChangesPanel) {
      this.gitChangesPanel = new GitChangesPanel(this.treeContainer, (filePath, group) => {
        this.showDiff(filePath, group);
      });
    }

    this.gitChangesPanel.renderLoading();

    try {
      const status = await window.api.git.status(this.rootPath);
      if ('error' in (status as unknown as Record<string, unknown>)) {
        this.gitChangesPanel.renderNotRepo();
        return;
      }
      if (!status.isRepo) {
        this.gitChangesPanel.renderNotRepo();
        return;
      }
      this.gitChangesPanel.render(status.changes, status.branch);

      // Update changes tab with count
      const count = status.changes.length;
      this.changesTab.textContent = count > 0 ? `Changes (${count})` : 'Changes';
    } catch {
      this.gitChangesPanel.renderNotRepo();
    }
  }

  private currentDiffFile: string = '';
  private currentDiffGroup: GitStageGroup = 'unstaged';
  private diffActionBar: HTMLElement | null = null;

  private async showDiff(filePath: string, group: GitStageGroup): Promise<void> {
    this.breadcrumb.textContent = filePath;
    this.currentDiffFile = filePath;
    this.currentDiffGroup = group;
    this.destroyEditor();
    this.destroyMergeView();
    this.removeDiffActions();

    try {
      const diff = await window.api.git.diff({ projectPath: this.rootPath, filePath, group });
      if ('error' in (diff as unknown as Record<string, unknown>)) {
        this.showPlaceholder('Failed to load diff');
        return;
      }

      if (diff.isBinary) {
        this.showPlaceholder('Binary file — cannot show diff');
        return;
      }

      this.createMergeView(diff.originalContent, diff.modifiedContent, filePath);
      this.showDiffActions(filePath, group, diff.isNewFile);
    } catch {
      this.showPlaceholder('Failed to load diff');
    }
  }

  private showDiffActions(filePath: string, group: GitStageGroup, isNewFile: boolean): void {
    this.removeDiffActions();

    this.diffActionBar = document.createElement('div');
    this.diffActionBar.className = 'diff-action-bar';

    // Edit button — open file in editor mode
    const editBtn = document.createElement('button');
    editBtn.className = 'diff-action-btn diff-action-edit';
    editBtn.textContent = 'Edit File';
    editBtn.addEventListener('click', () => {
      this.removeDiffActions();
      this.destroyMergeView();
      const fullPath = this.rootPath + '/' + filePath;
      this.isEditing = true;
      this.editToggle.textContent = 'Viewing';
      this.editToggle.classList.add('active');
      this.editToggle.style.display = '';
      this.openFile(fullPath);
    });

    // Stage button (for unstaged/untracked)
    if (group === 'unstaged' || group === 'untracked') {
      const stageBtn = document.createElement('button');
      stageBtn.className = 'diff-action-btn diff-action-accept';
      stageBtn.textContent = 'Stage';
      stageBtn.addEventListener('click', async () => {
        await window.api.git.stage({ projectPath: this.rootPath, filePath });
        this.loadGitChanges();
        this.showPlaceholder('File staged');
      });
      this.diffActionBar.appendChild(stageBtn);
    }

    // Discard button (for unstaged modified files, not untracked)
    if (group === 'unstaged' && !isNewFile) {
      const discardBtn = document.createElement('button');
      discardBtn.className = 'diff-action-btn diff-action-discard';
      discardBtn.textContent = 'Discard Changes';
      discardBtn.addEventListener('click', async () => {
        const confirmed = confirm(`Discard all changes to ${filePath}? This cannot be undone.`);
        if (!confirmed) return;
        await window.api.git.discard({ projectPath: this.rootPath, filePath });
        this.loadGitChanges();
        this.showPlaceholder('Changes discarded');
      });
      this.diffActionBar.appendChild(discardBtn);
    }

    this.diffActionBar.appendChild(editBtn);
    this._rightPane.appendChild(this.diffActionBar);
  }

  private removeDiffActions(): void {
    if (this.diffActionBar) {
      this.diffActionBar.remove();
      this.diffActionBar = null;
    }
  }

  // --- Editor ---

  private createEditor(content: string, filePath: string): void {
    this.destroyEditor();
    this.destroyMergeView();
    this.clearPlaceholder();

    const langExt = getLanguageExtension(filePath);

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        this.languageCompartment.of(langExt),
        this.readOnlyCompartment.of(EditorState.readOnly.of(!this.isEditing)),
        oneDark,
        search(),
        keymap.of([{ key: 'Mod-s', run: () => { this.saveFile(); return true; } }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && this.isEditing) {
            this.hasUnsavedChanges = true;
            this.saveIndicator.textContent = '\u25CF';
            this.saveIndicator.title = 'Unsaved changes';
          }
        }),
        cmTheme,
      ],
    });

    this.editorView = new EditorView({ state, parent: this.editorContainer });
  }

  private destroyEditor(): void {
    if (this.editorView) { this.editorView.destroy(); this.editorView = null; }
  }

  // --- Merge View (diff) ---

  private createMergeView(original: string, modified: string, filePath: string): void {
    this.destroyEditor();
    this.destroyMergeView();
    this.clearPlaceholder();

    const langExt = getLanguageExtension(filePath);

    this.mergeView = new MergeView({
      a: {
        doc: original,
        extensions: [basicSetup, langExt, oneDark, cmTheme, EditorState.readOnly.of(true)],
      },
      b: {
        doc: modified,
        extensions: [basicSetup, langExt, oneDark, cmTheme, EditorState.readOnly.of(true)],
      },
      parent: this.editorContainer,
      highlightChanges: true,
      gutter: true,
    });
  }

  private destroyMergeView(): void {
    if (this.mergeView) { this.mergeView.destroy(); this.mergeView = null; }
  }

  // --- Edit mode ---

  private toggleEdit(): void {
    this.isEditing = !this.isEditing;
    this.editToggle.textContent = this.isEditing ? 'Viewing' : 'Edit';
    this.editToggle.classList.toggle('active', this.isEditing);
    if (this.editorView) {
      this.editorView.dispatch({
        effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(!this.isEditing)),
      });
    }
  }

  private async saveFile(): Promise<void> {
    if (!this.currentFilePath || !this.editorView || !this.hasUnsavedChanges) return;
    const content = this.editorView.state.doc.toString();
    try {
      const result = await window.api.file.write(this.currentFilePath, content);
      if (result.success) {
        this.hasUnsavedChanges = false;
        this.saveIndicator.textContent = '\u2713';
        this.saveIndicator.title = 'Saved';
        setTimeout(() => { if (!this.hasUnsavedChanges) this.saveIndicator.textContent = ''; }, 2000);
        // Refresh git changes if in changes mode
        if (this.mode === 'changes') this.loadGitChanges();
      } else {
        this.saveIndicator.textContent = '\u00D7';
        this.saveIndicator.title = `Save failed: ${result.error}`;
      }
    } catch {
      // Save failed
    }
  }

  // --- Placeholder ---

  private showPlaceholder(text: string): void {
    this.editorContainer.textContent = text;
    this.editorContainer.style.display = 'flex';
    this.editorContainer.style.alignItems = 'center';
    this.editorContainer.style.justifyContent = 'center';
    this.editorContainer.style.color = 'var(--fg-dim)';
  }

  private clearPlaceholder(): void {
    this.editorContainer.textContent = '';
    this.editorContainer.style.display = '';
    this.editorContainer.style.alignItems = '';
    this.editorContainer.style.justifyContent = '';
    this.editorContainer.style.color = '';
  }

  // --- File tree ---

  private async loadTree(dirPath: string): Promise<void> {
    try {
      const entries: FileEntry[] = await window.api.file.listDir(dirPath);
      if ('error' in (entries as unknown as Record<string, unknown>)) {
        this.treeContainer.textContent = 'Failed to load directory';
        return;
      }
      this.treeNodes = entries.map((entry) => ({ entry, expanded: false, children: null, depth: 0 }));
      this.renderTree();
    } catch {
      this.treeContainer.textContent = 'Failed to load directory';
    }
  }

  private renderTree(): void {
    this.treeContainer.replaceChildren();
    this.renderNodes(this.treeNodes, this.treeContainer);
  }

  private renderNodes(nodes: typeof this.treeNodes, container: HTMLElement): void {
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'file-tree-row';
      row.style.paddingLeft = `${12 + node.depth * 16}px`;

      if (node.entry.isDirectory) {
        const arrow = document.createElement('span');
        arrow.className = 'file-tree-arrow';
        arrow.textContent = node.expanded ? '\u25BE' : '\u25B8';
        row.appendChild(arrow);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'file-tree-arrow';
        spacer.textContent = ' ';
        row.appendChild(spacer);
      }

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = node.entry.name;
      row.appendChild(label);

      row.addEventListener('click', () => {
        if (node.entry.isDirectory) this.toggleDirectory(node);
        else this.openFile(node.entry.path);
      });

      container.appendChild(row);
      if (node.expanded && node.children) {
        this.renderNodes(node.children as typeof this.treeNodes, container);
      }
    }
  }

  private async toggleDirectory(node: typeof this.treeNodes[0]): Promise<void> {
    if (node.expanded) { node.expanded = false; this.renderTree(); return; }
    if (!node.children) {
      try {
        const entries: FileEntry[] = await window.api.file.listDir(node.entry.path);
        if ('error' in (entries as unknown as Record<string, unknown>)) return;
        node.children = entries.map((entry) => ({ entry, expanded: false, children: null, depth: node.depth + 1 }));
      } catch { return; }
    }
    node.expanded = true;
    this.renderTree();
  }

  dispose(): void {
    this.destroyEditor();
    this.destroyMergeView();
    this.overlay.remove();
  }
}

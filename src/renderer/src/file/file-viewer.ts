import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { MergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { search } from '@codemirror/search';
import { getLanguageExtension, cmTheme } from '../editor-window/lang-extensions';
import { isCurrentThemeLight } from '../terminal/terminal-theme';
import { SourceControlPanel } from '../scm/source-control-panel';
import type { FileEntry, FileContent } from '../../../shared/ipc-types';
import type { GitStageGroup } from '../../../shared/git-types';

// oneDark only applies on dark app themes. See editor-pane.ts for the
// same pattern — evaluated at editor-create time; a theme switch requires
// reopening the file to take effect.
function syntaxThemeExtensions(): readonly [] | readonly [typeof oneDark] {
  return isCurrentThemeLight() ? [] : [oneDark];
}

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
  private scmPanel: SourceControlPanel | null = null;
  private _rightPane!: HTMLElement;
  private treeNodes: Array<{ entry: FileEntry; expanded: boolean; children: any[] | null; depth: number }> = [];
  private pendingCreate: { type: 'file' | 'folder'; parentPath: string } | null = null;
  private contextMenu: HTMLElement | null = null;
  private selectedTreePath = '';

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
    this.changesTab.textContent = 'Source Control';
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

    const popoutBtn = document.createElement('button');
    popoutBtn.className = 'file-viewer-popout';
    popoutBtn.textContent = '\u2197';
    popoutBtn.title = 'Open in new window';
    popoutBtn.setAttribute('aria-label', 'Pop out to new window');
    popoutBtn.addEventListener('click', () => {
      this.popout();
    });

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
    header.appendChild(popoutBtn);
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

    // Resize handle for the tree/SCM sidebar
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'file-tree-resize-handle';
    resizeHandle.addEventListener('mousedown', (startEvent) => {
      startEvent.preventDefault();
      const startX = startEvent.clientX;
      const startWidth = this.treeContainer.offsetWidth;

      const onMouseMove = (e: MouseEvent) => {
        const newWidth = Math.max(150, Math.min(500, startWidth + (e.clientX - startX)));
        this.treeContainer.style.width = `${newWidth}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    body.appendChild(this.treeContainer);
    body.appendChild(resizeHandle);
    body.appendChild(rightPane);

    // Store reference for appending action bar
    this._rightPane = rightPane;

    panel.appendChild(header);
    panel.appendChild(body);
    this.overlay.appendChild(panel);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    // Dismiss context menu on click outside
    document.addEventListener('click', () => this.dismissContextMenu());

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
    this.scmPanel?.hide();
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

    if (!this.scmPanel) {
      this.scmPanel = new SourceControlPanel(this.treeContainer, {
        onFileSelect: (filePath, group) => this.showDiff(filePath, group),
      });
    }

    await this.scmPanel.show(this.rootPath);

    // Update tab label with change count
    try {
      const status = await window.api.git.status(this.rootPath);
      if (status.isRepo) {
        const count = status.changes.length;
        this.changesTab.textContent = count > 0 ? `Source Control (${count})` : 'Source Control';
      }
    } catch { /* ignore */ }
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
        autocompletion({ activateOnTyping: true }),
        closeBrackets(),
        keymap.of(closeBracketsKeymap),
        ...syntaxThemeExtensions(),
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

    const syntaxExt = syntaxThemeExtensions();
    this.mergeView = new MergeView({
      a: {
        doc: original,
        extensions: [basicSetup, langExt, ...syntaxExt, cmTheme, EditorState.readOnly.of(true)],
      },
      b: {
        doc: modified,
        extensions: [basicSetup, langExt, ...syntaxExt, cmTheme, EditorState.readOnly.of(true)],
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

  private async popout(): Promise<void> {
    if (!this.rootPath) return;
    try {
      await window.api.window.popoutFile(this.rootPath, this.currentFilePath || undefined);
    } catch (error) {
      console.error('[FileViewer] Pop-out failed:', error);
    }
  }

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

    // Toolbar with New File / New Folder buttons
    const toolbar = document.createElement('div');
    toolbar.className = 'file-tree-toolbar';

    const newFileBtn = document.createElement('button');
    newFileBtn.className = 'file-tree-toolbar-btn';
    newFileBtn.title = 'New File';
    newFileBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 1.1l3.4 3.4.1.6V14c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1zM9 2H4v12h8V6H9V2zm4 4l-3-3v3h3zM8 8h1v2h2v1H9v2H8v-2H6v-1h2V8z"/></svg>`;
    newFileBtn.addEventListener('click', () => this.startCreate('file'));

    const newFolderBtn = document.createElement('button');
    newFolderBtn.className = 'file-tree-toolbar-btn';
    newFolderBtn.title = 'New Folder';
    newFolderBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 4H8l-1-2H2c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.6 0 1-.4 1-1V5c0-.6-.4-1-1-1zm0 9H2V3h4.4l1 2H14v8zM8 8h1v2h2v1H9v2H8v-2H6v-1h2V8z"/></svg>`;
    newFolderBtn.addEventListener('click', () => this.startCreate('folder'));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'file-tree-toolbar-btn file-tree-toolbar-btn--danger';
    deleteBtn.title = 'Delete Selected';
    deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V4H3V3h3V2a1 1 0 011-1h2a1 1 0 011 1v1zM7 2v1h2V2H7zM5 4v9h6V4H5zm2 2h1v5H7V6zm2 0h1v5H9V6z"/></svg>`;
    deleteBtn.addEventListener('click', () => {
      if (this.selectedTreePath) this.deleteItem(this.selectedTreePath);
    });

    toolbar.appendChild(newFileBtn);
    toolbar.appendChild(newFolderBtn);
    toolbar.appendChild(deleteBtn);
    this.treeContainer.appendChild(toolbar);

    // Inline input for new file/folder at root level
    if (this.pendingCreate) {
      this.treeContainer.appendChild(this.createInlineInput(this.pendingCreate.type, this.rootPath, 0));
    }

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
        this.selectedTreePath = node.entry.path;
        this.treeContainer.querySelectorAll('.file-tree-row').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        if (node.entry.isDirectory) this.toggleDirectory(node);
        else this.openFile(node.entry.path);
      });

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, node.entry.path, node.entry.isDirectory);
      });

      // Drag-and-drop: make rows draggable
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', node.entry.path);
        e.dataTransfer!.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        this.clearDropTargets();
      });

      // Only directories accept drops
      if (node.entry.isDirectory) {
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer!.dropEffect = 'move';
          this.clearDropTargets();
          row.classList.add('drop-target');
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('drop-target');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.classList.remove('drop-target');
          const sourcePath = e.dataTransfer!.getData('text/plain');
          if (sourcePath && sourcePath !== node.entry.path) {
            this.moveItem(sourcePath, node.entry.path);
          }
        });
      }

      container.appendChild(row);
      if (node.expanded && node.children) {
        // Show inline input inside this expanded directory if it's the target
        if (this.pendingCreate && this.pendingCreate.parentPath === node.entry.path) {
          container.appendChild(this.createInlineInput(this.pendingCreate.type, node.entry.path, node.depth + 1));
        }
        this.renderNodes(node.children as typeof this.treeNodes, container);
      }
    }
  }

  private showContextMenu(x: number, y: number, filePath: string, isDirectory: boolean): void {
    this.dismissContextMenu();

    const menu = document.createElement('div');
    menu.className = 'file-tree-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    if (isDirectory) {
      const newFileItem = document.createElement('div');
      newFileItem.className = 'file-tree-context-item';
      newFileItem.textContent = 'New File';
      newFileItem.addEventListener('click', () => {
        this.dismissContextMenu();
        this.pendingCreate = { type: 'file', parentPath: filePath };
        this.renderTree();
      });
      menu.appendChild(newFileItem);

      const newFolderItem = document.createElement('div');
      newFolderItem.className = 'file-tree-context-item';
      newFolderItem.textContent = 'New Folder';
      newFolderItem.addEventListener('click', () => {
        this.dismissContextMenu();
        this.pendingCreate = { type: 'folder', parentPath: filePath };
        this.renderTree();
      });
      menu.appendChild(newFolderItem);

      const sep = document.createElement('div');
      sep.className = 'file-tree-context-separator';
      menu.appendChild(sep);
    }

    const deleteItem = document.createElement('div');
    deleteItem.className = 'file-tree-context-item file-tree-context-item--danger';
    deleteItem.textContent = 'Delete';
    deleteItem.addEventListener('click', () => {
      this.dismissContextMenu();
      this.deleteItem(filePath);
    });
    menu.appendChild(deleteItem);

    document.body.appendChild(menu);
    this.contextMenu = menu;
  }

  private dismissContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  private async deleteItem(filePath: string): Promise<void> {
    const name = filePath.split('/').pop() ?? filePath;
    const confirmed = confirm(`Delete "${name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const result = await window.api.file.delete(filePath);
      if (result.success) {
        if (this.selectedTreePath === filePath) this.selectedTreePath = '';
        if (this.currentFilePath === filePath) {
          this.destroyEditor();
          this.showPlaceholder('Select a file to view');
        }
        await this.loadTree(this.rootPath);
      }
    } catch {
      // delete failed
    }
  }

  private clearDropTargets(): void {
    this.treeContainer.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  private async moveItem(sourcePath: string, targetDirPath: string): Promise<void> {
    const fileName = sourcePath.split('/').pop();
    if (!fileName) return;
    if (targetDirPath.startsWith(sourcePath + '/') || targetDirPath === sourcePath) return;
    const newPath = targetDirPath + '/' + fileName;
    if (newPath === sourcePath) return;
    try {
      const result = await window.api.file.rename(sourcePath, newPath);
      if (result.success) {
        await this.loadTree(this.rootPath);
      }
    } catch {
      // move failed
    }
  }

  private startCreate(type: 'file' | 'folder'): void {
    this.pendingCreate = { type, parentPath: this.rootPath };
    this.renderTree();
  }

  private createInlineInput(type: 'file' | 'folder', parentPath: string, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'file-tree-row file-tree-input-row';
    row.style.paddingLeft = `${12 + depth * 16}px`;

    const icon = document.createElement('span');
    icon.className = 'file-tree-arrow';
    icon.textContent = type === 'folder' ? '\u25B8' : ' ';
    row.appendChild(icon);

    const input = document.createElement('input');
    input.className = 'file-tree-inline-input';
    input.type = 'text';
    input.placeholder = type === 'folder' ? 'folder name' : 'file name';
    row.appendChild(input);

    const commit = async (): Promise<void> => {
      const name = input.value.trim();
      if (!name) {
        this.pendingCreate = null;
        this.renderTree();
        return;
      }
      const fullPath = parentPath + '/' + name;
      try {
        if (type === 'folder') {
          await window.api.file.mkdir(fullPath);
        } else {
          await window.api.file.write(fullPath, '');
        }
      } catch {
        // creation failed — just close the input
      }
      this.pendingCreate = null;
      await this.loadTree(this.rootPath);
      if (type === 'file') {
        this.openFile(fullPath);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { this.pendingCreate = null; this.renderTree(); }
    });

    input.addEventListener('blur', () => commit());

    // Auto-focus after DOM insertion
    requestAnimationFrame(() => input.focus());

    return row;
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

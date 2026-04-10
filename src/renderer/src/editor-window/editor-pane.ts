import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { MergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { search } from '@codemirror/search';
import { getLanguageExtension, cmTheme } from './lang-extensions';
import { isCurrentThemeLight } from '../terminal/terminal-theme';
import type { FileContent } from '../../../shared/ipc-types';
import type { GitStageGroup } from '../../../shared/git-types';

// oneDark only applies on dark app themes; on light themes we skip it and
// let cmTheme's CSS-variable-driven chrome + CodeMirror's default syntax
// highlighting carry the editor. Evaluated at editor-create time — an
// already-open editor needs a reopen to pick up a theme switch.
function syntaxThemeExtensions(): readonly [] | readonly [typeof oneDark] {
  return isCurrentThemeLight() ? [] : [oneDark];
}

export interface EditorPaneCallbacks {
  readonly onDiffStage: (filePath: string) => void;
  readonly onDiffDiscard: (filePath: string) => void;
  readonly onRequestEditFile: (filePath: string) => void;
}

export class EditorPane {
  readonly el: HTMLElement;
  private readonly breadcrumb: HTMLElement;
  private readonly editToggle: HTMLButtonElement;
  private readonly saveIndicator: HTMLElement;
  private readonly editorContainer: HTMLElement;
  private readonly callbacks: EditorPaneCallbacks;
  private readonly rootPath: string;

  private editorView: EditorView | null = null;
  private mergeView: MergeView | null = null;
  private currentFilePath = '';
  private originalContent = '';
  private isEditing = false;
  private hasUnsavedChanges = false;
  private readonly readOnlyCompartment = new Compartment();
  private readonly languageCompartment = new Compartment();
  private diffActionBar: HTMLElement | null = null;
  private saveBtn!: HTMLButtonElement;
  private discardBtn!: HTMLButtonElement;

  constructor(container: HTMLElement, rootPath: string, callbacks: EditorPaneCallbacks) {
    this.rootPath = rootPath;
    this.callbacks = callbacks;

    this.el = document.createElement('div');
    this.el.className = 'ew-editor-pane';

    // Header bar
    const header = document.createElement('div');
    header.className = 'ew-editor-header';

    this.breadcrumb = document.createElement('span');
    this.breadcrumb.className = 'ew-breadcrumb';
    this.breadcrumb.setAttribute('role', 'navigation');
    this.breadcrumb.setAttribute('aria-label', 'File path');

    this.saveIndicator = document.createElement('span');
    this.saveIndicator.className = 'ew-save-indicator';

    this.editToggle = document.createElement('button');
    this.editToggle.className = 'ew-edit-btn';
    this.editToggle.textContent = 'Edit';
    this.editToggle.title = 'Toggle edit mode';
    this.editToggle.style.display = 'none';
    this.editToggle.addEventListener('click', () => this.toggleEdit());

    this.saveBtn = document.createElement('button');
    this.saveBtn.className = 'ew-edit-btn ew-save-btn';
    this.saveBtn.textContent = 'Save';
    this.saveBtn.title = 'Save changes (Ctrl+S)';
    this.saveBtn.style.display = 'none';
    this.saveBtn.addEventListener('click', () => this.saveFile());

    this.discardBtn = document.createElement('button');
    this.discardBtn.className = 'ew-edit-btn ew-discard-btn';
    this.discardBtn.textContent = 'Discard';
    this.discardBtn.title = 'Discard changes and revert to saved version';
    this.discardBtn.style.display = 'none';
    this.discardBtn.addEventListener('click', () => this.discardChanges());

    header.appendChild(this.breadcrumb);
    header.appendChild(this.saveIndicator);
    header.appendChild(this.discardBtn);
    header.appendChild(this.saveBtn);
    header.appendChild(this.editToggle);

    // Editor area
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'ew-editor-container';

    this.el.appendChild(header);
    this.el.appendChild(this.editorContainer);
    container.appendChild(this.el);

    this.showPlaceholder('Select a file to view');
  }

  async openFile(filePath: string): Promise<void> {
    // Prompt-free discard on file switch — user explicitly chose a new file
    if (this.hasUnsavedChanges) {
      this.hasUnsavedChanges = false;
    }

    try {
      const result: FileContent = await window.api.file.read(filePath);
      if ('error' in (result as unknown as Record<string, unknown>)) {
        this.showPlaceholder('Failed to read file');
        return;
      }

      this.currentFilePath = filePath;
      this.originalContent = result.content;
      this.hasUnsavedChanges = false;
      this.saveIndicator.textContent = '';
      this.editToggle.style.display = '';
      this.isEditing = false;
      this.editToggle.textContent = 'Edit';
      this.editToggle.classList.remove('active');
      this.updateEditButtons();

      const relativePath = filePath.startsWith(this.rootPath)
        ? filePath.slice(this.rootPath.length + 1) : filePath;
      this.breadcrumb.textContent = relativePath;

      this.destroyMergeView();
      this.removeDiffActions();
      this.createEditor(result.content, filePath);
    } catch {
      this.showPlaceholder('Failed to read file');
    }
  }

  async showDiff(filePath: string, group: GitStageGroup): Promise<void> {
    this.breadcrumb.textContent = filePath;
    this.editToggle.style.display = 'none';
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
      this.createDiffActions(filePath, group, diff.isNewFile);
    } catch {
      this.showPlaceholder('Failed to load diff');
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
            this.updateEditButtons();
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

  // --- Diff actions ---

  private createDiffActions(filePath: string, group: GitStageGroup, isNewFile: boolean): void {
    this.removeDiffActions();

    this.diffActionBar = document.createElement('div');
    this.diffActionBar.className = 'ew-diff-actions';

    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'ew-diff-btn';
    editBtn.textContent = 'Edit File';
    editBtn.addEventListener('click', () => {
      // Validate filePath stays within rootPath to prevent path traversal
      const fullPath = this.rootPath + '/' + filePath;
      if (filePath.includes('..') || !fullPath.startsWith(this.rootPath + '/')) return;
      this.callbacks.onRequestEditFile(fullPath);
    });

    // Stage button (for unstaged/untracked)
    if (group === 'unstaged' || group === 'untracked') {
      const stageBtn = document.createElement('button');
      stageBtn.className = 'ew-diff-btn ew-diff-btn-accept';
      stageBtn.textContent = 'Stage';
      stageBtn.addEventListener('click', () => this.callbacks.onDiffStage(filePath));
      this.diffActionBar.appendChild(stageBtn);
    }

    // Discard button (for unstaged modified, not untracked)
    if (group === 'unstaged' && !isNewFile) {
      const discardBtn = document.createElement('button');
      discardBtn.className = 'ew-diff-btn ew-diff-btn-discard';
      discardBtn.textContent = 'Discard';
      discardBtn.addEventListener('click', () => {
        if (confirm(`Discard all changes to ${filePath}? This cannot be undone.`)) {
          this.callbacks.onDiffDiscard(filePath);
        }
      });
      this.diffActionBar.appendChild(discardBtn);
    }

    this.diffActionBar.appendChild(editBtn);
    this.el.appendChild(this.diffActionBar);
  }

  private removeDiffActions(): void {
    if (this.diffActionBar) { this.diffActionBar.remove(); this.diffActionBar = null; }
  }

  // --- Edit mode ---

  private toggleEdit(): void {
    this.isEditing = !this.isEditing;
    this.editToggle.textContent = this.isEditing ? 'Editing' : 'Edit';
    this.editToggle.classList.toggle('active', this.isEditing);
    this.updateEditButtons();
    if (this.editorView) {
      this.editorView.dispatch({
        effects: this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(!this.isEditing)),
      });
    }
  }

  private updateEditButtons(): void {
    const show = this.isEditing && this.hasUnsavedChanges;
    this.saveBtn.style.display = show ? '' : 'none';
    this.discardBtn.style.display = show ? '' : 'none';
  }

  private discardChanges(): void {
    if (!this.editorView || !this.currentFilePath) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: this.originalContent },
    });
    this.hasUnsavedChanges = false;
    this.saveIndicator.textContent = '';
    this.updateEditButtons();
  }

  private async saveFile(): Promise<void> {
    if (!this.currentFilePath || !this.editorView || !this.hasUnsavedChanges) return;
    const content = this.editorView.state.doc.toString();
    try {
      const result = await window.api.file.write(this.currentFilePath, content);
      if (result.success) {
        this.hasUnsavedChanges = false;
        this.originalContent = content;
        this.saveIndicator.textContent = '\u2713';
        this.saveIndicator.title = 'Saved';
        this.updateEditButtons();
        setTimeout(() => { if (!this.hasUnsavedChanges) this.saveIndicator.textContent = ''; }, 2000);
      } else {
        this.saveIndicator.textContent = '\u00D7';
        this.saveIndicator.title = `Save failed: ${result.error}`;
      }
    } catch {
      this.saveIndicator.textContent = '\u00D7';
      this.saveIndicator.title = 'Save failed';
    }
  }

  // --- Placeholder ---

  private showPlaceholder(text: string): void {
    this.editorContainer.textContent = text;
    this.editorContainer.classList.add('ew-placeholder');
  }

  private clearPlaceholder(): void {
    this.editorContainer.textContent = '';
    this.editorContainer.classList.remove('ew-placeholder');
  }

  dispose(): void {
    this.destroyEditor();
    this.destroyMergeView();
    this.removeDiffActions();
    this.el.remove();
  }
}

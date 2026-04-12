import { FileTreePanel } from './file-tree-panel';
import { ScmPanel } from './scm-panel';
import { EditorPane } from './editor-pane';
import type { GitStageGroup } from '../../../shared/git-types';

type SidebarTab = 'files' | 'scm';

export class EditorWindowApp {
  private readonly container: HTMLElement;
  private readonly projectPath: string;
  private readonly boundKeydown = (e: KeyboardEvent) => this.handleKeydown(e);

  private sidebar!: HTMLElement;
  private filesTab!: HTMLButtonElement;
  private scmTab!: HTMLButtonElement;
  private fileTreeContainer!: HTMLElement;
  private scmContainer!: HTMLElement;

  private fileTree!: FileTreePanel;
  private scmPanel!: ScmPanel;
  private editorPane!: EditorPane;

  private activeTab: SidebarTab = 'files';

  private readonly branchName: string | undefined;

  constructor(container: HTMLElement, projectPath: string, branchName?: string) {
    this.container = container;
    this.projectPath = projectPath;
    this.branchName = branchName;
  }

  async init(): Promise<void> {
    this.container.classList.add('ew-root');

    // Title bar — frameless window chrome. Contains the project name
    // (left), a draggable spacer (middle), and platform-native window
    // controls on the right for non-macOS. On macOS the native traffic
    // lights render on the left via trafficLightPosition in main/index.ts,
    // and .ew-titlebar gets a left padding to clear them.
    const titleBar = document.createElement('div');
    titleBar.className = 'ew-titlebar';
    titleBar.setAttribute('role', 'banner');

    const titleLabel = document.createElement('span');
    titleLabel.className = 'ew-titlebar-title';
    const projectName = this.projectPath.split('/').filter(Boolean).pop() ?? 'Hariari';
    const branchSuffix = this.branchName ? ` \u2387 ${this.branchName.replace('hariari/', '')}` : '';
    titleLabel.textContent = `${projectName}${branchSuffix} — Hariari`;
    titleBar.appendChild(titleLabel);

    const dragSpacer = document.createElement('div');
    dragSpacer.className = 'ew-titlebar-drag';
    titleBar.appendChild(dragSpacer);

    if (window.api.platform !== 'darwin') {
      const controls = document.createElement('div');
      controls.className = 'app-titlebar-controls';
      controls.setAttribute('role', 'toolbar');
      controls.setAttribute('aria-label', 'Window controls');

      const minimizeBtn = document.createElement('button');
      minimizeBtn.className = 'app-titlebar-btn minimize';
      minimizeBtn.setAttribute('aria-label', 'Minimize window');
      minimizeBtn.textContent = '\u2212'; // − MINUS SIGN
      minimizeBtn.addEventListener('click', () => window.api.window.minimize());

      const maximizeBtn = document.createElement('button');
      maximizeBtn.className = 'app-titlebar-btn maximize';
      maximizeBtn.setAttribute('aria-label', 'Maximize window');
      maximizeBtn.textContent = '\u25A1'; // □ WHITE SQUARE
      maximizeBtn.addEventListener('click', () => window.api.window.maximize());

      const closeBtn = document.createElement('button');
      closeBtn.className = 'app-titlebar-btn close';
      closeBtn.setAttribute('aria-label', 'Close window');
      closeBtn.textContent = '\u2715'; // ✕ MULTIPLICATION X
      closeBtn.addEventListener('click', () => window.api.window.close());

      controls.appendChild(minimizeBtn);
      controls.appendChild(maximizeBtn);
      controls.appendChild(closeBtn);
      titleBar.appendChild(controls);
    }

    this.container.appendChild(titleBar);

    // Body wrapper — horizontal split holding the sidebar and editor area.
    // Wrapping the existing horizontal layout lets the title bar sit
    // on top in a column while the sidebar|editor layout stays row.
    const body = document.createElement('div');
    body.className = 'ew-body';

    // Sidebar
    this.sidebar = document.createElement('div');
    this.sidebar.className = 'ew-sidebar';

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'ew-tab-bar';
    tabBar.setAttribute('role', 'tablist');

    this.filesTab = this.createTab('Files', 'files');
    this.scmTab = this.createTab('Source Control', 'scm');

    tabBar.appendChild(this.filesTab);
    tabBar.appendChild(this.scmTab);
    this.sidebar.appendChild(tabBar);

    // Tab content containers
    this.fileTreeContainer = document.createElement('div');
    this.fileTreeContainer.className = 'ew-tab-content';

    this.scmContainer = document.createElement('div');
    this.scmContainer.className = 'ew-tab-content';
    this.scmContainer.style.display = 'none';

    this.sidebar.appendChild(this.fileTreeContainer);
    this.sidebar.appendChild(this.scmContainer);

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'ew-resize-handle';
    resizeHandle.addEventListener('mousedown', (startEvent) => {
      startEvent.preventDefault();
      const startX = startEvent.clientX;
      const startWidth = this.sidebar.offsetWidth;

      const onMouseMove = (e: MouseEvent) => {
        const newWidth = Math.max(180, Math.min(500, startWidth + (e.clientX - startX)));
        this.sidebar.style.width = `${newWidth}px`;
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

    // Editor pane container
    const editorContainer = document.createElement('div');
    editorContainer.className = 'ew-editor-area';

    body.appendChild(this.sidebar);
    body.appendChild(resizeHandle);
    body.appendChild(editorContainer);
    this.container.appendChild(body);

    // Initialize components
    this.fileTree = new FileTreePanel(this.fileTreeContainer, {
      onFileSelect: (filePath) => this.editorPane.openFile(filePath),
    });

    this.scmPanel = new ScmPanel(this.scmContainer, this.projectPath, {
      onFileSelect: (filePath, group) => this.handleDiffSelect(filePath, group),
    });

    this.editorPane = new EditorPane(editorContainer, this.projectPath, {
      onDiffStage: (filePath) => this.handleDiffStage(filePath),
      onDiffDiscard: (filePath) => this.handleDiffDiscard(filePath),
      onRequestEditFile: (filePath) => {
        this.switchTab('files');
        this.editorPane.openFile(filePath);
        this.fileTree.setSelected(filePath);
      },
    });

    // Load initial data
    await this.fileTree.load(this.projectPath);
    this.updateActiveTab();

    // Register keyboard shortcuts within this window
    document.addEventListener('keydown', this.boundKeydown);
  }

  private createTab(label: string, tab: SidebarTab): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'ew-tab';
    btn.textContent = label;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab === this.activeTab));
    btn.addEventListener('click', () => this.switchTab(tab));
    return btn;
  }

  private switchTab(tab: SidebarTab): void {
    this.activeTab = tab;
    this.updateActiveTab();
  }

  private updateActiveTab(): void {
    const isFiles = this.activeTab === 'files';

    this.filesTab.classList.toggle('active', isFiles);
    this.scmTab.classList.toggle('active', !isFiles);
    this.filesTab.setAttribute('aria-selected', String(isFiles));
    this.scmTab.setAttribute('aria-selected', String(!isFiles));

    this.fileTreeContainer.style.display = isFiles ? '' : 'none';
    this.scmContainer.style.display = isFiles ? 'none' : '';

    if (!isFiles && !this.scmPanel.el.hasChildNodes()) {
      this.scmPanel.init().catch((error) => {
        console.error('[EditorWindow] SCM init failed:', error);
      });
    }
  }

  private handleDiffSelect(filePath: string, group: GitStageGroup): void {
    this.editorPane.showDiff(filePath, group);
  }

  private async handleDiffStage(filePath: string): Promise<void> {
    await window.api.git.stage({ projectPath: this.projectPath, filePath });
    await this.scmPanel.refresh();
    this.editorPane.showDiff(filePath, 'staged');
  }

  private async handleDiffDiscard(filePath: string): Promise<void> {
    await window.api.git.discard({ projectPath: this.projectPath, filePath });
    await this.scmPanel.refresh();
  }

  private handleKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl+1 = Files tab, Ctrl+2 = SCM tab
    if (mod && e.key === '1') { e.preventDefault(); this.switchTab('files'); }
    if (mod && e.key === '2') { e.preventDefault(); this.switchTab('scm'); }
  }

  dispose(): void {
    document.removeEventListener('keydown', this.boundKeydown);
    this.fileTree.dispose();
    this.scmPanel.dispose();
    this.editorPane.dispose();
  }
}

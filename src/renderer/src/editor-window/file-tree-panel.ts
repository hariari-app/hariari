import type { FileEntry } from '../../../shared/ipc-types';

export interface FileTreeCallbacks {
  readonly onFileSelect: (filePath: string) => void;
}

interface TreeNode {
  readonly entry: FileEntry;
  expanded: boolean;
  children: TreeNode[] | null;
  readonly depth: number;
}

export class FileTreePanel {
  readonly el: HTMLElement;
  private readonly treeContent: HTMLElement;
  private readonly callbacks: FileTreeCallbacks;
  private rootPath = '';
  private nodes: TreeNode[] = [];
  private selectedPath = '';
  private pendingCreate: { type: 'file' | 'folder'; parentPath: string } | null = null;
  private contextMenu: HTMLElement | null = null;

  constructor(container: HTMLElement, callbacks: FileTreeCallbacks) {
    this.callbacks = callbacks;

    this.el = document.createElement('div');
    this.el.className = 'ew-file-tree';
    this.el.setAttribute('role', 'tree');
    this.el.setAttribute('aria-label', 'File explorer');

    this.treeContent = document.createElement('div');
    this.treeContent.className = 'ew-file-tree-content';
    this.el.appendChild(this.treeContent);

    // Dismiss context menu on click outside
    document.addEventListener('click', () => this.dismissContextMenu());

    container.appendChild(this.el);
  }

  async load(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    try {
      const entries: FileEntry[] = await window.api.file.listDir(rootPath);
      if ('error' in (entries as unknown as Record<string, unknown>)) {
        this.el.textContent = 'Failed to load directory';
        return;
      }
      this.nodes = entries.map((entry) => ({ entry, expanded: false, children: null, depth: 0 }));
      this.renderTree();
    } catch {
      this.el.textContent = 'Failed to load directory';
    }
  }

  setSelected(filePath: string): void {
    this.selectedPath = filePath;
    this.el.querySelectorAll('.ew-tree-row').forEach((row) => {
      row.classList.toggle('selected', (row as HTMLElement).dataset.path === filePath);
    });
  }

  private renderTree(): void {
    this.treeContent.replaceChildren();

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
      if (this.selectedPath) this.deleteItem(this.selectedPath);
    });

    toolbar.appendChild(newFileBtn);
    toolbar.appendChild(newFolderBtn);
    toolbar.appendChild(deleteBtn);
    this.treeContent.appendChild(toolbar);

    // Inline input for new file/folder at root level
    if (this.pendingCreate && this.pendingCreate.parentPath === this.rootPath) {
      this.treeContent.appendChild(this.createInlineInput(this.pendingCreate.type, this.rootPath, 0));
    }

    this.renderNodes(this.nodes, this.treeContent);
  }

  private renderNodes(nodes: readonly TreeNode[], container: HTMLElement): void {
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'ew-tree-row';
      row.dataset.path = node.entry.path;
      row.style.paddingLeft = `${12 + node.depth * 16}px`;
      row.setAttribute('role', 'treeitem');

      if (node.entry.path === this.selectedPath) {
        row.classList.add('selected');
      }

      const arrow = document.createElement('span');
      arrow.className = 'ew-tree-arrow';
      if (node.entry.isDirectory) {
        arrow.textContent = node.expanded ? '\u25BE' : '\u25B8';
      } else {
        arrow.textContent = ' ';
      }
      row.appendChild(arrow);

      const label = document.createElement('span');
      label.className = 'ew-tree-label';
      label.textContent = node.entry.name;
      row.appendChild(label);

      row.addEventListener('click', () => {
        if (node.entry.isDirectory) {
          this.toggleDirectory(node);
        } else {
          this.selectedPath = node.entry.path;
          this.el.querySelectorAll('.ew-tree-row').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          this.callbacks.onFileSelect(node.entry.path);
        }
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
        this.renderNodes(node.children, container);
      }
    }
  }

  private startCreate(type: 'file' | 'folder'): void {
    this.pendingCreate = { type, parentPath: this.rootPath };
    this.renderTree();
  }

  private createInlineInput(type: 'file' | 'folder', parentPath: string, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ew-tree-row file-tree-input-row';
    row.style.paddingLeft = `${12 + depth * 16}px`;

    const icon = document.createElement('span');
    icon.className = 'ew-tree-arrow';
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
        // creation failed
      }
      this.pendingCreate = null;
      await this.load(this.rootPath);
      if (type === 'file') {
        this.callbacks.onFileSelect(fullPath);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { this.pendingCreate = null; this.renderTree(); }
    });

    input.addEventListener('blur', () => commit());

    requestAnimationFrame(() => input.focus());

    return row;
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
        if (this.selectedPath === filePath) this.selectedPath = '';
        await this.load(this.rootPath);
      }
    } catch {
      // delete failed
    }
  }

  private clearDropTargets(): void {
    this.treeContent.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }

  private async moveItem(sourcePath: string, targetDirPath: string): Promise<void> {
    const fileName = sourcePath.split('/').pop();
    if (!fileName) return;
    // Prevent moving a folder into itself
    if (targetDirPath.startsWith(sourcePath + '/') || targetDirPath === sourcePath) return;
    const newPath = targetDirPath + '/' + fileName;
    if (newPath === sourcePath) return;
    try {
      const result = await window.api.file.rename(sourcePath, newPath);
      if (result.success) {
        await this.load(this.rootPath);
      }
    } catch {
      // move failed
    }
  }

  private async toggleDirectory(node: TreeNode): Promise<void> {
    if (node.expanded) {
      node.expanded = false;
      this.renderTree();
      return;
    }

    if (!node.children) {
      try {
        const entries: FileEntry[] = await window.api.file.listDir(node.entry.path);
        if ('error' in (entries as unknown as Record<string, unknown>)) return;
        node.children = entries.map((entry) => ({
          entry, expanded: false, children: null, depth: node.depth + 1,
        }));
      } catch { return; }
    }
    node.expanded = true;
    this.renderTree();
  }

  dispose(): void {
    this.el.remove();
  }
}

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
  private readonly callbacks: FileTreeCallbacks;
  private rootPath = '';
  private nodes: TreeNode[] = [];
  private selectedPath = '';

  constructor(container: HTMLElement, callbacks: FileTreeCallbacks) {
    this.callbacks = callbacks;

    this.el = document.createElement('div');
    this.el.className = 'ew-file-tree';
    this.el.setAttribute('role', 'tree');
    this.el.setAttribute('aria-label', 'File explorer');
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
    this.el.replaceChildren();
    this.renderNodes(this.nodes, this.el);
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

      container.appendChild(row);
      if (node.expanded && node.children) {
        this.renderNodes(node.children, container);
      }
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

import type { LayoutNode, LeafNode, SplitNode } from './layout-types';

type TerminalCreateCallback = (sessionId: string, container: HTMLElement) => void;
type TerminalRemoveCallback = (sessionId: string) => void;
type FitAllCallback = () => void;

export class LayoutManager {
  private readonly rootElement: HTMLElement;
  private readonly onTerminalCreate: TerminalCreateCallback;
  private readonly onTerminalRemove: TerminalRemoveCallback;
  private onFitAll: FitAllCallback = () => {};
  private layout: LayoutNode | null = null;
  private focusedLeafId: string | null = null;
  private readonly activeSessionIds = new Set<string>();
  private resizeObserver: ResizeObserver;

  constructor(
    rootElement: HTMLElement,
    onTerminalCreate: TerminalCreateCallback,
    onTerminalRemove: TerminalRemoveCallback,
  ) {
    this.rootElement = rootElement;
    this.onTerminalCreate = onTerminalCreate;
    this.onTerminalRemove = onTerminalRemove;

    this.resizeObserver = new ResizeObserver(() => {
      this.onFitAll();
    });
    this.resizeObserver.observe(rootElement);
  }

  setFitAllCallback(callback: FitAllCallback): void {
    this.onFitAll = callback;
  }

  getLayoutTree(): LayoutNode | null {
    return this.layout;
  }

  restoreLayout(tree: LayoutNode): void {
    this.layout = tree;
    this.focusedLeafId = this.findFirstLeaf(tree)?.id ?? null;
    this.render();
  }

  getFocusedLeafId(): string | null {
    return this.focusedLeafId;
  }

  setRoot(sessionId: string): void {
    const leafId = crypto.randomUUID();
    const leaf: LeafNode = { type: 'leaf', id: leafId, sessionId };
    this.layout = leaf;
    this.focusedLeafId = leafId;
    this.render();
  }

  splitPane(
    leafId: string,
    direction: 'horizontal' | 'vertical',
    newSessionId: string,
  ): void {
    if (!this.layout) return;

    const newLeafId = crypto.randomUUID();
    const newLeaf: LeafNode = { type: 'leaf', id: newLeafId, sessionId: newSessionId };

    this.layout = this.replaceNode(this.layout, leafId, (existing) => {
      const split: SplitNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction,
        children: [existing, newLeaf],
        ratio: 0.5,
      };
      return split;
    });

    this.focusedLeafId = newLeafId;
    this.render();
  }

  closePane(leafId: string): void {
    if (!this.layout) return;

    if (this.layout.type === 'leaf' && this.layout.id === leafId) {
      this.onTerminalRemove(this.layout.sessionId);
      this.activeSessionIds.delete(this.layout.sessionId);
      this.layout = null;
      this.focusedLeafId = null;
      this.rootElement.replaceChildren();
      return;
    }

    const result = this.removeNode(this.layout, leafId);
    if (result.removed && result.removedSessionId) {
      this.onTerminalRemove(result.removedSessionId);
      this.activeSessionIds.delete(result.removedSessionId);
      this.layout = result.node;
      if (this.focusedLeafId === leafId) {
        this.focusedLeafId = this.findFirstLeaf(this.layout)?.id ?? null;
      }
      this.render();
    }
  }

  focusLeaf(leafId: string): void {
    this.focusedLeafId = leafId;
    this.rootElement
      .querySelectorAll('.terminal-leaf')
      .forEach((el) => el.classList.remove('focused'));
    const el = this.rootElement.querySelector(`[data-leaf-id="${leafId}"]`);
    if (el) {
      el.classList.add('focused');
    }
  }

  findLeafBySessionId(sessionId: string): LeafNode | null {
    if (!this.layout) return null;
    return this.findLeafInTree(this.layout, sessionId);
  }

  render(): void {
    this.rootElement.replaceChildren();
    if (!this.layout) return;
    const dom = this.renderNode(this.layout);
    this.rootElement.appendChild(dom);
    this.setupDividerDrag();

    requestAnimationFrame(() => {
      this.onFitAll();
    });
  }

  private renderNode(node: LayoutNode): HTMLElement {
    if (node.type === 'leaf') {
      const container = document.createElement('div');
      container.className = 'terminal-leaf';
      container.dataset.leafId = node.id;
      container.dataset.sessionId = node.sessionId;
      if (node.id === this.focusedLeafId) {
        container.classList.add('focused');
      }

      container.addEventListener('mousedown', () => {
        this.focusLeaf(node.id);
      });

      // Only create a terminal if this session hasn't been created yet
      if (!this.activeSessionIds.has(node.sessionId)) {
        this.activeSessionIds.add(node.sessionId);
        this.onTerminalCreate(node.sessionId, container);
      } else {
        // Re-attach existing terminal — the TerminalManager handles this
        this.onTerminalCreate(node.sessionId, container);
      }

      return container;
    }

    const wrapper = document.createElement('div');
    wrapper.className = `split-container ${node.direction}`;
    wrapper.dataset.splitId = node.id;

    const first = this.renderNode(node.children[0]);
    const second = this.renderNode(node.children[1]);

    const isHorizontal = node.direction === 'horizontal';
    const prop = isHorizontal ? 'width' : 'height';
    first.style[prop] = `calc(${node.ratio * 100}% - 2px)`;
    second.style[prop] = `calc(${(1 - node.ratio) * 100}% - 2px)`;
    first.style.flex = 'none';
    second.style.flex = 'none';

    const divider = document.createElement('div');
    divider.className = `split-divider ${node.direction}`;
    divider.dataset.splitId = node.id;

    wrapper.appendChild(first);
    wrapper.appendChild(divider);
    wrapper.appendChild(second);

    return wrapper;
  }

  private setupDividerDrag(): void {
    const dividers = this.rootElement.querySelectorAll('.split-divider');
    dividers.forEach((divider) => {
      const el = divider as HTMLElement;
      el.addEventListener('mousedown', (startEvent) => {
        startEvent.preventDefault();
        const splitId = el.dataset.splitId;
        const parent = el.parentElement;
        if (!splitId || !parent) return;
        const isHorizontal = el.classList.contains('horizontal');
        const rect = parent.getBoundingClientRect();

        const onMouseMove = (moveEvent: MouseEvent) => {
          const ratio = isHorizontal
            ? (moveEvent.clientX - rect.left) / rect.width
            : (moveEvent.clientY - rect.top) / rect.height;

          const clamped = Math.max(0.1, Math.min(0.9, ratio));
          if (this.layout) {
            this.layout = this.updateRatio(this.layout, splitId, clamped);
            this.render();
          }
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  private replaceNode(
    node: LayoutNode,
    targetId: string,
    replacer: (node: LeafNode) => LayoutNode,
  ): LayoutNode {
    if (node.type === 'leaf') {
      return node.id === targetId ? replacer(node) : node;
    }

    const [first, second] = node.children;
    const newFirst = this.replaceNode(first, targetId, replacer);
    const newSecond = this.replaceNode(second, targetId, replacer);

    if (newFirst === first && newSecond === second) return node;

    return { ...node, children: [newFirst, newSecond] };
  }

  private removeNode(
    node: LayoutNode,
    targetId: string,
  ): { node: LayoutNode | null; removed: boolean; removedSessionId?: string } {
    if (node.type === 'leaf') {
      if (node.id === targetId) {
        return { node: null, removed: true, removedSessionId: node.sessionId };
      }
      return { node, removed: false };
    }

    const [first, second] = node.children;

    // Direct child removal — sibling takes parent's place
    if (first.type === 'leaf' && first.id === targetId) {
      return { node: second, removed: true, removedSessionId: first.sessionId };
    }
    if (second.type === 'leaf' && second.id === targetId) {
      return { node: first, removed: true, removedSessionId: second.sessionId };
    }

    // Recursive removal in first child
    const firstResult = this.removeNode(first, targetId);
    if (firstResult.removed && firstResult.node) {
      const newNode: SplitNode = {
        ...node,
        children: [firstResult.node, second],
      };
      return { node: newNode, removed: true, removedSessionId: firstResult.removedSessionId };
    }
    if (firstResult.removed && !firstResult.node) {
      // The entire first subtree was a single leaf that got removed
      return { node: second, removed: true, removedSessionId: firstResult.removedSessionId };
    }

    // Recursive removal in second child
    const secondResult = this.removeNode(second, targetId);
    if (secondResult.removed && secondResult.node) {
      const newNode: SplitNode = {
        ...node,
        children: [first, secondResult.node],
      };
      return { node: newNode, removed: true, removedSessionId: secondResult.removedSessionId };
    }
    if (secondResult.removed && !secondResult.node) {
      return { node: first, removed: true, removedSessionId: secondResult.removedSessionId };
    }

    return { node, removed: false };
  }

  private updateRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
    if (node.type === 'leaf') return node;

    if (node.id === splitId) {
      return { ...node, ratio };
    }

    const [first, second] = node.children;
    const newFirst = this.updateRatio(first, splitId, ratio);
    const newSecond = this.updateRatio(second, splitId, ratio);

    if (newFirst === first && newSecond === second) return node;
    return { ...node, children: [newFirst, newSecond] };
  }

  private findFirstLeaf(node: LayoutNode | null): LeafNode | null {
    if (!node) return null;
    if (node.type === 'leaf') return node;
    return this.findFirstLeaf(node.children[0]);
  }

  private findLeafInTree(node: LayoutNode, sessionId: string): LeafNode | null {
    if (node.type === 'leaf') {
      return node.sessionId === sessionId ? node : null;
    }
    return (
      this.findLeafInTree(node.children[0], sessionId) ??
      this.findLeafInTree(node.children[1], sessionId)
    );
  }
}

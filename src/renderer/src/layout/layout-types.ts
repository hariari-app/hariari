export type LayoutNode = LeafNode | SplitNode;

export interface LeafNode {
  readonly type: 'leaf';
  readonly id: string;
  readonly sessionId: string;
}

export interface SplitNode {
  readonly type: 'split';
  readonly id: string;
  readonly direction: 'horizontal' | 'vertical';
  readonly children: readonly [LayoutNode, LayoutNode];
  readonly ratio: number;
}

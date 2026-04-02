import { describe, it, expect } from 'vitest';
import { buildBalancedTree, buildGridTree, getDefaultGrid, getGridOptions } from '../../src/renderer/src/preview/single-preview';
import type { LayoutNode, LeafNode, SplitNode } from '../../src/shared/layout-types';

function countLeaves(node: LayoutNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === 'leaf') return [node.sessionId];
  return [
    ...collectSessionIds(node.children[0]),
    ...collectSessionIds(node.children[1]),
  ];
}

function maxDepth(node: LayoutNode): number {
  if (node.type === 'leaf') return 0;
  return 1 + Math.max(maxDepth(node.children[0]), maxDepth(node.children[1]));
}

describe('buildBalancedTree', () => {
  it('creates a single leaf for 1 session', () => {
    const tree = buildBalancedTree(['s1']);
    expect(tree.type).toBe('leaf');
    expect((tree as LeafNode).sessionId).toBe('s1');
  });

  it('creates a split for 2 sessions', () => {
    const tree = buildBalancedTree(['s1', 's2']);
    expect(tree.type).toBe('split');
    expect(countLeaves(tree)).toBe(2);
    expect(collectSessionIds(tree)).toEqual(['s1', 's2']);
  });

  it('creates a balanced tree for 3 sessions', () => {
    const tree = buildBalancedTree(['s1', 's2', 's3']);
    expect(countLeaves(tree)).toBe(3);
    expect(collectSessionIds(tree)).toEqual(['s1', 's2', 's3']);
  });

  it('creates a 2x2 grid for 4 sessions', () => {
    const tree = buildBalancedTree(['s1', 's2', 's3', 's4']);
    expect(countLeaves(tree)).toBe(4);
    expect(collectSessionIds(tree)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('handles 6 sessions', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const tree = buildBalancedTree(ids);
    expect(countLeaves(tree)).toBe(6);
    expect(collectSessionIds(tree)).toEqual(ids);
  });

  it('handles 20 sessions (max agents)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const tree = buildBalancedTree(ids);
    expect(countLeaves(tree)).toBe(20);
    expect(collectSessionIds(tree)).toEqual(ids);
  });

  it('throws for empty session list', () => {
    expect(() => buildBalancedTree([])).toThrow('Cannot build tree from empty session list');
  });

  it('preserves session order in leaves', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const tree = buildBalancedTree(ids);
    expect(collectSessionIds(tree)).toEqual(ids);
  });
});

describe('buildGridTree', () => {
  it('builds a 2x3 grid for 6 agents', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const tree = buildGridTree(ids, 2, 3);
    expect(countLeaves(tree)).toBe(6);
    expect(collectSessionIds(tree)).toEqual(ids);
    // Root should be vertical (rows)
    expect(tree.type).toBe('split');
    expect((tree as SplitNode).direction).toBe('vertical');
  });

  it('builds a 3x2 grid for 6 agents', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const tree = buildGridTree(ids, 3, 2);
    expect(countLeaves(tree)).toBe(6);
    expect(collectSessionIds(tree)).toEqual(ids);
    expect(tree.type).toBe('split');
    expect((tree as SplitNode).direction).toBe('vertical');
  });

  it('handles 5 agents in a 2x3 grid (unequal rows: 3+2)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const tree = buildGridTree(ids, 2, 3);
    expect(countLeaves(tree)).toBe(5);
    expect(collectSessionIds(tree)).toEqual(ids);
  });

  it('handles 7 agents in a 3x3 grid (unequal rows: 3+2+2)', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const tree = buildGridTree(ids, 3, 3);
    expect(countLeaves(tree)).toBe(7);
    expect(collectSessionIds(tree)).toEqual(ids);
  });

  it('builds a single-row layout (1xN)', () => {
    const ids = ['a', 'b', 'c'];
    const tree = buildGridTree(ids, 1, 3);
    expect(countLeaves(tree)).toBe(3);
    expect((tree as SplitNode).direction).toBe('horizontal');
  });

  it('builds a single-column layout (Nx1)', () => {
    const ids = ['a', 'b', 'c'];
    const tree = buildGridTree(ids, 3, 1);
    expect(countLeaves(tree)).toBe(3);
    expect((tree as SplitNode).direction).toBe('vertical');
  });
});

describe('getDefaultGrid', () => {
  it('returns 1x1 for 1 agent', () => {
    expect(getDefaultGrid(1)).toEqual({ rows: 1, cols: 1, label: '1\u00d71' });
  });

  it('returns 1x2 for 2 agents', () => {
    expect(getDefaultGrid(2)).toEqual({ rows: 1, cols: 2, label: '1\u00d72' });
  });

  it('returns 2x2 for 4 agents', () => {
    expect(getDefaultGrid(4)).toEqual({ rows: 2, cols: 2, label: '2\u00d72' });
  });

  it('returns 2x3 for 6 agents', () => {
    expect(getDefaultGrid(6)).toEqual({ rows: 2, cols: 3, label: '2\u00d73' });
  });

  it('returns a reasonable grid for 10 agents', () => {
    const g = getDefaultGrid(10);
    expect(g.rows * g.cols).toBeGreaterThanOrEqual(10);
    expect(g.rows).toBeGreaterThanOrEqual(2);
    expect(g.cols).toBeGreaterThanOrEqual(2);
  });
});

describe('getGridOptions', () => {
  it('returns multiple options for 6 agents', () => {
    const opts = getGridOptions(6);
    expect(opts.length).toBeGreaterThanOrEqual(2);
    expect(opts).toContainEqual({ rows: 2, cols: 3, label: '2\u00d73' });
    expect(opts).toContainEqual({ rows: 3, cols: 2, label: '3\u00d72' });
  });

  it('returns 1x1 for 1 agent', () => {
    const opts = getGridOptions(1);
    expect(opts).toEqual([{ rows: 1, cols: 1, label: '1\u00d71' }]);
  });

  it('does not include extreme 1xN for large counts', () => {
    const opts = getGridOptions(8);
    expect(opts.every((o) => o.rows > 1 && o.cols > 1)).toBe(true);
  });
});

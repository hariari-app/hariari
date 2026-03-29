import type { GitLogEntry } from '../../../shared/git-types';

const LANE_COLORS = [
  '#7aa2f7', '#9ece6a', '#f7768e', '#e0af68',
  '#bb9af7', '#7dcfff', '#ff9e64', '#c0caf5',
];

export interface GraphNode {
  readonly commit: GitLogEntry;
  readonly lane: number;
  readonly color: string;
  readonly connections: readonly GraphConnection[];
}

export interface GraphConnection {
  readonly fromLane: number;
  readonly toLane: number;
  readonly color: string;
}

export function computeGraphLayout(entries: readonly GitLogEntry[]): GraphNode[] {
  if (entries.length === 0) return [];

  const nodes: GraphNode[] = [];

  // Maps commit hash → assigned lane
  const reservedLanes = new Map<string, number>();
  // Maps lane → color (persistent per lane so a branch keeps its color)
  const laneColorMap = new Map<number, string>();
  const laneUsed: boolean[] = [];
  let nextColorIdx = 0;

  function allocateLane(): number {
    for (let i = 0; i < laneUsed.length; i++) {
      if (!laneUsed[i]) { laneUsed[i] = true; return i; }
    }
    laneUsed.push(true);
    return laneUsed.length - 1;
  }

  function freeLane(lane: number): void {
    laneUsed[lane] = false;
  }

  function getColorForLane(lane: number): string {
    if (!laneColorMap.has(lane)) {
      laneColorMap.set(lane, LANE_COLORS[nextColorIdx % LANE_COLORS.length]);
      nextColorIdx++;
    }
    return laneColorMap.get(lane)!;
  }

  for (let i = 0; i < entries.length; i++) {
    const commit = entries[i];

    // Determine lane for this commit
    let lane: number;
    if (reservedLanes.has(commit.hash)) {
      lane = reservedLanes.get(commit.hash)!;
      reservedLanes.delete(commit.hash);
    } else {
      lane = allocateLane();
    }

    const color = getColorForLane(lane);
    const connections: GraphConnection[] = [];

    if (commit.parentHashes.length === 0) {
      freeLane(lane);
    } else {
      for (let p = 0; p < commit.parentHashes.length; p++) {
        const parentHash = commit.parentHashes[p];

        if (p === 0) {
          if (!reservedLanes.has(parentHash)) {
            // First parent continues in same lane — same color
            reservedLanes.set(parentHash, lane);
          } else {
            const parentLane = reservedLanes.get(parentHash)!;
            if (parentLane !== lane) {
              freeLane(lane);
            }
          }
        } else {
          if (!reservedLanes.has(parentHash)) {
            const parentLane = allocateLane();
            reservedLanes.set(parentHash, parentLane);
            // New branch gets a new color via getColorForLane
          }
        }
      }
    }

    nodes.push({ commit, lane, color, connections });
  }

  return nodes;
}

export function getMaxLane(nodes: readonly GraphNode[]): number {
  let max = 0;
  for (const node of nodes) {
    max = Math.max(max, node.lane);
  }
  return max;
}

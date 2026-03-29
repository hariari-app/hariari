import { computeGraphLayout, getMaxLane, type GraphNode } from './scm-graph-layout';
import type { GitLogEntry } from '../../../shared/git-types';

const ROW_HEIGHT = 20;
const LANE_WIDTH = 16;
const LANE_OFFSET = 10;
const DOT_RADIUS = 3;

function laneX(lane: number): number {
  return LANE_OFFSET + lane * LANE_WIDTH;
}

function rowY(index: number): number {
  return index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

// Colors are assigned by the layout algorithm per lane — we just read node.color

export class ScmCommitGraph {
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  render(entries: readonly GitLogEntry[]): void {
    this.container.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scm-empty';
      empty.textContent = 'No commits';
      this.container.appendChild(empty);
      return;
    }

    const hashToIndex = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      hashToIndex.set(entries[i].hash, i);
    }

    const nodes = computeGraphLayout(entries);
    const maxLane = getMaxLane(nodes);
    const svgWidth = LANE_OFFSET + (maxLane + 1) * LANE_WIDTH + 8;
    const svgHeight = nodes.length * ROW_HEIGHT;

    const wrapper = document.createElement('div');
    wrapper.className = 'scm-graph-container';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'scm-graph-svg');
    svg.setAttribute('width', String(svgWidth));
    svg.setAttribute('height', String(svgHeight));

    // Track active lanes at each row: which lanes have a vertical line passing through
    // A lane is active between a commit and its first parent
    // laneSegments[lane] = array of {startRow, endRow, color}
    const laneSegments: Array<Array<{ startRow: number; endRow: number; color: string }>> = [];
    for (let i = 0; i <= maxLane; i++) laneSegments.push([]);

    // Build segments: for each commit, draw a segment from this row to its first parent's row
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const commit = node.commit;

      for (let p = 0; p < commit.parentHashes.length; p++) {
        const parentIdx = hashToIndex.get(commit.parentHashes[p]);
        if (parentIdx === undefined) continue;

        const parentNode = nodes[parentIdx];

        if (p === 0 && node.lane === parentNode.lane) {
          // First parent, same lane — straight vertical segment using the node's branch color
          laneSegments[node.lane].push({
            startRow: i,
            endRow: parentIdx,
            color: node.color,
          });
        }
      }
    }

    // Draw continuous vertical lane lines from segments
    for (let lane = 0; lane <= maxLane; lane++) {
      for (const seg of laneSegments[lane]) {
        const x = laneX(lane);
        const y1 = rowY(seg.startRow);
        const y2 = rowY(seg.endRow);

        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', String(x));
        line.setAttribute('y1', String(y1));
        line.setAttribute('x2', String(x));
        line.setAttribute('y2', String(y2));
        line.setAttribute('stroke', seg.color);
        line.setAttribute('stroke-width', '2');
        line.setAttribute('class', 'scm-graph-line');
        svg.appendChild(line);
      }
    }

    // Draw merge/branch curves (non-first-parent connections, or cross-lane first-parent)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const commit = node.commit;

      for (let p = 0; p < commit.parentHashes.length; p++) {
        const parentIdx = hashToIndex.get(commit.parentHashes[p]);
        if (parentIdx === undefined) continue;

        const parentNode = nodes[parentIdx];

        // Skip same-lane first-parent (already drawn as vertical line)
        if (p === 0 && node.lane === parentNode.lane) continue;

        const x1 = laneX(node.lane);
        const y1 = rowY(i);
        const x2 = laneX(parentNode.lane);
        const y2 = rowY(parentIdx);

        const color = parentNode.color;

        if (node.lane === parentNode.lane) {
          // Same lane but not first parent (shouldn't happen often) — straight line
          const line = document.createElementNS(svgNS, 'line');
          line.setAttribute('x1', String(x1));
          line.setAttribute('y1', String(y1));
          line.setAttribute('x2', String(x2));
          line.setAttribute('y2', String(y2));
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '2');
          svg.appendChild(line);
        } else {
          // Cross-lane: curve out from child then straight down to parent
          // First: horizontal-ish curve from child lane to parent lane (over ~2 rows)
          const curveEndY = Math.min(y1 + ROW_HEIGHT * 2, y2);
          const path = document.createElementNS(svgNS, 'path');
          const d = `M ${x1} ${y1} C ${x1} ${y1 + ROW_HEIGHT}, ${x2} ${curveEndY - ROW_HEIGHT}, ${x2} ${curveEndY}`;
          path.setAttribute('d', d);
          path.setAttribute('stroke', color);
          path.setAttribute('stroke-width', '2');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('class', 'scm-graph-merge');
          svg.appendChild(path);

          // Then: straight vertical from curve end to parent (if there's remaining distance)
          if (curveEndY < y2) {
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(x2));
            line.setAttribute('y1', String(curveEndY));
            line.setAttribute('x2', String(x2));
            line.setAttribute('y2', String(y2));
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '2');
            line.setAttribute('class', 'scm-graph-line');
            svg.appendChild(line);
          }
        }
      }
    }

    // Draw dots on top of everything
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const cx = laneX(node.lane);
      const cy = rowY(i);

      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(DOT_RADIUS));
      circle.setAttribute('fill', node.color);
      circle.setAttribute('stroke', 'var(--bg-deep)');
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('class', 'scm-graph-dot');
      svg.appendChild(circle);
    }

    // Commit text rows
    const commits = document.createElement('div');
    commits.className = 'scm-graph-commits';

    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'scm-graph-row';

      if (node.commit.refs.length > 0) {
        for (const ref of node.commit.refs) {
          const badge = document.createElement('span');
          badge.className = 'scm-graph-ref-badge';
          badge.style.setProperty('--badge-color', node.color);
          badge.textContent = ref;
          row.appendChild(badge);
        }
      }

      const msg = document.createElement('span');
      msg.className = 'scm-graph-message';
      msg.textContent = node.commit.message;
      msg.title = node.commit.message;

      const author = document.createElement('span');
      author.className = 'scm-graph-author';
      author.textContent = node.commit.author;

      const date = document.createElement('span');
      date.className = 'scm-graph-date';
      date.textContent = relativeTime(node.commit.date);

      row.appendChild(msg);
      row.appendChild(author);
      row.appendChild(date);
      commits.appendChild(row);
    }

    wrapper.appendChild(svg);
    wrapper.appendChild(commits);
    this.container.appendChild(wrapper);
  }
}

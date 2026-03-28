// Fuzzy file finder — Ctrl+P quick-open overlay
// Scans project files, fuzzy matches, opens in file viewer

interface ScoredFile {
  readonly path: string;
  readonly score: number;
  readonly matchIndices: readonly number[];
}

function fuzzyMatchFile(filePath: string, query: string): { score: number; indices: number[] } | null {
  const pathLower = filePath.toLowerCase();
  const queryLower = query.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let queryIdx = 0;
  let prevIdx = -2;

  for (let i = 0; i < pathLower.length && queryIdx < queryLower.length; i++) {
    if (pathLower[i] === queryLower[queryIdx]) {
      indices.push(i);
      // Consecutive match bonus
      if (i === prevIdx + 1) score += 5;
      // Path separator boundary bonus
      if (i === 0 || filePath[i - 1] === '/' || filePath[i - 1] === '\\') score += 8;
      // Filename start bonus (after last /)
      const lastSlash = filePath.lastIndexOf('/');
      if (i === lastSlash + 1) score += 10;
      // Extension boundary bonus
      if (filePath[i - 1] === '.') score += 3;
      score += 1;
      prevIdx = i;
      queryIdx++;
    }
  }

  if (queryIdx !== queryLower.length) return null;

  // Bonus for shorter paths
  score += Math.max(0, 30 - filePath.length);
  // Bonus for matches in filename vs directory
  const lastSlash = filePath.lastIndexOf('/');
  const filenameMatches = indices.filter((i) => i > lastSlash).length;
  score += filenameMatches * 3;

  return { score, indices };
}

function highlightPath(filePath: string, indices: readonly number[]): HTMLElement {
  const span = document.createElement('span');
  const indexSet = new Set(indices);
  let current = '';
  let inHighlight = false;

  for (let i = 0; i < filePath.length; i++) {
    const isMatch = indexSet.has(i);
    if (isMatch !== inHighlight) {
      if (current) {
        const el = document.createElement('span');
        if (inHighlight) el.className = 'ff-match';
        el.textContent = current;
        span.appendChild(el);
      }
      current = '';
      inHighlight = isMatch;
    }
    current += filePath[i];
  }

  if (current) {
    const el = document.createElement('span');
    if (inHighlight) el.className = 'ff-match';
    el.textContent = current;
    span.appendChild(el);
  }

  return span;
}

export type FileOpenCallback = (filePath: string) => void;

export class FileFinder {
  private overlay: HTMLElement | null = null;
  private visible = false;
  private files: string[] = [];
  private selectedIndex = 0;
  private projectPath = '';
  private readonly onFileOpen: FileOpenCallback;

  constructor(onFileOpen: FileOpenCallback) {
    this.onFileOpen = onFileOpen;
  }

  isVisible(): boolean {
    return this.visible;
  }

  async toggle(projectPath: string): Promise<void> {
    if (this.visible) {
      this.hide();
    } else {
      await this.show(projectPath);
    }
  }

  async show(projectPath: string): Promise<void> {
    if (this.visible) return;
    this.projectPath = projectPath;
    this.visible = true;
    this.selectedIndex = 0;

    // Load files
    try {
      const result = await window.api.file.listAll(projectPath);
      if (Array.isArray(result)) {
        this.files = result;
      }
    } catch {
      this.files = [];
    }

    this.renderOverlay();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private renderOverlay(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'ff-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    const panel = document.createElement('div');
    panel.className = 'ff-panel';

    const input = document.createElement('input');
    input.className = 'ff-input';
    input.placeholder = 'Search files...';
    input.addEventListener('input', () => {
      this.selectedIndex = 0;
      this.renderResults(resultContainer, input.value);
    });
    input.addEventListener('keydown', (e) => this.handleKeydown(e, input.value, resultContainer));

    const resultContainer = document.createElement('div');
    resultContainer.className = 'ff-results';

    panel.appendChild(input);
    panel.appendChild(resultContainer);
    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);

    this.renderResults(resultContainer, '');
    input.focus();
  }

  private renderResults(container: HTMLElement, query: string): void {
    container.replaceChildren();

    let results: ScoredFile[];

    if (!query) {
      // Show first 50 files alphabetically when no query
      results = this.files.slice(0, 50).map((p) => ({ path: p, score: 0, matchIndices: [] }));
    } else {
      const scored: ScoredFile[] = [];
      for (const filePath of this.files) {
        const match = fuzzyMatchFile(filePath, query);
        if (match) {
          scored.push({ path: filePath, score: match.score, matchIndices: match.indices });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      results = scored.slice(0, 50);
    }

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ff-empty';
      empty.textContent = query ? 'No matching files' : 'No files found';
      container.appendChild(empty);
      return;
    }

    const fileCount = document.createElement('div');
    fileCount.className = 'ff-count';
    fileCount.textContent = `${this.files.length} files${query ? ` · ${results.length} matches` : ''}`;
    container.appendChild(fileCount);

    results.forEach((result, index) => {
      const item = document.createElement('div');
      item.className = `ff-item${index === this.selectedIndex ? ' selected' : ''}`;

      // Split path into directory and filename
      const lastSlash = result.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? result.path.slice(0, lastSlash + 1) : '';
      const filename = lastSlash >= 0 ? result.path.slice(lastSlash + 1) : result.path;

      if (query && result.matchIndices.length > 0) {
        const highlighted = highlightPath(result.path, result.matchIndices);
        highlighted.className = 'ff-path';
        item.appendChild(highlighted);
      } else {
        const pathEl = document.createElement('span');
        pathEl.className = 'ff-path';
        if (dir) {
          const dirEl = document.createElement('span');
          dirEl.className = 'ff-dir';
          dirEl.textContent = dir;
          pathEl.appendChild(dirEl);
        }
        const nameEl = document.createElement('span');
        nameEl.className = 'ff-filename';
        nameEl.textContent = filename;
        pathEl.appendChild(nameEl);
        item.appendChild(pathEl);
      }

      item.addEventListener('click', () => {
        this.openFile(result.path);
      });

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        container.querySelectorAll('.ff-item').forEach((el, i) => {
          el.classList.toggle('selected', i === index);
        });
      });

      container.appendChild(item);
    });
  }

  private handleKeydown(e: KeyboardEvent, query: string, container: HTMLElement): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex++;
        this.updateSelection(container);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.updateSelection(container);
        break;
      case 'Enter':
        e.preventDefault();
        const items = container.querySelectorAll('.ff-item');
        if (items[this.selectedIndex]) {
          const path = this.getResultPaths(query)[this.selectedIndex];
          if (path) this.openFile(path);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  }

  private getResultPaths(query: string): string[] {
    if (!query) return this.files.slice(0, 50);
    const scored: Array<{ path: string; score: number }> = [];
    for (const filePath of this.files) {
      const match = fuzzyMatchFile(filePath, query);
      if (match) scored.push({ path: filePath, score: match.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((s) => s.path);
  }

  private updateSelection(container: HTMLElement): void {
    const items = container.querySelectorAll('.ff-item');
    const maxIdx = items.length - 1;
    if (this.selectedIndex > maxIdx) this.selectedIndex = maxIdx;
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === this.selectedIndex);
    });
    // Scroll selected into view
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private openFile(relativePath: string): void {
    this.hide();
    const fullPath = this.projectPath + '/' + relativePath;
    this.onFileOpen(fullPath);
  }
}

// Step 2: First project — auto-detect git repos, browse, select

import type { StepRenderer } from './onboarding-wizard';

export class ProjectStep implements StepRenderer {
  private selectedPath: string | null = null;
  private projectCreated = false;

  render(container: HTMLElement): void {
    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = 'Open Your First Project';

    const subhead = document.createElement('p');
    subhead.className = 'onboarding-body';
    subhead.textContent = 'Point Hariari at a code directory.';

    const listContainer = document.createElement('div');
    listContainer.className = 'onboarding-project-list';

    const browseRow = document.createElement('div');
    browseRow.className = 'onboarding-browse-row';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'btn-secondary';
    browseBtn.textContent = 'Browse...';
    browseBtn.addEventListener('click', async () => {
      const dir = await window.api.project.pickDirectory();
      if (dir) {
        this.selectedPath = dir;
        this.highlightSelected(listContainer, dir);
        // Add a custom entry to the list
        const existing = listContainer.querySelector(`[data-path="${CSS.escape(dir)}"]`);
        if (!existing) {
          const name = dir.split('/').pop() ?? dir;
          const item = this.createProjectItem(name, dir, listContainer);
          listContainer.prepend(item);
          this.highlightSelected(listContainer, dir);
        }
      }
    });

    const browseLabel = document.createElement('span');
    browseLabel.className = 'onboarding-browse-label';
    browseLabel.textContent = 'Choose a directory';

    browseRow.appendChild(browseBtn);
    browseRow.appendChild(browseLabel);

    container.appendChild(headline);
    container.appendChild(subhead);
    container.appendChild(listContainer);
    container.appendChild(browseRow);

    // Auto-detect projects
    this.detectProjects(listContainer);
  }

  hasSelection(): boolean {
    return !!this.selectedPath;
  }

  async createProject(): Promise<boolean> {
    if (!this.selectedPath || this.projectCreated) return this.projectCreated;
    try {
      await window.api.project.create({ path: this.selectedPath });
      this.projectCreated = true;
      return true;
    } catch {
      return false;
    }
  }

  private async detectProjects(listContainer: HTMLElement): Promise<void> {
    const loading = document.createElement('div');
    loading.className = 'onboarding-loading';
    loading.textContent = 'Scanning for projects...';
    listContainer.appendChild(loading);

    try {
      const projects = await window.api.onboarding.detectProjects();
      loading.remove();

      if (projects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'onboarding-empty';
        empty.textContent = 'No git projects detected. Use Browse to select a directory.';
        listContainer.appendChild(empty);
        return;
      }

      const label = document.createElement('div');
      label.className = 'onboarding-section-label';
      label.textContent = 'Detected Projects';
      listContainer.appendChild(label);

      for (const project of projects) {
        const item = this.createProjectItem(project.name, project.path, listContainer);
        listContainer.appendChild(item);
      }
    } catch {
      loading.remove();
    }
  }

  private createProjectItem(name: string, projectPath: string, listContainer: HTMLElement): HTMLElement {
    const item = document.createElement('div');
    item.className = 'onboarding-project-item';
    item.dataset.path = projectPath;

    const icon = document.createElement('span');
    icon.className = 'onboarding-folder-icon';
    icon.textContent = '\uD83D\uDCC1';

    const info = document.createElement('div');
    info.className = 'onboarding-project-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'onboarding-project-name';
    nameEl.textContent = name;

    const pathEl = document.createElement('div');
    pathEl.className = 'onboarding-project-path';
    pathEl.textContent = projectPath.replace(/^\/home\/[^/]+/, '~');

    info.appendChild(nameEl);
    info.appendChild(pathEl);

    item.appendChild(icon);
    item.appendChild(info);

    item.addEventListener('click', () => {
      this.selectedPath = projectPath;
      this.highlightSelected(listContainer, projectPath);
    });

    return item;
  }

  private highlightSelected(listContainer: HTMLElement, selectedPath: string): void {
    listContainer.querySelectorAll('.onboarding-project-item').forEach((el) => {
      el.classList.toggle('selected', (el as HTMLElement).dataset.path === selectedPath);
    });
  }
}

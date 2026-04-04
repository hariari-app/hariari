// Launch Workspace dialog — guided setup: project + agents + layout

import type { ProjectInfo } from '../../../shared/ipc-types';
import type { AgentType } from '../../../shared/agent-types';
import { SPAWNABLE_AGENT_TYPES } from '../../../shared/agent-types';
import { createAgentIcon } from './agent-icons';
import type { LayoutPreset, PresetTree } from '../layout/layout-presets';

type LayoutMode = 'grid' | 'columns' | 'rows';

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI',
  pi: 'Pi', opencode: 'OpenCode', cline: 'Cline CLI',
  copilot: 'Copilot CLI', amp: 'Amp', continue: 'Continue',
  cursor: 'Cursor CLI', crush: 'Crush', qwen: 'Qwen Code', shell: 'Shell',
};

const AGENT_OPTIONS: AgentType[] = [...SPAWNABLE_AGENT_TYPES].filter((t) => t !== 'shell');
// Put shell at end
const ALL_OPTIONS: AgentType[] = [...AGENT_OPTIONS, 'shell'];

export interface LaunchWorkspaceResult {
  readonly project: ProjectInfo;
  readonly agents: readonly AgentType[];
  readonly layout: LayoutMode;
}

export class LaunchWorkspaceDialog {
  private overlay: HTMLElement | null = null;
  private visible = false;

  async show(
    onLaunch: (result: LaunchWorkspaceResult) => void,
  ): Promise<void> {
    if (this.visible) return;
    this.visible = true;

    const projects = await window.api.project.list();
    this.renderOverlay(projects, onLaunch);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private renderOverlay(
    projects: ProjectInfo[],
    onLaunch: (result: LaunchWorkspaceResult) => void,
  ): void {
    let selectedProject: ProjectInfo | null = projects[0] ?? null;
    let agentCount = 2;
    let agentSelections: AgentType[] = ['claude', 'shell'];
    let layoutMode: LayoutMode = 'columns';

    this.overlay = document.createElement('div');
    this.overlay.className = 'launch-ws-overlay';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    const card = document.createElement('div');
    card.className = 'launch-ws-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Launch Workspace');
    card.setAttribute('aria-modal', 'true');

    // Header
    const header = document.createElement('div');
    header.className = 'launch-ws-header';
    const title = document.createElement('span');
    title.className = 'launch-ws-title';
    title.textContent = 'Launch Workspace';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'file-viewer-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => this.hide());
    header.appendChild(title);
    header.appendChild(closeBtn);

    // === PROJECT SECTION ===
    const projectSection = document.createElement('div');
    projectSection.className = 'launch-ws-section';

    const projectLabel = document.createElement('div');
    projectLabel.className = 'launch-ws-section-label';
    projectLabel.textContent = 'Project';

    const projectList = document.createElement('div');
    projectList.className = 'launch-ws-project-list';

    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'launch-ws-project-row';
      if (project.id === selectedProject?.id) row.classList.add('selected');

      const icon = document.createElement('span');
      icon.className = 'launch-ws-folder-icon';
      icon.textContent = '\uD83D\uDCC1';

      const info = document.createElement('div');
      info.className = 'launch-ws-project-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'launch-ws-project-name';
      nameEl.textContent = project.name || project.path.split('/').pop() || project.path;
      const pathEl = document.createElement('div');
      pathEl.className = 'launch-ws-project-path';
      pathEl.textContent = project.path.replace(/^\/home\/[^/]+/, '~');
      info.appendChild(nameEl);
      info.appendChild(pathEl);

      row.appendChild(icon);
      row.appendChild(info);

      row.addEventListener('click', () => {
        selectedProject = project;
        projectList.querySelectorAll('.launch-ws-project-row').forEach((r) =>
          r.classList.remove('selected'));
        row.classList.add('selected');
      });

      projectList.appendChild(row);
    }

    const browseBtn = document.createElement('button');
    browseBtn.className = 'btn-secondary launch-ws-browse-btn';
    browseBtn.textContent = 'Browse...';
    browseBtn.addEventListener('click', async () => {
      const dir = await window.api.project.pickDirectory();
      if (dir) {
        const newProject = await window.api.project.create({ path: dir });
        selectedProject = newProject;
        // Add to list
        const name = dir.split('/').pop() || dir;
        const row = document.createElement('div');
        row.className = 'launch-ws-project-row selected';
        row.innerHTML = `<span class="launch-ws-folder-icon">\uD83D\uDCC1</span>
          <div class="launch-ws-project-info">
            <div class="launch-ws-project-name">${name}</div>
            <div class="launch-ws-project-path">${dir.replace(/^\/home\/[^/]+/, '~')}</div>
          </div>`;
        projectList.querySelectorAll('.launch-ws-project-row').forEach((r) =>
          r.classList.remove('selected'));
        projectList.appendChild(row);
      }
    });

    projectSection.appendChild(projectLabel);
    projectSection.appendChild(projectList);
    projectSection.appendChild(browseBtn);

    // === AGENTS SECTION ===
    const agentsSection = document.createElement('div');
    agentsSection.className = 'launch-ws-section';

    const agentsLabel = document.createElement('div');
    agentsLabel.className = 'launch-ws-section-label';
    agentsLabel.textContent = 'Agents';

    const countRow = document.createElement('div');
    countRow.className = 'launch-ws-count-row';

    const countLabel = document.createElement('span');
    countLabel.className = 'launch-ws-count-label';
    countLabel.textContent = 'How many?';

    const countBtns = document.createElement('div');
    countBtns.className = 'launch-ws-count-btns';

    const agentSlotsEl = document.createElement('div');
    agentSlotsEl.className = 'launch-ws-agent-slots';

    const renderSlots = () => {
      agentSlotsEl.replaceChildren();
      // Ensure agentSelections has the right count
      while (agentSelections.length < agentCount) {
        agentSelections = [...agentSelections, 'shell'];
      }
      agentSelections = agentSelections.slice(0, agentCount);

      for (let i = 0; i < agentCount; i++) {
        const slot = document.createElement('div');
        slot.className = 'launch-ws-agent-slot';

        const slotLabel = document.createElement('span');
        slotLabel.className = 'launch-ws-slot-label';
        slotLabel.textContent = `Agent ${i + 1}`;

        const select = document.createElement('select');
        select.className = 'launch-ws-agent-select';
        for (const type of ALL_OPTIONS) {
          const opt = document.createElement('option');
          opt.value = type;
          opt.textContent = AGENT_LABELS[type] ?? type;
          if (type === agentSelections[i]) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener('change', () => {
          agentSelections = agentSelections.map((v, j) =>
            j === i ? (select.value as AgentType) : v);
        });

        slot.appendChild(slotLabel);
        slot.appendChild(select);
        agentSlotsEl.appendChild(slot);
      }
    };

    for (const n of [1, 2, 3, 4, 6]) {
      const btn = document.createElement('button');
      btn.className = 'launch-ws-count-btn';
      btn.textContent = String(n);
      if (n === agentCount) btn.classList.add('active');
      btn.addEventListener('click', () => {
        agentCount = n;
        countBtns.querySelectorAll('.launch-ws-count-btn').forEach((b) =>
          b.classList.remove('active'));
        btn.classList.add('active');
        renderSlots();
      });
      countBtns.appendChild(btn);
    }

    countRow.appendChild(countLabel);
    countRow.appendChild(countBtns);

    agentsSection.appendChild(agentsLabel);
    agentsSection.appendChild(countRow);
    agentsSection.appendChild(agentSlotsEl);
    renderSlots();

    // === LAYOUT SECTION ===
    const layoutSection = document.createElement('div');
    layoutSection.className = 'launch-ws-section';

    const layoutLabel = document.createElement('div');
    layoutLabel.className = 'launch-ws-section-label';
    layoutLabel.textContent = 'Layout';

    const layoutBtns = document.createElement('div');
    layoutBtns.className = 'launch-ws-layout-btns';

    for (const mode of ['grid', 'columns', 'rows'] as LayoutMode[]) {
      const btn = document.createElement('button');
      btn.className = 'launch-ws-layout-btn';
      btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      if (mode === layoutMode) btn.classList.add('active');
      btn.addEventListener('click', () => {
        layoutMode = mode;
        layoutBtns.querySelectorAll('.launch-ws-layout-btn').forEach((b) =>
          b.classList.remove('active'));
        btn.classList.add('active');
      });
      layoutBtns.appendChild(btn);
    }

    layoutSection.appendChild(layoutLabel);
    layoutSection.appendChild(layoutBtns);

    // === ACTIONS ===
    const actions = document.createElement('div');
    actions.className = 'launch-ws-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());

    const launchBtn = document.createElement('button');
    launchBtn.className = 'btn-primary';
    launchBtn.textContent = 'Launch';
    launchBtn.addEventListener('click', () => {
      if (!selectedProject) return;
      this.hide();
      onLaunch({
        project: selectedProject,
        agents: [...agentSelections],
        layout: layoutMode,
      });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(launchBtn);

    // Assemble
    card.appendChild(header);
    card.appendChild(projectSection);
    card.appendChild(agentsSection);
    card.appendChild(layoutSection);
    card.appendChild(actions);

    this.overlay.appendChild(card);
    document.body.appendChild(this.overlay);

    // Escape to close
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide();
        document.removeEventListener('keydown', onEsc);
      }
    };
    document.addEventListener('keydown', onEsc);
  }
}

// Build a layout preset from user selections
export function buildDynamicPreset(agents: readonly AgentType[], layout: LayoutMode): LayoutPreset {
  const slots = agents.map((type) => ({ type, label: AGENT_LABELS[type] ?? type }));

  return {
    id: 'dynamic-launch',
    label: 'Custom Launch',
    description: `${agents.length} agents in ${layout} layout`,
    slots,
    buildTree: (sessionIds) => buildTree(sessionIds.length, layout),
  };
}

function buildTree(count: number, layout: LayoutMode): PresetTree {
  if (count === 1) {
    return { type: 'leaf', slotIndex: 0 };
  }

  if (layout === 'columns') {
    return buildLinear(count, 'horizontal');
  }

  if (layout === 'rows') {
    return buildLinear(count, 'vertical');
  }

  // Grid: split into rows of 2-3
  return buildGrid(count);
}

function buildLinear(count: number, direction: 'horizontal' | 'vertical'): PresetTree {
  if (count === 1) return { type: 'leaf', slotIndex: 0 };
  if (count === 2) {
    return {
      type: 'split', direction, ratio: 0.5,
      children: [{ type: 'leaf', slotIndex: 0 }, { type: 'leaf', slotIndex: 1 }],
    };
  }

  // Recursive: first pane + rest
  return {
    type: 'split', direction, ratio: 1 / count,
    children: [
      { type: 'leaf', slotIndex: 0 },
      shiftIndices(buildLinear(count - 1, direction), 1),
    ],
  };
}

function buildGrid(count: number): PresetTree {
  if (count <= 2) return buildLinear(count, 'horizontal');

  const cols = count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);

  const buildRow = (startIdx: number, itemsInRow: number): PresetTree => {
    if (itemsInRow === 1) return { type: 'leaf', slotIndex: startIdx };
    return {
      type: 'split', direction: 'horizontal', ratio: 1 / itemsInRow,
      children: [
        { type: 'leaf', slotIndex: startIdx },
        shiftIndices(buildRow(0, itemsInRow - 1), startIdx + 1),
      ],
    };
  };

  if (rows === 1) return buildRow(0, count);

  let idx = 0;
  const rowTrees: PresetTree[] = [];
  for (let r = 0; r < rows; r++) {
    const itemsInRow = Math.min(cols, count - idx);
    rowTrees.push(buildRow(idx, itemsInRow));
    idx += itemsInRow;
  }

  // Stack rows vertically
  let result = rowTrees[rowTrees.length - 1];
  for (let i = rowTrees.length - 2; i >= 0; i--) {
    result = {
      type: 'split', direction: 'vertical', ratio: 1 / (rowTrees.length - i),
      children: [rowTrees[i], result],
    };
  }
  return result;
}

function shiftIndices(tree: PresetTree, offset: number): PresetTree {
  if (tree.type === 'leaf') {
    return { type: 'leaf', slotIndex: tree.slotIndex + offset };
  }
  return {
    ...tree,
    children: [
      shiftIndices(tree.children[0], offset),
      shiftIndices(tree.children[1], offset),
    ],
  };
}

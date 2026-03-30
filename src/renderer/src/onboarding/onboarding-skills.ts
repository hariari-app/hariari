// Step 2: AI Skills selection — preset or custom pick

import type { StepRenderer } from './onboarding-wizard';
import type { SkillManifest, SkillItem, SkillCategory } from '../../../shared/skills-types';
import type { AgentType } from '../../../shared/agent-types';

let renderGeneration = 0;

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  language: 'Languages',
  quality: 'Code Quality',
  testing: 'Testing',
  security: 'Security',
  patterns: 'Patterns',
  workflow: 'Workflow',
  agent: 'Agent Definitions',
};

const VISIBLE_PER_CATEGORY = 4;

export class SkillsStep implements StepRenderer {
  private manifest: SkillManifest | null = null;
  private selectedSkillIds = new Set<string>();
  private installedAgents: AgentType[] = [];
  private mode: 'recommended' | 'custom' = 'recommended';
  private detectedLanguages: string[] = [];

  setInstalledAgents(agents: AgentType[]): void {
    this.installedAgents = agents;
  }

  setDetectedLanguages(languages: string[]): void {
    this.detectedLanguages = languages;
  }

  getSelectedSkillIds(): readonly string[] {
    return [...this.selectedSkillIds];
  }

  getInstalledAgents(): readonly AgentType[] {
    return this.installedAgents;
  }

  render(container: HTMLElement): void {
    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = 'Enhance Your Agents';

    const subhead = document.createElement('p');
    subhead.className = 'onboarding-body';
    subhead.textContent = 'Pre-configured skills, coding standards, and agent definitions.';

    container.appendChild(headline);
    container.appendChild(subhead);

    // Load manifest (guard against stale async responses)
    const gen = ++renderGeneration;
    window.api.skills.manifest().then((manifest) => {
      if (gen !== renderGeneration) return; // stale — user navigated away
      this.manifest = manifest;
      this.applyPreset('recommended');
      this.renderContent(container);
    }).catch(() => {
      const error = document.createElement('div');
      error.className = 'onboarding-empty';
      error.textContent = 'Unable to load skills catalog. You can install skills later from Settings.';
      container.appendChild(error);
    });
  }

  cleanup(): void {
    renderGeneration++; // invalidate any pending async manifest fetch
  }

  async install(): Promise<{ installed: number; failed: number }> {
    if (this.selectedSkillIds.size === 0) return { installed: 0, failed: 0 };

    try {
      const result = await window.api.skills.install({
        skillIds: [...this.selectedSkillIds],
        targetAgents: this.installedAgents,
      });
      return { installed: result.summary.installed, failed: result.summary.failed };
    } catch {
      return { installed: 0, failed: 0 };
    }
  }

  private applyPreset(presetId: string): void {
    if (!this.manifest) return;
    const preset = this.manifest.presets.find((p) => p.id === presetId);
    if (preset) {
      this.selectedSkillIds = new Set(preset.skillIds);
    }

    // Auto-add language rules for detected languages
    for (const lang of this.detectedLanguages) {
      const langSkill = this.manifest.skills.find(
        (s) => s.category === 'language' && s.languages?.includes(lang),
      );
      if (langSkill) this.selectedSkillIds.add(langSkill.id);
    }
  }

  private renderContent(container: HTMLElement): void {
    if (!this.manifest) return;

    // Mode selector
    const modeRow = document.createElement('div');
    modeRow.className = 'onboarding-skills-mode';

    const recommendedBtn = document.createElement('button');
    recommendedBtn.className = 'onboarding-skills-mode-btn';
    recommendedBtn.textContent = 'Recommended';
    if (this.mode === 'recommended') recommendedBtn.classList.add('active');

    const customBtn = document.createElement('button');
    customBtn.className = 'onboarding-skills-mode-btn';
    customBtn.textContent = 'Custom';
    if (this.mode === 'custom') customBtn.classList.add('active');

    recommendedBtn.addEventListener('click', () => {
      this.mode = 'recommended';
      this.applyPreset('recommended');
      this.refreshContent(container);
    });

    customBtn.addEventListener('click', () => {
      this.mode = 'custom';
      this.refreshContent(container);
    });

    modeRow.appendChild(recommendedBtn);
    modeRow.appendChild(customBtn);
    container.appendChild(modeRow);

    // Count
    const countEl = document.createElement('div');
    countEl.className = 'onboarding-agent-count';
    countEl.textContent = `${this.selectedSkillIds.size} skills selected`;
    container.appendChild(countEl);

    if (this.mode === 'recommended') {
      this.renderRecommendedView(container);
    } else {
      this.renderCustomView(container);
    }
  }

  private refreshContent(container: HTMLElement): void {
    // Keep headline and subhead, remove the rest
    while (container.children.length > 2) {
      container.removeChild(container.lastChild!);
    }
    this.renderContent(container);
  }

  private renderRecommendedView(container: HTMLElement): void {
    if (!this.manifest) return;

    const preset = this.manifest.presets.find((p) => p.id === 'recommended');
    if (!preset) return;

    const desc = document.createElement('p');
    desc.className = 'onboarding-hint';
    desc.textContent = preset.description;

    // Show detected languages
    if (this.detectedLanguages.length > 0) {
      const langNote = document.createElement('div');
      langNote.className = 'onboarding-skills-detected';
      langNote.textContent = `+ ${this.detectedLanguages.join(', ')} rules (auto-detected)`;
      container.appendChild(langNote);
    }

    container.appendChild(desc);

    // Show selected items as a simple list
    const list = document.createElement('div');
    list.className = 'onboarding-skills-list';

    for (const skillId of this.selectedSkillIds) {
      const skill = this.manifest.skills.find((s) => s.id === skillId);
      if (!skill) continue;
      const item = document.createElement('div');
      item.className = 'onboarding-skills-item';
      item.textContent = `\u2713 ${skill.name}`;
      list.appendChild(item);
    }

    container.appendChild(list);
  }

  private renderCustomView(container: HTMLElement): void {
    if (!this.manifest) return;

    // Group by category
    const groups = new Map<SkillCategory, SkillItem[]>();
    for (const skill of this.manifest.skills) {
      if (!groups.has(skill.category)) groups.set(skill.category, []);
      groups.get(skill.category)!.push(skill);
    }

    // Render Languages first, then Capabilities
    const categoryOrder: SkillCategory[] = ['language', 'quality', 'testing', 'security', 'patterns', 'workflow', 'agent'];

    for (const category of categoryOrder) {
      const skills = groups.get(category);
      if (!skills || skills.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'onboarding-skills-section';

      const label = document.createElement('div');
      label.className = 'onboarding-section-label';
      label.textContent = CATEGORY_LABELS[category] ?? category;
      section.appendChild(label);

      const visible = skills.slice(0, VISIBLE_PER_CATEGORY);
      const overflow = skills.slice(VISIBLE_PER_CATEGORY);

      for (const skill of visible) {
        section.appendChild(this.createSkillCheckbox(skill, container));
      }

      if (overflow.length > 0) {
        const overflowContainer = document.createElement('div');
        overflowContainer.style.display = 'none';
        for (const skill of overflow) {
          overflowContainer.appendChild(this.createSkillCheckbox(skill, container));
        }

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'onboarding-toggle-more';
        toggleBtn.textContent = `Show ${overflow.length} more`;
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.addEventListener('click', () => {
          const isHidden = overflowContainer.style.display === 'none';
          overflowContainer.style.display = isHidden ? '' : 'none';
          toggleBtn.textContent = isHidden ? 'Show fewer' : `Show ${overflow.length} more`;
          toggleBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
        });

        section.appendChild(toggleBtn);
        section.appendChild(overflowContainer);
      }

      container.appendChild(section);
    }
  }

  private createSkillCheckbox(skill: SkillItem, container: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'onboarding-skills-checkbox-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'notif-prefs-checkbox';
    checkbox.checked = this.selectedSkillIds.has(skill.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        this.selectedSkillIds.add(skill.id);
      } else {
        this.selectedSkillIds.delete(skill.id);
      }
      // Update count
      const countEl = container.querySelector('.onboarding-agent-count');
      if (countEl) countEl.textContent = `${this.selectedSkillIds.size} skills selected`;
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'onboarding-skills-name';
    nameEl.textContent = skill.name;

    const descEl = document.createElement('span');
    descEl.className = 'onboarding-skills-desc';
    descEl.textContent = skill.description;

    const isDetected = skill.category === 'language' && skill.languages?.some((l) => this.detectedLanguages.includes(l));
    if (isDetected) {
      const badge = document.createElement('span');
      badge.className = 'onboarding-skills-detected-badge';
      badge.textContent = 'detected';
      row.appendChild(checkbox);
      row.appendChild(nameEl);
      row.appendChild(badge);
    } else {
      row.appendChild(checkbox);
      row.appendChild(nameEl);
    }

    row.appendChild(descEl);
    return row;
  }
}

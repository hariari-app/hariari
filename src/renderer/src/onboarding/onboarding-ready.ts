// Step 4: Ready — summary + keyboard shortcuts + launch

import type { StepRenderer } from './onboarding-wizard';

const SHORTCUTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'Ctrl+Shift+P', label: 'Command palette' },
  { key: 'Ctrl+Shift+N', label: 'New shell terminal' },
  { key: 'Ctrl+Shift+D', label: 'Split pane' },
  { key: 'F3 / F4', label: 'Voice dictate / command' },
  { key: 'Ctrl+B', label: 'Toggle sidebar' },
];

export class ReadyStep implements StepRenderer {
  private agentCount = 0;
  private projectCount = 0;

  setAgentCount(count: number): void {
    this.agentCount = count;
  }

  setProjectCount(count: number): void {
    this.projectCount = count;
  }

  render(container: HTMLElement): void {
    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = "You're all set.";

    // Summary
    const summary = document.createElement('div');
    summary.className = 'onboarding-summary';

    const agentLine = document.createElement('div');
    agentLine.className = 'onboarding-summary-item';
    agentLine.textContent = `${this.agentCount} agent${this.agentCount === 1 ? '' : 's'} installed`;

    const projectLine = document.createElement('div');
    projectLine.className = 'onboarding-summary-item';
    projectLine.textContent = `${this.projectCount} project${this.projectCount === 1 ? '' : 's'} added`;

    summary.appendChild(agentLine);
    summary.appendChild(projectLine);

    // Shortcuts
    const shortcutsLabel = document.createElement('div');
    shortcutsLabel.className = 'onboarding-section-label';
    shortcutsLabel.textContent = 'Keyboard shortcuts';

    const shortcutsTable = document.createElement('div');
    shortcutsTable.className = 'onboarding-shortcuts';

    for (const { key, label } of SHORTCUTS) {
      const row = document.createElement('div');
      row.className = 'onboarding-shortcut-row';

      const kbd = document.createElement('kbd');
      kbd.className = 'onboarding-kbd';
      kbd.textContent = key;

      const desc = document.createElement('span');
      desc.className = 'onboarding-shortcut-label';
      desc.textContent = label;

      row.appendChild(kbd);
      row.appendChild(desc);
      shortcutsTable.appendChild(row);
    }

    container.appendChild(headline);
    container.appendChild(summary);
    container.appendChild(shortcutsLabel);
    container.appendChild(shortcutsTable);
  }
}

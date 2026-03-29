// Step 3: Quick tour — 4 tabbed feature cards

import type { StepRenderer } from './onboarding-wizard';

interface FeatureCard {
  readonly title: string;
  readonly description: string;
  readonly shortcut: string;
  readonly illustration: string;
}

const FEATURES: readonly FeatureCard[] = [
  {
    title: 'Spawn an Agent',
    description: 'Click + in the sidebar or use the command palette to launch any AI agent into a terminal pane.',
    shortcut: 'Ctrl+Shift+P',
    illustration: `<svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="30" height="76" rx="4" stroke="var(--border)" stroke-width="1.5" fill="var(--bg-deep)"/>
      <rect x="36" y="2" width="82" height="76" rx="4" stroke="var(--border)" stroke-width="1.5" fill="var(--bg)"/>
      <text x="17" y="20" fill="var(--accent)" font-size="16" text-anchor="middle">+</text>
      <path d="M46 20l5 5-5 5" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round"/>
      <rect x="55" y="20" width="20" height="2" rx="1" fill="var(--fg-dim)"/>
      <rect x="55" y="26" width="35" height="2" rx="1" fill="var(--fg-faint)"/>
      <rect x="55" y="32" width="25" height="2" rx="1" fill="var(--fg-faint)"/>
      <circle cx="108" cy="12" r="4" fill="var(--success)" opacity="0.6"/>
    </svg>`,
  },
  {
    title: 'Split Panes',
    description: 'Run multiple agents side by side. Use the split buttons in the status bar or keyboard shortcuts.',
    shortcut: 'Ctrl+Shift+D',
    illustration: `<svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="56" height="76" rx="4" stroke="var(--border)" stroke-width="1.5" fill="var(--bg)"/>
      <rect x="62" y="2" width="56" height="76" rx="4" stroke="var(--border)" stroke-width="1.5" fill="var(--bg)"/>
      <circle cx="20" cy="14" r="3" fill="var(--accent)" opacity="0.8"/>
      <text x="28" y="17" fill="var(--fg-dim)" font-size="8">Claude</text>
      <circle cx="80" cy="14" r="3" fill="#14b8a6" opacity="0.8"/>
      <text x="88" y="17" fill="var(--fg-dim)" font-size="8">Aider</text>
      <path d="M12 28l4 4-4 4" stroke="var(--success)" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M72 28l4 4-4 4" stroke="var(--success)" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
  },
  {
    title: 'Voice Input',
    description: 'Hold F3 to dictate text into the terminal, or F4 for voice commands like "split vertical" or "new claude".',
    shortcut: 'F3 / F4',
    illustration: `<svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="25" width="12" height="30" rx="6" stroke="var(--error)" stroke-width="2" fill="none"/>
      <path d="M14 45c0 10 8 16 18 16s18-6 18-16" stroke="var(--error)" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M32 61v8M26 69h12" stroke="var(--error)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M55 40h50" stroke="var(--fg-faint)" stroke-width="1" stroke-dasharray="3 3"/>
      <rect x="55" y="35" width="55" height="12" rx="3" stroke="var(--border)" stroke-width="1" fill="var(--bg-deep)"/>
      <text x="60" y="44" fill="var(--fg-dim)" font-size="7">add dark mode to settings</text>
    </svg>`,
  },
  {
    title: 'Git Worktrees',
    description: 'Each agent works in its own git worktree. Review changes and merge with one click when done.',
    shortcut: 'Auto',
    illustration: `<svg viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="30" cy="15" r="4" fill="var(--accent)"/>
      <path d="M30 19v20" stroke="var(--accent)" stroke-width="2"/>
      <circle cx="30" cy="43" r="4" fill="var(--accent)"/>
      <path d="M30 47v15" stroke="var(--accent)" stroke-width="2"/>
      <circle cx="30" cy="66" r="4" fill="var(--accent)"/>
      <path d="M34 19c15 0 25 5 25 20" stroke="var(--success)" stroke-width="1.5" fill="none"/>
      <circle cx="59" cy="39" r="3" fill="var(--success)"/>
      <text x="66" y="42" fill="var(--fg-dim)" font-size="7">claude-a1b2</text>
      <path d="M34 19c25 0 40 8 40 25" stroke="var(--warning)" stroke-width="1.5" fill="none"/>
      <circle cx="74" cy="44" r="3" fill="var(--warning)"/>
      <text x="81" y="47" fill="var(--fg-dim)" font-size="7">aider-c3d4</text>
      <rect x="85" y="60" width="30" height="12" rx="3" fill="var(--success)" opacity="0.2" stroke="var(--success)" stroke-width="1"/>
      <text x="92" y="69" fill="var(--success)" font-size="7">Merge</text>
    </svg>`,
  },
];

export class TourStep implements StepRenderer {
  private activeTab = 0;

  render(container: HTMLElement): void {
    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = 'Quick Tour';

    const tabs = document.createElement('div');
    tabs.className = 'onboarding-tour-tabs';
    tabs.setAttribute('role', 'tablist');

    const panel = document.createElement('div');
    panel.className = 'onboarding-tour-panel';
    panel.setAttribute('role', 'tabpanel');

    FEATURES.forEach((feature, i) => {
      const tab = document.createElement('button');
      tab.className = 'onboarding-tour-tab';
      tab.textContent = feature.title;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      tab.addEventListener('click', () => this.switchTab(i, tabs, panel));
      tabs.appendChild(tab);
    });

    container.appendChild(headline);
    container.appendChild(tabs);
    container.appendChild(panel);

    this.renderFeature(panel, FEATURES[0]);
  }

  private switchTab(index: number, tabs: HTMLElement, panel: HTMLElement): void {
    this.activeTab = index;
    tabs.querySelectorAll('.onboarding-tour-tab').forEach((tab, i) => {
      tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    this.renderFeature(panel, FEATURES[index]);
  }

  private renderFeature(panel: HTMLElement, feature: FeatureCard): void {
    panel.replaceChildren();

    const illustration = document.createElement('div');
    illustration.className = 'onboarding-tour-illustration';
    illustration.innerHTML = feature.illustration;

    const title = document.createElement('h3');
    title.className = 'onboarding-tour-title';
    title.textContent = feature.title;

    const desc = document.createElement('p');
    desc.className = 'onboarding-tour-desc';
    desc.textContent = feature.description;

    const shortcut = document.createElement('div');
    shortcut.className = 'onboarding-tour-shortcut';

    const kbd = document.createElement('kbd');
    kbd.textContent = feature.shortcut;
    shortcut.appendChild(kbd);

    panel.appendChild(illustration);
    panel.appendChild(title);
    panel.appendChild(desc);
    panel.appendChild(shortcut);
  }
}

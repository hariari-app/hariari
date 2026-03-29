// Step 0: Welcome screen

import type { StepRenderer } from './onboarding-wizard';

export class WelcomeStep implements StepRenderer {
  render(container: HTMLElement): void {
    const logo = document.createElement('div');
    logo.className = 'onboarding-logo';
    logo.innerHTML = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="8" width="40" height="32" rx="4" stroke="var(--accent)" stroke-width="2.5" fill="none"/>
      <path d="M12 18l6 6-6 6" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M24 30h12" stroke="var(--fg-dim)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="38" cy="14" r="3" fill="var(--success)"/>
      <circle cx="30" cy="14" r="3" fill="var(--warning)"/>
    </svg>`;

    const headline = document.createElement('h2');
    headline.className = 'onboarding-headline';
    headline.textContent = 'One terminal to rule them all.';

    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = 'Run Claude, Gemini, Aider, and 9 more AI agents side by side \u2014 in split panes, with voice input and git worktree isolation.';

    container.appendChild(logo);
    container.appendChild(headline);
    container.appendChild(body);
  }
}

// Onboarding wizard — 5-step first-run experience

import { WelcomeStep } from './onboarding-welcome';
import { AgentsStep } from './onboarding-agents';
import { ProjectStep } from './onboarding-project';
import { TourStep } from './onboarding-tour';
import { ReadyStep } from './onboarding-ready';

export interface StepRenderer {
  render(container: HTMLElement): void;
  cleanup?(): void;
}

interface OnboardingOptions {
  readonly initialStep: number;
  readonly onComplete: () => void;
  readonly onSkip: () => void;
}

const STEP_LABELS = ['Welcome', 'Agents', 'Project', 'Tour', 'Ready'];
const TOTAL_STEPS = 5;

export class OnboardingWizard {
  private currentStep: number;
  private readonly overlay: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly dotsEl: HTMLElement;
  private readonly backBtn: HTMLElement;
  private readonly nextBtn: HTMLElement;
  private readonly onComplete: () => void;
  private readonly onSkip: () => void;

  private readonly welcomeStep = new WelcomeStep();
  private readonly agentsStep = new AgentsStep();
  private readonly projectStep = new ProjectStep();
  private readonly tourStep = new TourStep();
  private readonly readyStep = new ReadyStep();

  private readonly steps: StepRenderer[];

  constructor(parent: HTMLElement, options: OnboardingOptions) {
    this.currentStep = options.initialStep;
    this.onComplete = options.onComplete;
    this.onSkip = options.onSkip;

    this.steps = [
      this.welcomeStep,
      this.agentsStep,
      this.projectStep,
      this.tourStep,
      this.readyStep,
    ];

    // Overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'onboarding-overlay';

    // Card
    const card = document.createElement('div');
    card.className = 'onboarding-card';

    // Content area
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'onboarding-content';

    // Step indicators
    this.dotsEl = document.createElement('div');
    this.dotsEl.className = 'onboarding-step-indicators';
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const dot = document.createElement('span');
      dot.className = 'onboarding-dot';
      dot.title = STEP_LABELS[i];
      this.dotsEl.appendChild(dot);
    }

    // Navigation
    const nav = document.createElement('div');
    nav.className = 'onboarding-nav';

    this.backBtn = document.createElement('button');
    this.backBtn.className = 'btn-secondary';
    this.backBtn.textContent = '\u2190 Back';
    this.backBtn.addEventListener('click', () => this.goTo(this.currentStep - 1));

    this.nextBtn = document.createElement('button');
    this.nextBtn.className = 'btn-primary';
    this.nextBtn.textContent = 'Get Started';
    this.nextBtn.addEventListener('click', () => this.handleNext());

    const skipBtn = document.createElement('button');
    skipBtn.className = 'onboarding-skip';
    skipBtn.textContent = 'Skip setup';
    skipBtn.addEventListener('click', () => this.skip());

    nav.appendChild(this.backBtn);
    nav.appendChild(skipBtn);
    nav.appendChild(this.nextBtn);

    card.appendChild(this.contentEl);
    card.appendChild(this.dotsEl);
    card.appendChild(nav);

    this.overlay.appendChild(card);
    parent.appendChild(this.overlay);

    // Escape to skip
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.isConnected) {
        this.skip();
      }
    });

    this.goTo(this.currentStep);
  }

  show(): void {
    this.overlay.style.display = '';
    requestAnimationFrame(() => this.overlay.classList.add('onboarding-visible'));
  }

  private async handleNext(): Promise<void> {
    // Special actions per step before advancing
    if (this.currentStep === 2 && this.projectStep.hasSelection()) {
      await this.projectStep.createProject();
    }

    if (this.currentStep === TOTAL_STEPS - 1) {
      this.complete();
    } else {
      this.goTo(this.currentStep + 1);
    }
  }

  private goTo(step: number): void {
    if (step < 0 || step >= TOTAL_STEPS) return;

    // Cleanup current step
    this.steps[this.currentStep]?.cleanup?.();

    this.currentStep = step;

    // Persist step
    this.saveStep(step);

    // Render content
    this.contentEl.replaceChildren();

    // Pre-render setup for ready step
    if (step === TOTAL_STEPS - 1) {
      this.readyStep.setAgentCount(this.agentsStep.getInstalledCount());
      window.api.project.list().then((projects) => {
        this.readyStep.setProjectCount(projects.length);
      });
    }

    this.steps[step].render(this.contentEl);

    // Update dots
    this.dotsEl.querySelectorAll('.onboarding-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === step);
      dot.classList.toggle('completed', i < step);
    });

    // Update nav buttons
    this.backBtn.style.display = step === 0 ? 'none' : '';
    this.nextBtn.textContent = step === 0
      ? 'Get Started'
      : step === TOTAL_STEPS - 1
        ? 'Start Building'
        : 'Next \u2192';
  }

  private async complete(): Promise<void> {
    await this.saveComplete();
    this.agentsStep.cleanup?.();
    this.overlay.classList.remove('onboarding-visible');
    setTimeout(() => {
      this.overlay.remove();
      this.onComplete();
    }, 200);
  }

  private async skip(): Promise<void> {
    await this.saveComplete();
    this.agentsStep.cleanup?.();
    this.overlay.remove();
    this.onSkip();
  }

  private async saveStep(step: number): Promise<void> {
    try {
      const settings = await window.api.settings.load();
      await window.api.settings.save({ ...settings, onboardingStep: step });
    } catch { /* best-effort */ }
  }

  private async saveComplete(): Promise<void> {
    try {
      const settings = await window.api.settings.load();
      await window.api.settings.save({
        ...settings,
        onboardingComplete: true,
        onboardingStep: null,
      });
    } catch { /* best-effort */ }
  }
}

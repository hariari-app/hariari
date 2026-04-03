// In-app toast notifications — top-right corner, auto-dismiss, stackable

import { getNotificationConfig, type NotificationEvent } from './notification-config';

export interface ToastOptions {
  readonly event: NotificationEvent;
  readonly agentName: string;
  readonly agentType: string;
  readonly message: string;
  readonly onClick?: () => void;
}

export interface GenericToastOptions {
  readonly title: string;
  readonly message: string;
  readonly color?: string;
  readonly persistent?: boolean;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly onDismiss?: () => void;
}

interface ActiveToast {
  readonly id: number;
  readonly element: HTMLElement;
  dismissTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_VISIBLE = 5;
const EVENT_COLORS: Record<NotificationEvent, string> = {
  'needs-input': 'var(--warning)',
  complete: 'var(--success)',
  error: 'var(--error)',
};
const EVENT_LABELS: Record<NotificationEvent, string> = {
  'needs-input': 'Needs Input',
  complete: 'Complete',
  error: 'Error',
};

class ToastManager {
  private readonly container: HTMLElement;
  private readonly toasts = new Map<number, ActiveToast>();
  private nextId = 0;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  }

  show(options: ToastOptions): void {
    const config = getNotificationConfig();
    if (!config.events[options.event].toast) return;

    // Enforce max visible
    while (this.toasts.size >= MAX_VISIBLE) {
      const oldest = this.toasts.values().next().value;
      if (oldest) this.dismiss(oldest.id);
    }

    const id = this.nextId++;
    const element = this.createToastElement(id, options);

    this.container.appendChild(element);

    // Trigger entrance animation on next frame
    requestAnimationFrame(() => element.classList.add('toast-entering'));

    const dismissTimer = setTimeout(
      () => this.dismiss(id),
      config.toastDurationMs,
    );

    const toast: ActiveToast = { id, element, dismissTimer };
    this.toasts.set(id, toast);

    // Pause auto-dismiss on hover
    element.addEventListener('mouseenter', () => {
      if (toast.dismissTimer) {
        clearTimeout(toast.dismissTimer);
        toast.dismissTimer = null;
      }
    });
    element.addEventListener('mouseleave', () => {
      toast.dismissTimer = setTimeout(
        () => this.dismiss(id),
        config.toastDurationMs,
      );
    });
  }

  showGeneric(options: GenericToastOptions): number {
    // Enforce max visible
    while (this.toasts.size >= MAX_VISIBLE) {
      const oldest = this.toasts.values().next().value;
      if (oldest) this.dismiss(oldest.id);
    }

    const id = this.nextId++;
    const element = this.createGenericToastElement(id, options);

    this.container.appendChild(element);
    requestAnimationFrame(() => element.classList.add('toast-entering'));

    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    if (!options.persistent) {
      dismissTimer = setTimeout(() => this.dismiss(id), 8000);
    }

    const toast: ActiveToast = { id, element, dismissTimer };
    this.toasts.set(id, toast);

    if (!options.persistent) {
      element.addEventListener('mouseenter', () => {
        if (toast.dismissTimer) {
          clearTimeout(toast.dismissTimer);
          toast.dismissTimer = null;
        }
      });
      element.addEventListener('mouseleave', () => {
        toast.dismissTimer = setTimeout(() => this.dismiss(id), 8000);
      });
    }

    return id;
  }

  dismiss(id: number): void {
    const toast = this.toasts.get(id);
    if (!toast) return;

    if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
    this.toasts.delete(id);

    toast.element.classList.remove('toast-entering');
    toast.element.classList.add('toast-exiting');
    setTimeout(() => toast.element.remove(), 200);
  }

  dismissAll(): void {
    for (const id of [...this.toasts.keys()]) {
      this.dismiss(id);
    }
  }

  private createToastElement(id: number, options: ToastOptions): HTMLElement {
    const toast = document.createElement('div');
    toast.className = `toast toast--${options.event}`;
    toast.setAttribute('role', 'alert');

    // Color dot
    const dot = document.createElement('span');
    dot.className = 'toast-dot';
    dot.style.background = EVENT_COLORS[options.event];

    // Content
    const content = document.createElement('div');
    content.className = 'toast-content';

    const header = document.createElement('div');
    header.className = 'toast-header';

    const name = document.createElement('span');
    name.className = 'toast-agent-name';
    name.textContent = options.agentName;

    const badge = document.createElement('span');
    badge.className = 'toast-event-badge';
    badge.textContent = EVENT_LABELS[options.event];
    badge.style.color = EVENT_COLORS[options.event];

    header.appendChild(name);
    header.appendChild(badge);

    const message = document.createElement('div');
    message.className = 'toast-message';
    message.textContent = options.message;

    content.appendChild(header);
    content.appendChild(message);

    // Close button
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismiss(id);
    });
    close.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.dismiss(id);
      }
    });

    toast.appendChild(dot);
    toast.appendChild(content);
    toast.appendChild(close);

    // Click to navigate
    if (options.onClick) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        options.onClick!();
        this.dismiss(id);
      });
    }

    return toast;
  }
  private createGenericToastElement(id: number, options: GenericToastOptions): HTMLElement {
    const toast = document.createElement('div');
    toast.className = 'toast toast--generic';
    toast.setAttribute('role', 'alert');

    const dot = document.createElement('span');
    dot.className = 'toast-dot';
    dot.style.background = options.color ?? 'var(--accent)';

    const content = document.createElement('div');
    content.className = 'toast-content';

    const header = document.createElement('div');
    header.className = 'toast-header';

    const title = document.createElement('span');
    title.className = 'toast-agent-name';
    title.textContent = options.title;

    header.appendChild(title);

    const message = document.createElement('div');
    message.className = 'toast-message';
    message.textContent = options.message;

    content.appendChild(header);
    content.appendChild(message);

    if (options.actionLabel && options.onAction) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action';
      actionBtn.textContent = options.actionLabel;
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        options.onAction!();
        this.dismiss(id);
      });
      content.appendChild(actionBtn);
    }

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      options.onDismiss?.();
      this.dismiss(id);
    });

    toast.appendChild(dot);
    toast.appendChild(content);
    toast.appendChild(close);

    return toast;
  }
}

export const toastManager = new ToastManager();

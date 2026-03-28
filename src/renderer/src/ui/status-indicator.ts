import type { AgentStatus } from '../../../shared/agent-types';

const STATUS_SYMBOLS: Record<string, string> = {
  'running': '|||',
  'needs-input': '!',
  'error': '\u00D7',
  'complete': '\u2713',
  'idle': '\u2013',
  'starting': '\u2026',
  'stopped': '\u2013',
};

export function createStatusIndicator(status: AgentStatus | string): HTMLElement {
  const indicator = document.createElement('span');
  indicator.className = 'status-indicator';

  const dot = document.createElement('span');
  dot.className = `status-dot status-${status}`;

  const symbol = document.createElement('span');
  symbol.className = `status-symbol status-symbol-${status}`;
  symbol.textContent = STATUS_SYMBOLS[status] ?? '';

  indicator.appendChild(dot);
  indicator.appendChild(symbol);
  return indicator;
}

export function updateStatusIndicator(indicator: HTMLElement, status: AgentStatus | string): void {
  const dot = indicator.querySelector('.status-dot');
  const symbol = indicator.querySelector('.status-symbol');
  if (dot) dot.className = `status-dot status-${status}`;
  if (symbol) {
    symbol.className = `status-symbol status-symbol-${status}`;
    symbol.textContent = STATUS_SYMBOLS[status] ?? '';
  }
}

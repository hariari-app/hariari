import type { RuntimeRendererStatus } from '../../shared/ipc-types';

export interface RuntimeHealthViewModel {
  readonly state: RuntimeRendererStatus['state'];
  readonly visibleText: string;
  readonly detail: string;
  readonly announcement: string;
}

export interface RuntimeHealthApi {
  getStatus(): Promise<RuntimeRendererStatus>;
  onStatus(callback: (status: RuntimeRendererStatus) => void): () => void;
}

interface RuntimeHealthElements {
  readonly root: HTMLElement;
  readonly statusText: HTMLElement;
  readonly detail: HTMLElement;
}

const UNAVAILABLE_DETAILS: Record<
  Extract<RuntimeRendererStatus, { state: 'unavailable' }>['reason'],
  string
> = {
  'not-connected': 'Runtime connection is not ready.',
  'client-disconnected': 'Desktop disconnected from the Runtime.',
  'credentials-unavailable': 'Runtime credentials are unavailable.',
  'authentication-rejected': 'Runtime authentication was rejected.',
  'artifact-unavailable': 'The packaged Runtime is unavailable.',
  'start-failed': 'Desktop could not start the Runtime.',
  'startup-timeout': 'Runtime startup timed out.',
  'connection-failed': 'Desktop could not reach the Runtime.',
  'transport-lost': 'The Runtime connection was lost.',
  'protocol-error': 'Desktop received an invalid Runtime response.',
  'health-timeout': 'The Runtime health query timed out.',
  'runtime-stopped': 'The Runtime is stopped.',
  'invalid-request': 'Runtime rejected an invalid request.',
  'unsupported-operation': 'Runtime does not support this operation.',
  'stale-instance': 'The Runtime instance changed.',
  'idempotency-conflict': 'The Runtime request conflicts with an earlier request.',
  'not-found': 'The requested Runtime task was not found.',
  'task-not-ready': 'The requested Runtime task cannot start now.',
  'worktree-unavailable': 'The Runtime could not allocate a task worktree.',
  'process-start-failed': 'The Runtime could not start the task process.',
  'runtime-stopping': 'The Runtime is stopping.',
  internal: 'The Runtime reported an internal error.',
};

export function createRuntimeHealthViewModel(
  status: RuntimeRendererStatus,
): RuntimeHealthViewModel {
  switch (status.state) {
    case 'connected':
      return {
        state: 'connected',
        visibleText: 'Runtime: Connected',
        detail: `v${status.runtimeVersion} · protocol ${status.protocolVersion}`,
        announcement: `Runtime connected. Version ${status.runtimeVersion}, protocol ${status.protocolVersion}.`,
      };
    case 'unavailable': {
      const detail = UNAVAILABLE_DETAILS[status.reason];
      return {
        state: 'unavailable',
        visibleText: 'Runtime: Unavailable',
        detail,
        announcement: `Runtime unavailable. ${detail}`,
      };
    }
    case 'incompatible':
      return {
        state: 'incompatible',
        visibleText: 'Runtime: Incompatible',
        detail: `v${status.runtimeVersion} · protocol ${status.runtimeRange.min}–${status.runtimeRange.max}`,
        announcement: `Runtime incompatible. Runtime version ${status.runtimeVersion} supports protocols ${status.runtimeRange.min} to ${status.runtimeRange.max}; Desktop supports protocols ${status.desktopRange.min} to ${status.desktopRange.max}.`,
      };
  }
}

export function mountRuntimeHealth(
  container: HTMLElement,
  runtime: RuntimeHealthApi,
  documentRef: Pick<Document, 'createElement'> = document,
): () => void {
  const elements = createRuntimeHealthElements(container, documentRef);
  let disposed = false;
  let receivedPush = false;
  const render = (status: RuntimeRendererStatus): void => {
    if (!disposed) renderRuntimeHealth(elements, status);
  };
  const unsubscribe = runtime.onStatus((status) => {
    receivedPush = true;
    render(status);
  });
  void loadInitialRuntimeStatus(runtime, () => receivedPush, render);
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    elements.root.remove();
  };
}

function createRuntimeHealthElements(
  container: HTMLElement,
  documentRef: Pick<Document, 'createElement'>,
): RuntimeHealthElements {
  const root = documentRef.createElement('div');
  root.className = 'runtime-health';
  root.dataset.state = 'checking';
  root.setAttribute('aria-busy', 'true');
  const statusText = documentRef.createElement('span');
  statusText.className = 'runtime-health-text';
  statusText.setAttribute('role', 'status');
  statusText.setAttribute('aria-live', 'polite');
  statusText.setAttribute('aria-atomic', 'true');
  statusText.setAttribute('aria-label', 'Checking Runtime status.');
  statusText.textContent = 'Runtime: Checking…';
  const detail = documentRef.createElement('span');
  detail.className = 'runtime-health-detail';
  detail.hidden = true;
  root.append(statusText, detail);
  container.append(root);
  return { root, statusText, detail };
}

function renderRuntimeHealth(elements: RuntimeHealthElements, status: RuntimeRendererStatus): void {
  const model = createRuntimeHealthViewModel(status);
  elements.root.dataset.state = model.state;
  elements.root.setAttribute('aria-busy', 'false');
  elements.statusText.textContent = model.visibleText;
  elements.statusText.setAttribute('aria-label', model.announcement);
  elements.detail.textContent = model.detail;
  elements.detail.hidden = model.detail.length === 0;
}

async function loadInitialRuntimeStatus(
  runtime: RuntimeHealthApi,
  receivedPush: () => boolean,
  render: (status: RuntimeRendererStatus) => void,
): Promise<void> {
  try {
    const status = await runtime.getStatus();
    if (!receivedPush()) render(status);
  } catch {
    if (!receivedPush()) {
      render({ state: 'unavailable', reason: 'connection-failed', retryable: true });
    }
  }
}

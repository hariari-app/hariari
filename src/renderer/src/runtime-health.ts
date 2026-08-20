import type { RuntimeRendererStatus } from '../../shared/ipc-types';

export interface RuntimeHealthViewModel {
  readonly state: RuntimeRendererStatus['state'];
  readonly visibleText: string;
  readonly detail: string;
  readonly announcement: string;
  readonly showRetry: boolean;
}

export interface RuntimeHealthApi {
  getStatus(): Promise<RuntimeRendererStatus>;
  retry(): Promise<RuntimeRendererStatus>;
  onStatus(callback: (status: RuntimeRendererStatus) => void): () => void;
}

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
        showRetry: false,
      };
    case 'unavailable':
      return {
        state: 'unavailable',
        visibleText: 'Runtime: Unavailable',
        detail: '',
        announcement: status.retryable
          ? 'Runtime unavailable. Retry is available.'
          : 'Runtime unavailable.',
        showRetry: status.retryable,
      };
    case 'incompatible':
      return {
        state: 'incompatible',
        visibleText: 'Runtime: Incompatible',
        detail: `v${status.runtimeVersion} · protocol ${status.runtimeRange.min}–${status.runtimeRange.max}`,
        announcement: `Runtime incompatible. Runtime version ${status.runtimeVersion} supports protocols ${status.runtimeRange.min} to ${status.runtimeRange.max}; Desktop supports protocols ${status.desktopRange.min} to ${status.desktopRange.max}.`,
        showRetry: false,
      };
  }
}

export function mountRuntimeHealth(
  container: HTMLElement,
  runtime: RuntimeHealthApi,
  documentRef: Pick<Document, 'createElement'> = document,
): () => void {
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

  const retry = documentRef.createElement('button');
  retry.className = 'runtime-health-retry';
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.setAttribute('aria-label', 'Retry Runtime connection');
  retry.hidden = true;

  root.append(statusText, detail, retry);
  container.append(root);

  let disposed = false;
  let receivedPush = false;
  let retrying = false;

  const render = (status: RuntimeRendererStatus): void => {
    if (disposed) return;
    const model = createRuntimeHealthViewModel(status);
    root.dataset.state = model.state;
    root.setAttribute('aria-busy', 'false');
    statusText.textContent = model.visibleText;
    statusText.setAttribute('aria-label', model.announcement);
    detail.textContent = model.detail;
    detail.hidden = model.detail.length === 0;
    retry.hidden = !model.showRetry;
    retry.disabled = retrying;
  };

  const unsubscribe = runtime.onStatus((status) => {
    receivedPush = true;
    render(status);
  });

  void runtime
    .getStatus()
    .then((status) => {
      if (!receivedPush) render(status);
    })
    .catch(() => {
      if (!receivedPush) {
        render({ state: 'unavailable', reason: 'connection-failed', retryable: true });
      }
    });

  retry.addEventListener('click', () => {
    if (disposed || retrying) return;
    retrying = true;
    retry.disabled = true;
    retry.textContent = 'Retrying…';
    void runtime
      .retry()
      .then(render)
      .catch(() => render({ state: 'unavailable', reason: 'connection-failed', retryable: true }))
      .finally(() => {
        retrying = false;
        retry.disabled = false;
        retry.textContent = 'Retry';
      });
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    root.remove();
  };
}

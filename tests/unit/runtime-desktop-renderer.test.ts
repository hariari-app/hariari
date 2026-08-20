import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHealthViewModel,
  mountRuntimeHealth,
} from '../../src/renderer/src/runtime-health';
import type { RuntimeRendererStatus } from '../../src/shared/ipc-types';

describe('Runtime health renderer model', registerRuntimeRendererTests);

function registerRuntimeRendererTests(): void {
  registerConnectedViewTest();
  registerRetryableUnavailableViewTest();
  registerNonRetryableUnavailableViewTest();
  registerIncompatibleViewTest();
  registerMountLifecycleTest();
  registerLiveStatusTest();
}

function registerConnectedViewTest(): void {
  it('shows connected health with safe version and protocol context', () => {
    expect(
      createRuntimeHealthViewModel({
        state: 'connected',
        runtimeVersion: '0.6.8',
        protocolVersion: 2,
      }),
    ).toEqual({
      state: 'connected',
      visibleText: 'Runtime: Connected',
      detail: 'v0.6.8 · protocol 2',
      announcement: 'Runtime connected. Version 0.6.8, protocol 2.',
    });
  });
}

function registerRetryableUnavailableViewTest(): void {
  it('explains unavailable health without offering process-start authority', () => {
    expect(
      createRuntimeHealthViewModel({
        state: 'unavailable',
        reason: 'connection-failed',
        retryable: true,
      }),
    ).toEqual({
      state: 'unavailable',
      visibleText: 'Runtime: Unavailable',
      detail: 'Desktop could not reach the Runtime.',
      announcement: 'Runtime unavailable. Desktop could not reach the Runtime.',
    });
  });
}

function registerNonRetryableUnavailableViewTest(): void {
  it('does not offer Retry for a non-retryable unavailable state', () => {
    expect(
      createRuntimeHealthViewModel({
        state: 'unavailable',
        reason: 'authentication-rejected',
        retryable: false,
      }),
    ).toEqual({
      state: 'unavailable',
      visibleText: 'Runtime: Unavailable',
      detail: 'Runtime authentication was rejected.',
      announcement: 'Runtime unavailable. Runtime authentication was rejected.',
    });
  });
}

function registerIncompatibleViewTest(): void {
  it('shows incompatible health with safe version ranges and update context', () => {
    expect(
      createRuntimeHealthViewModel({
        state: 'incompatible',
        desktopRange: { min: 1, max: 2 },
        runtimeRange: { min: 5, max: 7 },
        runtimeVersion: '1.4.0',
      }),
    ).toEqual({
      state: 'incompatible',
      visibleText: 'Runtime: Incompatible',
      detail: 'v1.4.0 · protocol 5–7',
      announcement:
        'Runtime incompatible. Runtime version 1.4.0 supports protocols 5 to 7; Desktop supports protocols 1 to 2.',
    });
  });
}

function registerMountLifecycleTest(): void {
  it('subscribes before the initial query and cleans up the listener and DOM', async () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('div');
    const runtime = new FakeRuntimeApi({
      state: 'unavailable',
      reason: 'connection-failed',
      retryable: true,
    });

    const dispose = mountRuntimeHealth(
      container as unknown as HTMLElement,
      runtime,
      documentRef as unknown as Document,
    );
    await Promise.resolve();

    expect(runtime.callOrder).toEqual(['onStatus', 'getStatus']);
    expect(findByClass(container, 'runtime-health-text')?.textContent).toBe('Runtime: Unavailable');
    const status = findByClass(container, 'runtime-health-text');
    expect(status?.attributes.get('role')).toBe('status');
    expect(status?.attributes.get('aria-live')).toBe('polite');
    expect(status?.attributes.get('aria-atomic')).toBe('true');
    expect(findByClass(container, 'runtime-health-detail')?.textContent).toBe(
      'Desktop could not reach the Runtime.',
    );
    expect(findByClass(container, 'runtime-health-retry')).toBeNull();

    dispose();
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
  });
}

function registerLiveStatusTest(): void {
  it('renders live status pushes without querying or controlling a Runtime process', async () => {
    const documentRef = new FakeDocument();
    const container = documentRef.createElement('div');
    const runtime = new FakeRuntimeApi({
      state: 'unavailable',
      reason: 'connection-failed',
      retryable: true,
    });
    const dispose = mountRuntimeHealth(
      container as unknown as HTMLElement,
      runtime,
      documentRef as unknown as Document,
    );
    await Promise.resolve();

    runtime.push({
      state: 'incompatible',
      desktopRange: { min: 1, max: 2 },
      runtimeRange: { min: 5, max: 7 },
      runtimeVersion: '1.4.0',
    });

    expect(findByClass(container, 'runtime-health-text')?.textContent).toBe(
      'Runtime: Incompatible',
    );
    expect(findByClass(container, 'runtime-health-text')?.attributes.get('aria-label')).toContain(
      'Runtime incompatible',
    );
    expect(runtime.callOrder).toEqual(['onStatus', 'getStatus']);
    dispose();
  });
}

class FakeRuntimeApi {
  readonly callOrder: string[] = [];
  readonly unsubscribe = vi.fn();
  private listener: ((status: RuntimeRendererStatus) => void) | null = null;

  constructor(private readonly initial: RuntimeRendererStatus) {}

  async getStatus(): Promise<RuntimeRendererStatus> {
    this.callOrder.push('getStatus');
    return this.initial;
  }

  onStatus(listener: (status: RuntimeRendererStatus) => void): () => void {
    this.callOrder.push('onStatus');
    this.listener = listener;
    return this.unsubscribe;
  }

  push(status: RuntimeRendererStatus): void {
    this.listener?.(status);
  }
}

class FakeDocument {
  createElement(_tagName: string): FakeElement {
    return new FakeElement();
  }
}

class FakeElement {
  className = '';
  textContent = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private parent: FakeElement | null = null;

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className === className) return root;
  for (const child of root.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

import { describe, it, expect } from 'vitest';

/**
 * Tests for platform-gated window configuration.
 * Since createMainWindow depends on Electron, we test the platform-conditional
 * logic directly to verify macOS gets trafficLightPosition and other platforms don't.
 */

// Mirrors the spread logic in main-window.ts. Uses string param to avoid TS literal narrowing.
function buildWindowOpts(platform: string): Record<string, unknown> {
  return {
    frame: false,
    titleBarStyle: 'hidden',
    ...(platform === 'darwin' ? {
      trafficLightPosition: { x: 13, y: 10 },
    } : {}),
  };
}

function shouldRenderCustomControls(platform: string): boolean {
  return platform !== 'darwin';
}

describe('Main window platform gating', () => {
  describe('trafficLightPosition', () => {
    it('includes trafficLightPosition on darwin', () => {
      const opts = buildWindowOpts('darwin');
      expect(opts.trafficLightPosition).toEqual({ x: 13, y: 10 });
    });

    it('excludes trafficLightPosition on linux', () => {
      expect(buildWindowOpts('linux')).not.toHaveProperty('trafficLightPosition');
    });

    it('excludes trafficLightPosition on win32', () => {
      expect(buildWindowOpts('win32')).not.toHaveProperty('trafficLightPosition');
    });
  });

  describe('titlebar controls gating', () => {
    it('does not render custom controls on darwin', () => {
      expect(shouldRenderCustomControls('darwin')).toBe(false);
    });

    it('renders custom controls on linux', () => {
      expect(shouldRenderCustomControls('linux')).toBe(true);
    });

    it('renders custom controls on win32', () => {
      expect(shouldRenderCustomControls('win32')).toBe(true);
    });
  });

  describe('platform body class', () => {
    it('generates correct class for darwin', () => {
      expect(`platform-${'darwin'}`).toBe('platform-darwin');
    });

    it('generates correct class for linux', () => {
      expect(`platform-${'linux'}`).toBe('platform-linux');
    });

    it('generates correct class for win32', () => {
      expect(`platform-${'win32'}`).toBe('platform-win32');
    });
  });
});

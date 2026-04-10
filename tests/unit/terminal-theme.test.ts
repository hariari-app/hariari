import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage before importing the module
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

// Set up globals that the module expects
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// The module also references `document` in applyTheme, but we only test
// getTheme, getThemeNames, loadSavedTheme which don't need document.
// We'll add a minimal document mock just in case.
if (typeof globalThis.document === 'undefined') {
  Object.defineProperty(globalThis, 'document', {
    value: {
      documentElement: {
        style: {
          setProperty: vi.fn(),
        },
      },
    },
    writable: true,
  });
}

import { getTheme, getThemeNames, loadSavedTheme, themes } from '../../src/renderer/src/terminal/terminal-theme';
import type { AppTheme } from '../../src/renderer/src/terminal/terminal-theme';

describe('Terminal Theme', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('getTheme', () => {
    it('returns tokyoNight theme for "tokyoNight"', () => {
      const theme = getTheme('tokyoNight');
      expect(theme.terminal.background).toBe('#1a1b26');
      expect(theme.chrome['--bg']).toBe('#1a1b26');
    });

    it('returns tokyoNightLight theme for "tokyoNightLight"', () => {
      const theme = getTheme('tokyoNightLight');
      expect(theme.terminal.background).toBe('#d5d6db');
      expect(theme.chrome['--bg']).toBe('#d5d6db');
    });

    it('returns solarizedDark theme for "solarizedDark"', () => {
      const theme = getTheme('solarizedDark');
      expect(theme.terminal.background).toBe('#002b36');
    });

    it('returns default (brutalist) for unknown name', () => {
      const theme = getTheme('nonExistentTheme');
      expect(theme.terminal.background).toBe('#0f0f23');
    });

    it('returns default for empty string', () => {
      const theme = getTheme('');
      expect(theme.terminal.background).toBe('#0f0f23');
    });

    it('enriches chrome with derived tokens', () => {
      const theme = getTheme('tokyoNight');
      expect(theme.chrome['--surface-raised']).toBeDefined();
      expect(theme.chrome['--accent-dim']).toBeDefined();
      expect(theme.chrome['--accent-hover']).toBeDefined();
      expect(theme.chrome['--border-subtle']).toBeDefined();
    });
  });

  describe('getThemeNames', () => {
    it('returns all theme names', () => {
      const names = getThemeNames();
      expect(names).toContain('tokyoNight');
      expect(names).toContain('tokyoNightLight');
      expect(names).toContain('solarizedDark');
    });

    it('returns all registered themes', () => {
      const names = getThemeNames();
      expect(names).toHaveLength(16);
      expect(names).toContain('tokyoNight');
      expect(names).toContain('dracula');
      expect(names).toContain('nord');
      expect(names).toContain('catppuccinMocha');
      expect(names).toContain('brutalist');
      expect(names).toContain('brutalistLight');
    });

    it('returns an array of strings', () => {
      const names = getThemeNames();
      for (const name of names) {
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('loadSavedTheme', () => {
    it('returns "brutalist" when localStorage is empty', () => {
      const result = loadSavedTheme();
      expect(result).toBe('brutalist');
    });

    it('returns saved theme name when valid', () => {
      localStorageMock.setItem('hariari-theme', 'solarizedDark');
      const result = loadSavedTheme();
      expect(result).toBe('solarizedDark');
    });

    it('returns "brutalist" when saved name is invalid', () => {
      localStorageMock.setItem('hariari-theme', 'nonExistentTheme');
      const result = loadSavedTheme();
      expect(result).toBe('brutalist');
    });

    it('returns "brutalist" when localStorage throws', () => {
      localStorageMock.getItem.mockImplementationOnce(() => {
        throw new Error('localStorage disabled');
      });
      const result = loadSavedTheme();
      expect(result).toBe('brutalist');
    });
  });

  describe('theme structure', () => {
    it('all themes have terminal and chrome properties', () => {
      const names = getThemeNames();
      for (const name of names) {
        const theme = getTheme(name);
        expect(theme.terminal).toBeDefined();
        expect(theme.chrome).toBeDefined();
        expect(typeof theme.terminal).toBe('object');
        expect(typeof theme.chrome).toBe('object');
      }
    });

    it('all themes have required terminal colors', () => {
      const requiredColors = [
        'background', 'foreground', 'cursor', 'black', 'red', 'green',
        'yellow', 'blue', 'magenta', 'cyan', 'white',
      ];
      const names = getThemeNames();
      for (const name of names) {
        const theme = getTheme(name);
        for (const color of requiredColors) {
          expect(theme.terminal).toHaveProperty(color);
        }
      }
    });

    it('all themes have required chrome CSS variables', () => {
      const requiredVars = ['--bg', '--fg', '--accent', '--border', '--error', '--success'];
      const names = getThemeNames();
      for (const name of names) {
        const theme = getTheme(name);
        for (const cssVar of requiredVars) {
          expect(theme.chrome).toHaveProperty(cssVar);
        }
      }
    });

    it('all color values are valid hex or rgba strings', () => {
      const colorRegex = /^(#[0-9a-f]{6}|rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\))$/i;
      const names = getThemeNames();
      // Non-color tokens (box-shadow composites) added in FINDING-B3-001
      // live in the same chrome object but aren't colors, so they must
      // be excluded from the color-shape assertion.
      const nonColorKeys = new Set([
        '--shadow-sm',
        '--shadow-md',
        '--shadow-lg',
        '--shadow-overlay',
        '--shadow-modal',
      ]);
      for (const name of names) {
        const theme = getTheme(name);
        for (const [key, value] of Object.entries(theme.chrome)) {
          if (nonColorKeys.has(key)) continue;
          expect(value).toMatch(colorRegex);
        }
      }
    });
  });
});

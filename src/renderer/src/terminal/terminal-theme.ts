import type { ITheme } from '@xterm/xterm';

export interface AppTheme {
  readonly terminal: ITheme;
  readonly chrome: Readonly<Record<string, string>>;
}

const THEME_STORAGE_KEY = 'vibeide-theme';

const tokyoNight: AppTheme = {
  terminal: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#33467c',
    selectionForeground: '#c0caf5',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  chrome: {
    '--bg': '#1a1b26',
    '--bg-deep': '#16161e',
    '--fg': '#c0caf5',
    '--fg-dim': '#565f89',
    '--fg-faint': '#414868',
    '--border': '#2a2b3d',
    '--accent': '#7aa2f7',
    '--surface': '#1a1b26',
    '--surface-hover': '#2a2b3d',
    '--error': '#f7768e',
    '--success': '#9ece6a',
    '--warning': '#e0af68',
    '--scrollbar-track': '#1a1b26',
    '--scrollbar-thumb': '#414868',
    '--scrollbar-thumb-hover': '#565f89',
  },
};

const tokyoNightLight: AppTheme = {
  terminal: {
    background: '#d5d6db',
    foreground: '#343b58',
    cursor: '#343b58',
    cursorAccent: '#d5d6db',
    selectionBackground: '#99a7df',
    selectionForeground: '#343b58',
    black: '#0f0f14',
    red: '#8c4351',
    green: '#485e30',
    yellow: '#8f5e15',
    blue: '#34548a',
    magenta: '#5a4a78',
    cyan: '#0f4b6e',
    white: '#343b58',
    brightBlack: '#9699a3',
    brightRed: '#8c4351',
    brightGreen: '#485e30',
    brightYellow: '#8f5e15',
    brightBlue: '#34548a',
    brightMagenta: '#5a4a78',
    brightCyan: '#0f4b6e',
    brightWhite: '#343b58',
  },
  chrome: {
    '--bg': '#d5d6db',
    '--bg-deep': '#cbccd1',
    '--fg': '#343b58',
    '--fg-dim': '#6172b0',
    '--fg-faint': '#9699a3',
    '--border': '#b4b5b9',
    '--accent': '#34548a',
    '--surface': '#d5d6db',
    '--surface-hover': '#cbccd1',
    '--error': '#8c4351',
    '--success': '#485e30',
    '--warning': '#8f5e15',
    '--scrollbar-track': '#d5d6db',
    '--scrollbar-thumb': '#9699a3',
    '--scrollbar-thumb-hover': '#6172b0',
  },
};

const solarizedDark: AppTheme = {
  terminal: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    selectionForeground: '#93a1a1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#859900',
    brightYellow: '#b58900',
    brightBlue: '#268bd2',
    brightMagenta: '#6c71c4',
    brightCyan: '#2aa198',
    brightWhite: '#fdf6e3',
  },
  chrome: {
    '--bg': '#002b36',
    '--bg-deep': '#001e26',
    '--fg': '#839496',
    '--fg-dim': '#586e75',
    '--fg-faint': '#073642',
    '--border': '#073642',
    '--accent': '#268bd2',
    '--surface': '#002b36',
    '--surface-hover': '#073642',
    '--error': '#dc322f',
    '--success': '#859900',
    '--warning': '#b58900',
    '--scrollbar-track': '#002b36',
    '--scrollbar-thumb': '#073642',
    '--scrollbar-thumb-hover': '#586e75',
  },
};

export const themes: Readonly<Record<string, AppTheme>> = {
  tokyoNight,
  tokyoNightLight,
  solarizedDark,
};

export function getTheme(name: string): AppTheme {
  return themes[name] ?? tokyoNight;
}

export function getThemeNames(): readonly string[] {
  return Object.keys(themes);
}

export function applyTheme(name: string): void {
  const theme = getTheme(name);
  const root = document.documentElement;
  for (const [property, value] of Object.entries(theme.chrome)) {
    root.style.setProperty(property, value);
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch {
    // localStorage may be unavailable
  }
}

export function loadSavedTheme(): string {
  try {
    const name = localStorage.getItem(THEME_STORAGE_KEY) ?? 'tokyoNight';
    return name in themes ? name : 'tokyoNight';
  } catch {
    return 'tokyoNight';
  }
}

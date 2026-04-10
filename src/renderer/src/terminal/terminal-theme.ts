import type { ITheme } from '@xterm/xterm';

export interface AppTheme {
  readonly terminal: ITheme;
  readonly chrome: Readonly<Record<string, string>>;
}

const THEME_STORAGE_KEY = 'hariari-theme';

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

const dracula: AppTheme = {
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    selectionForeground: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  chrome: {
    '--bg': '#282a36',
    '--bg-deep': '#21222c',
    '--fg': '#f8f8f2',
    '--fg-dim': '#6272a4',
    '--fg-faint': '#44475a',
    '--border': '#44475a',
    '--accent': '#bd93f9',
    '--surface': '#282a36',
    '--surface-hover': '#44475a',
    '--error': '#ff5555',
    '--success': '#50fa7b',
    '--warning': '#f1fa8c',
    '--scrollbar-track': '#282a36',
    '--scrollbar-thumb': '#44475a',
    '--scrollbar-thumb-hover': '#6272a4',
  },
};

const nord: AppTheme = {
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    selectionForeground: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  chrome: {
    '--bg': '#2e3440',
    '--bg-deep': '#272c36',
    '--fg': '#d8dee9',
    '--fg-dim': '#7b88a1',
    '--fg-faint': '#4c566a',
    '--border': '#3b4252',
    '--accent': '#81a1c1',
    '--surface': '#2e3440',
    '--surface-hover': '#3b4252',
    '--error': '#bf616a',
    '--success': '#a3be8c',
    '--warning': '#ebcb8b',
    '--scrollbar-track': '#2e3440',
    '--scrollbar-thumb': '#3b4252',
    '--scrollbar-thumb-hover': '#4c566a',
  },
};

const gruvboxDark: AppTheme = {
  terminal: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    selectionForeground: '#ebdbb2',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  chrome: {
    '--bg': '#282828',
    '--bg-deep': '#1d2021',
    '--fg': '#ebdbb2',
    '--fg-dim': '#928374',
    '--fg-faint': '#504945',
    '--border': '#3c3836',
    '--accent': '#83a598',
    '--surface': '#282828',
    '--surface-hover': '#3c3836',
    '--error': '#fb4934',
    '--success': '#b8bb26',
    '--warning': '#fabd2f',
    '--scrollbar-track': '#282828',
    '--scrollbar-thumb': '#3c3836',
    '--scrollbar-thumb-hover': '#504945',
  },
};

const oneDark: AppTheme = {
  terminal: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    selectionForeground: '#abb2bf',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  chrome: {
    '--bg': '#282c34',
    '--bg-deep': '#21252b',
    '--fg': '#abb2bf',
    '--fg-dim': '#5c6370',
    '--fg-faint': '#3e4451',
    '--border': '#3e4451',
    '--accent': '#61afef',
    '--surface': '#282c34',
    '--surface-hover': '#3e4451',
    '--error': '#e06c75',
    '--success': '#98c379',
    '--warning': '#e5c07b',
    '--scrollbar-track': '#282c34',
    '--scrollbar-thumb': '#3e4451',
    '--scrollbar-thumb-hover': '#5c6370',
  },
};

const catppuccinMocha: AppTheme = {
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  chrome: {
    '--bg': '#1e1e2e',
    '--bg-deep': '#181825',
    '--fg': '#cdd6f4',
    '--fg-dim': '#6c7086',
    '--fg-faint': '#45475a',
    '--border': '#313244',
    '--accent': '#89b4fa',
    '--surface': '#1e1e2e',
    '--surface-hover': '#313244',
    '--error': '#f38ba8',
    '--success': '#a6e3a1',
    '--warning': '#f9e2af',
    '--scrollbar-track': '#1e1e2e',
    '--scrollbar-thumb': '#313244',
    '--scrollbar-thumb-hover': '#45475a',
  },
};

const monokai: AppTheme = {
  terminal: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    selectionForeground: '#f8f8f2',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  chrome: {
    '--bg': '#272822',
    '--bg-deep': '#1e1f1c',
    '--fg': '#f8f8f2',
    '--fg-dim': '#75715e',
    '--fg-faint': '#49483e',
    '--border': '#3e3d32',
    '--accent': '#66d9ef',
    '--surface': '#272822',
    '--surface-hover': '#3e3d32',
    '--error': '#f92672',
    '--success': '#a6e22e',
    '--warning': '#f4bf75',
    '--scrollbar-track': '#272822',
    '--scrollbar-thumb': '#49483e',
    '--scrollbar-thumb-hover': '#75715e',
  },
};

const solarizedLight: AppTheme = {
  terminal: {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#657b83',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    selectionForeground: '#657b83',
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
    '--bg': '#fdf6e3',
    '--bg-deep': '#eee8d5',
    '--fg': '#657b83',
    '--fg-dim': '#839496',
    '--fg-faint': '#93a1a1',
    '--border': '#d6ccb1',
    '--accent': '#268bd2',
    '--surface': '#fdf6e3',
    '--surface-hover': '#eee8d5',
    '--error': '#dc322f',
    '--success': '#859900',
    '--warning': '#b58900',
    '--scrollbar-track': '#fdf6e3',
    '--scrollbar-thumb': '#d6ccb1',
    '--scrollbar-thumb-hover': '#93a1a1',
  },
};

const githubLight: AppTheme = {
  terminal: {
    background: '#ffffff',
    foreground: '#24292f',
    cursor: '#044289',
    cursorAccent: '#ffffff',
    selectionBackground: '#ddf4ff',
    selectionForeground: '#24292f',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0550ae',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#0969da',
    brightMagenta: '#8250df',
    brightCyan: '#1b7c83',
    brightWhite: '#8c959f',
  },
  chrome: {
    '--bg': '#ffffff',
    '--bg-deep': '#f6f8fa',
    '--fg': '#24292f',
    '--fg-dim': '#57606a',
    '--fg-faint': '#8c959f',
    '--border': '#d0d7de',
    '--accent': '#0969da',
    '--surface': '#ffffff',
    '--surface-hover': '#f6f8fa',
    '--error': '#cf222e',
    '--success': '#116329',
    '--warning': '#9a6700',
    '--scrollbar-track': '#ffffff',
    '--scrollbar-thumb': '#d0d7de',
    '--scrollbar-thumb-hover': '#8c959f',
  },
};

const catppuccinLatte: AppTheme = {
  terminal: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    selectionForeground: '#4c4f69',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#6c6f85',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#bcc0cc',
  },
  chrome: {
    '--bg': '#eff1f5',
    '--bg-deep': '#e6e9ef',
    '--fg': '#4c4f69',
    '--fg-dim': '#6c6f85',
    '--fg-faint': '#9ca0b0',
    '--border': '#ccd0da',
    '--accent': '#1e66f5',
    '--surface': '#eff1f5',
    '--surface-hover': '#e6e9ef',
    '--error': '#d20f39',
    '--success': '#40a02b',
    '--warning': '#df8e1d',
    '--scrollbar-track': '#eff1f5',
    '--scrollbar-thumb': '#ccd0da',
    '--scrollbar-thumb-hover': '#9ca0b0',
  },
};

// ── Caffeine (tweakcn) ─────────────────────────────────────────────────────
// Dark: espresso charcoal bg with warm golden/amber accent
// oklch(0.1776 0 0) → #2c2c2c  |  oklch(0.9247 0.0524 66.17) → #e8d5a3
const caffeineDark: AppTheme = {
  terminal: {
    background: '#2c2c2c',
    foreground: '#f1f1f1',
    cursor: '#e8d5a3',
    cursorAccent: '#2c2c2c',
    selectionBackground: '#504536',
    selectionForeground: '#f1f1f1',
    black: '#1a1a1a',
    red: '#c0604a',
    green: '#6a9e5c',
    yellow: '#c8a86a',
    blue: '#7a9abf',
    magenta: '#b08090',
    cyan: '#6a9ea8',
    white: '#c2c2c2',
    brightBlack: '#525252',
    brightRed: '#d4705e',
    brightGreen: '#7ab568',
    brightYellow: '#e8c880',
    brightBlue: '#8aacd2',
    brightMagenta: '#c498ac',
    brightCyan: '#7ab0bc',
    brightWhite: '#f1f1f1',
  },
  chrome: {
    '--bg': '#2c2c2c',
    '--bg-deep': '#1a1a1a',
    '--fg': '#f1f1f1',
    '--fg-dim': '#c2c2c2',
    '--fg-faint': '#737373',
    '--border': '#3a3c35',
    '--accent': '#e8d5a3',
    '--surface': '#2c2c2c',
    '--surface-hover': '#404040',
    '--error': '#c0604a',
    '--success': '#6a9e5c',
    '--warning': '#c8a86a',
    '--scrollbar-track': '#2c2c2c',
    '--scrollbar-thumb': '#404040',
    '--scrollbar-thumb-hover': '#525252',
  },
};

// Light: parchment-white bg with warm coffee-brown accent
// oklch(0.9821 0 0) → #f9f9f9  |  oklch(0.4341 0.0392 41.99) → #6b4c31
const caffeineLight: AppTheme = {
  terminal: {
    background: '#f9f9f9',
    foreground: '#3d3d3d',
    cursor: '#6b4c31',
    cursorAccent: '#f9f9f9',
    selectionBackground: '#eedf9e',
    selectionForeground: '#3d3d3d',
    black: '#3d3d3d',
    red: '#a04030',
    green: '#3d6e30',
    yellow: '#8a6620',
    blue: '#355a8a',
    magenta: '#7a3060',
    cyan: '#206070',
    white: '#7c7c7c',
    brightBlack: '#7c7c7c',
    brightRed: '#c04a38',
    brightGreen: '#507c42',
    brightYellow: '#9e7828',
    brightBlue: '#4068a0',
    brightMagenta: '#8e4070',
    brightCyan: '#2e7080',
    brightWhite: '#3d3d3d',
  },
  chrome: {
    '--bg': '#f9f9f9',
    '--bg-deep': '#f0ede8',
    '--fg': '#3d3d3d',
    '--fg-dim': '#7c7c7c',
    '--fg-faint': '#aaaaaa',
    '--border': '#e0e0e0',
    '--accent': '#6b4c31',
    '--surface': '#f9f9f9',
    '--surface-hover': '#f2f2f2',
    '--error': '#a04030',
    '--success': '#3d6e30',
    '--warning': '#8a6620',
    '--scrollbar-track': '#f9f9f9',
    '--scrollbar-thumb': '#e0e0e0',
    '--scrollbar-thumb-hover': '#aaaaaa',
  },
};

const brutalistLight: AppTheme = {
  terminal: {
    background: '#e2e2e2',
    foreground: '#1a1a1a',
    cursor: '#1a1a1a',
    cursorAccent: '#e2e2e2',
    selectionBackground: '#3178c640',
    selectionForeground: '#1a1a1a',
    black: '#1a1a1a',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0e7490',
    white: '#e2e2e2',
    brightBlack: '#4b4b4b',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#f5f5f5',
  },
  chrome: {
    '--bg': '#e2e2e2',
    '--bg-deep': '#d8d8d8',
    '--fg': '#1a1a1a',
    '--fg-dim': '#4b4b4b',
    '--fg-faint': '#999999',
    '--border': '#333333',
    '--accent': '#1d4ed8',
    '--surface': '#f0f0f0',
    '--surface-hover': '#d1d1d1',
    '--error': '#b91c1c',
    '--success': '#15803d',
    '--warning': '#a16207',
    '--scrollbar-track': '#e2e2e2',
    '--scrollbar-thumb': '#999999',
    '--scrollbar-thumb-hover': '#4b4b4b',
  },
};

const brutalist: AppTheme = {
  terminal: {
    background: '#0f0f23',
    foreground: '#cccccc',
    cursor: '#f7df1e',
    cursorAccent: '#0f0f23',
    selectionBackground: '#3178c640',
    selectionForeground: '#ffffff',
    black: '#0b0b1a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f7df1e',
    blue: '#3178c6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#cccccc',
    brightBlack: '#4a4a5a',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fef08a',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#f5f5f5',
  },
  chrome: {
    '--bg': '#0f0f23',
    '--bg-deep': '#0b0b1a',
    '--fg': '#cccccc',
    '--fg-dim': '#a0a0a0',
    '--fg-faint': '#4a4a5a',
    '--border': '#2d2d44',
    '--accent': '#f7df1e',
    '--surface': '#161625',
    '--surface-hover': '#2d2d44',
    '--error': '#ef4444',
    '--success': '#22c55e',
    '--warning': '#f7df1e',
    '--scrollbar-track': '#0f0f23',
    '--scrollbar-thumb': '#2d2d44',
    '--scrollbar-thumb-hover': '#4a4a5a',
  },
};

export const themes: Readonly<Record<string, AppTheme>> = {
  tokyoNight,
  tokyoNightLight,
  solarizedDark,
  solarizedLight,
  dracula,
  nord,
  gruvboxDark,
  oneDark,
  catppuccinMocha,
  catppuccinLatte,
  monokai,
  githubLight,
  brutalist,
  brutalistLight,
  caffeineDark,
  caffeineLight,
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

function lighten(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.min(255, rgb.r + amount);
  const g = Math.min(255, rgb.g + amount);
  const b = Math.min(255, rgb.b + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function darken(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.max(0, Math.min(255, rgb.r - amount));
  const g = Math.max(0, Math.min(255, rgb.g - amount));
  const b = Math.max(0, Math.min(255, rgb.b - amount));
  return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
}

function isLightTheme(chrome: Readonly<Record<string, string>>): boolean {
  const bg = hexToRgb(chrome['--bg'] ?? '#1a1b26');
  if (!bg) return false;
  return (bg.r + bg.g + bg.b) / 3 > 128;
}

function enrichChrome(chrome: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const light = isLightTheme(chrome);
  const adjust = light ? darken : lighten;
  return {
    ...chrome,
    '--surface-raised': chrome['--surface-raised'] ?? adjust(chrome['--bg'] ?? '#1a1b26', 6),
    '--accent-dim': chrome['--accent-dim'] ?? withAlpha(chrome['--accent'] ?? '#7aa2f7', 0.15),
    '--accent-hover': chrome['--accent-hover'] ?? adjust(chrome['--accent'] ?? '#7aa2f7', 15),
    '--border-subtle': chrome['--border-subtle'] ?? withAlpha(chrome['--border'] ?? '#2a2b3d', 0.5),
  };
}

export function getTheme(name: string): AppTheme {
  const theme = themes[name] ?? brutalist;
  return {
    terminal: theme.terminal,
    chrome: enrichChrome(theme.chrome),
  };
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
    const name = localStorage.getItem(THEME_STORAGE_KEY) ?? 'brutalist';
    return name in themes ? name : 'brutalist';
  } catch {
    return 'brutalist';
  }
}

/**
 * Returns true if the currently saved theme is a light theme.
 * Used by non-CSS consumers (e.g. CodeMirror editor extensions) that need
 * to make a discrete dark/light decision before rendering.
 */
export function isCurrentThemeLight(): boolean {
  return isLightTheme(getTheme(loadSavedTheme()).chrome);
}

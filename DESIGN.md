# Hariari Design System

> Source of truth for visual design decisions. Update this document when changing tokens, components, or brand elements.

## Brand

**Name:** Hariari
**Mascot:** Dragonfly (gradient blue-to-green wings, monochrome variant for chrome)
**Default theme:** Tokyo Night
**Tagline:** AI agent terminal orchestrator

## Color Tokens

All colors are CSS custom properties defined in `global.css` and overridden per-theme in `terminal-theme.ts`.

| Token | Default (Tokyo Night) | Semantic meaning |
|-------|----------------------|------------------|
| `--bg` | `#1a1b26` | Primary background |
| `--bg-deep` | `#16161e` | Deepest background (titlebar, sidebar, status bar) |
| `--fg` | `#c0caf5` | Primary text |
| `--fg-dim` | `#565f89` | Secondary text, labels |
| `--fg-faint` | `#414868` | Tertiary text, disabled states |
| `--border` | `#2a2b3d` | Default border |
| `--border-subtle` | `rgba(42,43,61,0.5)` | Lighter border for inner separators |
| `--accent` | `#7aa2f7` | Primary accent (links, active states, branding) |
| `--accent-dim` | `rgba(122,162,247,0.15)` | Accent background tint |
| `--accent-hover` | `#89b0fa` | Accent hover state |
| `--surface` | `#1a1b26` | Card/panel background |
| `--surface-raised` | Computed | Slightly lighter than bg |
| `--surface-hover` | `#2a2b3d` | Hover state for interactive surfaces |
| `--error` | `#f7768e` | Error, destructive actions |
| `--success` | `#9ece6a` | Success, complete, positive confirmation |
| `--warning` | `#e0af68` | Warning, needs attention, in-progress |

### Status Color Semantics

| Status | Color | Use |
|--------|-------|-----|
| Running | `--success` (green) | Agent actively processing |
| Needs Input | `--warning` (amber) | Agent waiting for user, pulsing animation |
| Error | `--error` (red) | Agent failed |
| Complete | `--success` (green) | Agent finished successfully |
| Idle / Stopped | `--fg-faint` (gray) | Inactive |
| Starting | `--warning` (amber) | Agent booting |

## Typography

| Context | Font | Weight | Size |
|---------|------|--------|------|
| UI chrome (buttons, labels, sidebar) | Space Grotesk | 400 (Regular) | `--font-sm` (11px) to `--font-lg` (16px) |
| Brand text (logo, headings) | Space Grotesk | 700 (Bold) | 18px+ |
| Terminal / code | JetBrains Mono | 400 | 14px default, user-configurable |
| Keyboard shortcuts | JetBrains Mono | 400 | `--font-xs` (10px) |

### Typography Scale

| Token | Value | Use |
|-------|-------|-----|
| `--font-2xs` | 9px | Tiny overlay captions, badge counts |
| `--font-xs` | 10px | Labels, hints, keyboard shortcut chips |
| `--font-sm` | 11px | Tab labels, compact buttons, secondary body |
| `--font-base` | 13px | Default body text |
| `--font-md` | 14px | Emphasized body, primary content |
| `--font-lg` | 16px | Section headings, modal titles |
| `--font-xl` | 18px | Page headings, launch dialog icons |

One-off display sizes (20/24/48px in onboarding and empty states) are intentional outliers and not tokenized — tokenizing single-use values is noise.

## Spacing Scale

Based on a 4px base unit.

| Token | Value |
|-------|-------|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |

## Components

### Buttons

Three variants defined in `global.css`:

| Variant | Class | Use |
|---------|-------|-----|
| Primary | `.btn-primary` | Main actions (accent bg, white text) |
| Secondary | `.btn-secondary` | Alternative actions (transparent bg, border) |
| Danger | `.btn-danger` | Destructive actions (error bg, white text) |

All buttons: `border-radius: 6px`, `font-size: --font-sm`, `:active { transform: scale(0.97) }`.

### Toast Notifications

- Slide in from right, auto-dismiss
- Background tint using `color-mix(in srgb, <color> 6%, transparent)` for event type
- Colored dot as primary type indicator
- Max 5 visible, FIFO dismissal
- Hover pauses auto-dismiss

### Status Indicators

Dot (8px circle) + symbol (monospace). Seven states: running, needs-input, error, complete, idle, starting, stopped.

### Agent Icons

14 agent types with brand-specific SVG icons and colors. Defined in `agent-icons.ts`. All icons use `currentColor` and fit a 16x16 viewBox.

## Layout

### Project Tab Bar

- **Height:** 42px (doubles as the draggable window title bar)
- **Per-project identity:** each tab sets a `--tab-color` custom property from `avatarColor(project.name)` — the same deterministic HSL the sidebar rail uses — so project identity is consistent across all chrome
- **Background tint:** inactive tabs mix `--tab-color` at 5%, hover at 12%, active at 18%, via `color-mix(in srgb, ...)`. Gives every tab a unique scannable silhouette without fighting theme backgrounds
- **Active underline:** 2px solid `var(--tab-color)` (replaces the old uniform `--accent` border) — active state stacks three signals: stronger tint + colored underline + 600 font weight
- **Attention pulse:** when an agent needs input, the tab adds `.needs-input` and animates `background` between the project tint and `--warning` at 1.6s ease-in-out. Slower than the 1s `pulse-input` used on small dots because large surfaces strobing fast feels frantic. The small 8px `tab-notify-dot` is hidden during the pulse (the whole tab IS the signal). `prefers-reduced-motion` holds the tab statically at peak warning instead of animating

### Sidebar

- **Expanded:** 240px wide, resizable (140-500px)
- **Collapsed:** 48px icon rail with project letter avatars and agent type icons
- **Toggle:** Ctrl+B, animated 150ms ease-out transition
- Letter avatars: first letter of project name, HSL color derived from name hash

### Terminal Area

- Flexible split panes (horizontal/vertical)
- Each pane: status bar (30px) + terminal wrapper
- Split divider: 4px with expanded hit area
- Focus indicator: `inset 2px 0 0 var(--accent)` left border

### Hint Bar

24px tall, fixed at bottom. Keyboard shortcut reference.

## Themes

16 themes available in `terminal-theme.ts`:

**Dark:** Tokyo Night (default), Solarized Dark, Dracula, Nord, Gruvbox Dark, One Dark, Catppuccin Mocha, Monokai, Brutalist, Caffeine Dark
**Light:** Tokyo Night Light, Solarized Light, GitHub Light, Catppuccin Latte, Brutalist Light, Caffeine Light

### Editor (CodeMirror) theming

The CodeMirror editor used in the editor pop-out window and the inline file viewer is NOT a pure CSS-variable consumer — it composes two layers:

1. **Chrome layer (`cmTheme` in `lang-extensions.ts`):** Uses `var(--bg)`, `var(--fg)`, `var(--bg-deep)`, `var(--surface-raised)`, `var(--surface-hover)`, `var(--accent)`, `var(--accent-dim)` for the editor background, gutter, active line, selection, and caret. Always applied. Follows the app theme automatically.
2. **Syntax layer:** On dark app themes, `@codemirror/theme-one-dark` (`oneDark`) is applied for syntax token colors. On light app themes, `oneDark` is skipped entirely and CodeMirror's default syntax rendering is used. The choice is driven by `isCurrentThemeLight()` in `terminal-theme.ts` evaluated at editor-create time.

**Known gap:** The syntax layer is resolved at editor-create time, so switching the app theme while an editor is open will update the chrome (CSS variables reflow) but NOT the syntax highlighting until the file is reopened. Full live-switch would require IPC wiring across BrowserWindow boundaries.

Each theme provides terminal colors (16 ANSI + selection) and chrome CSS variables. Derived tokens (`--surface-raised`, `--accent-dim`, `--accent-hover`, `--border-subtle`) are computed automatically by `enrichChrome()`.

## Accessibility

- Focus-visible outlines: `2px solid var(--accent)`, offset 2px
- ARIA landmarks: `role="navigation"` (sidebar), `role="main"` (workspace), `role="status"` (hint bar)
- Central `aria-live="polite"` region for agent status announcements
- `role="alert"` on toast notifications
- `aria-label` on all icon buttons
- `prefers-reduced-motion`: Not yet implemented (TODO)

## Animation Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--transition-fast` | `0.1s ease` | Hover states, toggles |
| `--transition-normal` | `0.15s ease` | Color changes, borders |
| `--transition-smooth` | `0.25s cubic-bezier(0.16, 1, 0.3, 1)` | Panel entrances |

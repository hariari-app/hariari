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

| Token | Value |
|-------|-------|
| `--font-xs` | 10px |
| `--font-sm` | 11px |
| `--font-base` | 13px |
| `--font-md` | 14px |
| `--font-lg` | 16px |

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

12 themes available in `terminal-theme.ts`:

**Dark:** Tokyo Night (default), Solarized Dark, Dracula, Nord, Gruvbox Dark, One Dark, Catppuccin Mocha, Monokai
**Light:** Tokyo Night Light, Solarized Light, GitHub Light, Catppuccin Latte

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

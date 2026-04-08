# Hariari Design TODOs

From design review on 2026-03-30 (branch: hariari/claude-99198f97).

## Quick Fixes (< 15 min each with CC)

- [x] **Fix --fg-dim CSS default mismatch** — Change `global.css:33` from `#737aa2` to `#565f89` to match Tokyo Night theme in `terminal-theme.ts:39`. Eliminates flash of wrong dim text color before theme loads.

- [x] **Fix status complete color** — Change `.status-complete` and `.status-symbol-complete` in `terminal.css:437-438` from `var(--accent)` to `var(--success)`. Also update `.agent-status-bar.status-bar-complete` background tint. Green = done is universal.

- [x] **Replace toast border-left with background tint** — Remove `border-left: 3px solid` from `.toast--needs-input/complete/error` in `global.css:543-545`. Replace with `background: color-mix(in srgb, var(--warning) 6%, transparent)` (matches existing `color-mix()` pattern in terminal.css:244 and onboarding.css:305). Keep colored dot as primary type indicator. Removes AI slop pattern #8.

## Medium (15-30 min each with CC)

- [x] **Replace Inter with Space Grotesk as primary UI font** — Change `font-family` in `global.css:82` from Inter to Space Grotesk. Keep Inter as fallback. JetBrains Mono stays for terminal/code. **Bundle SpaceGrotesk-Regular.ttf (400 weight)** from Google Fonts (~30KB) alongside existing Medium + Bold. Add `@font-face` for weight 400. Verify readability at 10-11px sizes. Gives Hariari typographic brand identity.

- [x] **Add empty states for sidebar and search** — (a) Sidebar zero-project state: dragonfly icon + "No projects yet" + "Open Folder" button. **Note:** only shows when `onboardingComplete` is true (onboarding owns the first-run flow, sidebar owns post-onboarding empty state). Document this boundary in code comments. (b) Sidebar zero-agent state per project: "No agents running" + "Launch Agent" button. (c) Command palette: "No matching commands" message. (d) File finder: "No files found" message. Empty states are features, not afterthoughts.

- [x] **Add command palette category group headers** — Group results under category headers (Recent, Agent, Layout, File, Theme, Git, Voice, View, General). Category types already exist in `command-palette.ts:1`. Flat list doesn't scale past 30 commands.

- [x] **Add terminal startup loading state** — Show agent brand icon centered with "Starting [AgentName]..." text and subtle pulse animation in terminal area while agent boots. Transition to live terminal when first output arrives. **Timeout states:** 15s with no output → change text to "Agent may be slow to respond...". 60s → "Agent may have failed to start" with retry button. Handles reconnects, restored sessions, and silent failures. Prevents "is it broken?" blank-screen anxiety.

## Larger Features (30+ min with CC)

- [x] **Implement 48px icon-rail collapsed sidebar** — New sidebar collapse mode: 48px wide, dragonfly icon at top, project letter avatars (first letter in colored circle, color from name hash), agent type icons stacked below each project. Pulsing amber dot on icons when attention needed. 150ms ease-out animated toggle. **Ctrl+B keyboard shortcut** (register in keybinding-defaults.ts). **Overflow spec:** scrollable rail, max 6 visible icons per project then "+N" badge, tooltips on hover showing full name. **Architecture:** single component with conditional render (not separate IconRail class). Depends on: letter avatar generation, animated sidebar toggle.

- [x] **Add ARIA live regions + landmarks** — (a) Single central `aria-live="polite"` region on `document.body` announces agent status changes ("[Agent] needs your input"). (b) ARIA landmarks: `role="navigation"` on sidebar, `role="main"` on terminal area, `role="status"` on hint bar. (c) `aria-label` on sidebar status dots with current state. **Note:** Ctrl+B sidebar toggle is part of the icon rail task above (consolidated per eng review).

- [x] **Create DESIGN.md** — Document the design system: color token semantics, typography hierarchy (Space Grotesk for UI, JetBrains Mono for code), spacing scale, button variants (primary/secondary/danger), status color semantics (green=success/complete, amber=warning/needs-input, red=error, gray=idle), animation tokens, brand guidelines (dragonfly mascot, Tokyo Night default theme). Should be created AFTER font change, color fix, and toast fix land.

## New Features

- [x] **Auto-arrange windows on agent add/close** — When a user adds or closes an agent, automatically arrange all agent terminal windows in equal splits instead of requiring the user to manually click the auto-arrange button. The system detects when agents are added or removed and triggers layout rebalancing automatically.

- [ ] **Single Preview — cross-project agent overview** — A unified view that shows all active agents across all projects in a single screen. Does not move or detach existing terminal panes — instead, creates mirrored terminal instances that share the same PTY sessions, so the user retains full context and can continue interacting from within Single Preview exactly as they would from within the project. Agents are auto-arranged in equal splits. Switching between Single Preview and a project view should be seamless with no context loss. Key requirements: (a) Aggregate active agents from all open projects. (b) Mirror terminal sessions (shared PTY, not new processes). (c) Auto-arrange layout using equalizeAll(). (d) Sidebar or top-level toggle to enter/exit Single Preview. (e) Status indicators showing which project each agent belongs to.

## Approved Design Direction

Mockup: `~/.gstack/projects/nandadevaiah-hariari/designs/core-ui-review-20260330/variant-D.png`

Unified sidebar/icon-rail: expanded (240px) with project tree + agents, collapsed (48px) icon rail with stacked project letter avatars and agent type icons. Bottom hint bar stays separate with keyboard shortcuts. Animated toggle at 150ms ease-out.

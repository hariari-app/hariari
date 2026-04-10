# Changelog

All notable changes to Hariari are documented in this file.

## [0.6.0] — 2026-04-11

### Added

- **Per-project tab colors** — every open project now renders its tab with a unique color tint (background, hover, active, and bottom underline) derived from the same HSL hash the sidebar rail avatars use. Scan the tab bar and immediately know which tab is which project without reading the name. Active tab stacks three signals: stronger tint + full-color underline + bold weight.
- **Whole-tab attention pulse** — when an agent needs user input, the entire tab now pulses between its project color and `--warning` (amber) at a 1.6s cadence, replacing the old 8px corner dot. Respects `prefers-reduced-motion` by holding statically at peak warning. Screen readers announce `"needs input"` via an `aria-label` suffix.
- **Platform-native window controls** — custom close / minimize / maximize buttons now match the host OS. Windows 11-style flat rectangular buttons (46px wide, flush to frame edge, red close-hover) on Windows. GNOME Adwaita-style circular buttons (26px neutral fill) on Linux. Completely hidden on macOS where the native traffic lights already render on the left via `trafficLightPosition`. Unicode glyphs (U+2212, U+25A1, U+2715) so buttons communicate their function without relying on color alone.
- **Unified editor popout chrome** — the editor pop-out window (`Ctrl+Shift+E`) now uses the same frameless custom title bar as the main window, replacing the old native OS title bar. Single 42px bar with project name label on the left, draggable spacer in the middle, and platform-native controls on the right. On macOS, native traffic lights render on the left via `trafficLightPosition`.

### Changed

- **Tab bar height** — bumped from 36px to 42px for better surface area for the per-project color tints and more comfortable tab recognition.
- **CodeMirror editor theme follows app theme** — the editor pop-out window and inline file viewer now conditionally apply `@codemirror/theme-one-dark` only on dark app themes, and fall back to CodeMirror's light defaults on light themes. A new theme-aware `cmTheme` chrome layer uses CSS variables for background, gutter, active line, selection, and caret so all 16 themes render correctly. Previously the editor was stuck in dark rendering regardless of active theme.
- **Shadow token system** — 6 theme-aware shadow tokens extracted via `enrichChrome()`: `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-overlay`, `--shadow-modal`, `--backdrop-overlay`. Lighter alphas on light themes eliminate the bruised look that pure-black drop shadows produced on pale backgrounds. Replaced ~30 duplicated raw rgba values across 4 CSS files.
- **Typography scale** — added `--font-2xs` (9px) and `--font-xl` (18px) tokens. Swept 19 raw `font-size: Npx` declarations across 5 files to use the now 7-step scale.
- **Border radius scale** — introduced 6 radius tokens: `--radius-xs` (2), `--radius-sm` (4), `--radius-md` (6), `--radius-lg` (8), `--radius-xl` (10), `--radius-pill` (9999). Swept ~107 raw `border-radius` declarations. Two intentional one-offs retained with inline comments.
- **DESIGN.md updated** with all new token families, the two-layer CodeMirror theming model, the per-project tab color system, and a 12→16 themes doc correction.

### Fixed

- **Editor Save / Discard buttons theme-aware** — were hardcoded to `#3b82f6` and `#ef4444`, rendering off-brand on 15 of 16 themes. Now use `var(--accent)` and `var(--error)`.
- **Agent pulse animations theme-aware** — `pulse-input` and `pulse-recording` keyframes had Tokyo Night warning/error RGB baked in. On non-default themes the dot pulsed in one color while the ring expanded in Tokyo Night's color. Now uses `color-mix` with `var(--warning)` / `var(--error)`.
- **Toast container overlap with 42px tab bar** — toasts were calibrated against the old 36px tab bar; after the bump they overlapped the bottom border by 2px. Moved `top: 40px → 46px` with a coupling comment.
- **Window control right inset** — custom window controls sat flush against the right frame edge with no breathing room. Added 12px `margin-right` (overridden to 0 on Windows, per Win11 flush-to-edge convention).

### Removed

- **Orphaned `.app-titlebar` CSS** — 28 lines of dead CSS that referenced a container class no longer rendered. The `.app-titlebar-controls` and `.app-titlebar-btn` rules remain (still in use for custom window controls).

## [0.5.2] — 2026-04-04

### Changed

- **Replaced Aider with Pi** — swapped Aider agent for [Pi](https://pi.dev), a minimal TypeScript-extensible terminal coding harness, across all agent registries, UI, command palette, voice commands, and skills manifest.

## [0.5.0] — 2026-04-03

### Added

- **Dedicated Editor Window** — a separate OS-level window for file browsing and source control, opening alongside the terminal without blocking agent interaction. Press `Ctrl+Shift+E` or click the folder button on any agent pane.
- **Full Git Source Control** — the editor window includes a complete SCM panel with staging, unstaging, commit (with amend and commit-and-push), pull, push, ahead/behind indicator, and commit graph visualization.
- **File Browser** — lazy-loaded directory tree with syntax-highlighted file viewing and editing via CodeMirror 6, supporting 13+ languages.
- **Folder Button on Agent Panes** — every agent terminal pane (including Single Preview mode) now has a 📂 button that opens the editor window for that project.
- **Singleton Window** — re-pressing the shortcut or clicking the folder button focuses the existing editor window instead of creating duplicates.
- **Shared Language Extensions** — extracted `getLanguageExtension()` into a shared module for consistent syntax highlighting across the file viewer and editor window.

### Changed

- **Split Horizontal keybinding** — default changed from `Ctrl+Shift+E` (now used by Editor Window) to `Ctrl+Shift+R`.
- **File Viewer overlay** — demoted to no default keybinding; still accessible via command palette as "Open File Viewer (Overlay)".

## [0.2.0] — 2026-04-02

### Added

- **Single Preview** — unified cross-project agent view showing all active agents in one screen (`Ctrl+Shift+A`). Terminals share PTY sessions via reattach, preserving full context. Includes sidebar toggle, command palette entry, and voice command support.
- **Grid layout picker** — floating button (top-right in preview) lets users choose grid arrangements (e.g., 2x3, 3x2). Default layout auto-selects the most square-ish grid for the agent count.
- **Project name badges** — status bars in Single Preview show which project each agent belongs to with an accent-tinted badge.
- **Auto-arrange on agent add/close** — terminal panes automatically equalize to equal splits when agents are spawned or closed, removing the need to manually click auto-arrange.
- **Clipboard screenshot paste** — `Ctrl+Shift+V` checks for image data on the clipboard, saves as a temp PNG, and pastes the file path into the terminal (works with Claude Code CLI). `Ctrl+V` remains text-only paste.
- **ARIA announcements** — screen reader announces "Entering/Exiting Single Preview" on toggle.

### Fixed

- **Agent spawn failure shows blank pane** — when an agent fails to spawn and the layout is empty, a fallback shell is spawned so the pane is never blank.
- **Windows shell command** — use `COMSPEC` (not `SHELL`) for the default shell on Windows, fixing Git Bash interference.
- **Windows NVM PATH separator** — use platform-correct separator (`;` on Windows, `:` on Unix) when prepending NVM node path.
- **Terminal content blank after exiting preview** — added `requestAnimationFrame` + `fitAll()` after reattach so xterm can measure its container.
- **"No project open" overlay in preview** — the empty state overlay no longer covers the Single Preview container.
- **Event listener leaks in grid picker** — dropdown outside-click handlers now use `AbortController` for reliable cleanup on all exit paths.
- **Status bar timer leaks in preview** — `AgentStatusBar` instances created in preview are tracked and disposed on exit/refresh.
- **`equalizeAll()` bypassed `isConnected` guard** — consolidated to use the shared `render()` path.

### Changed

- **`equalizeAll()` internals** — simplified to call `resetRatios()` then `render()` instead of inlining DOM operations.
- **`LayoutManager.reset()`** — new public method to clear layout state without disconnecting the ResizeObserver.
- **Grid tree builder** — replaced recursive midpoint binary tree with row-based grid builder producing clean equal-sized layouts.

## [0.1.7] — 2026-03-31

- Route Deepgram transcription through IPC for better logging.

## [0.1.6] — 2026-03-31

- Load voice settings from disk before showing setup dialog.

## [0.1.5] — 2026-03-31

- Default voice provider to OpenAI, add verbose transcription logging.

## [0.1.4] — 2026-03-30

- Update tests for Windows platform changes, remove portable build target.

## [0.1.3] — 2026-03-30

- Update tests for Windows platform changes and relaxed path validation.

## [0.1.2] — 2026-03-30

- Windows platform support — agent spawning, PTY env, path validation, fonts.

## [0.1.1] — 2026-03-29

- Cross-platform agent detection — Windows where.exe, PATH gating, no Homebrew assumption.

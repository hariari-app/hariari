# Changelog

All notable changes to Hariari are documented in this file.

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

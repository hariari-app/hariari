# Editor Window — Shaping Notes

## Scope

Replace the modal overlay file viewer with a dedicated separate OS-level Electron BrowserWindow that provides file browsing and full git source control without blocking terminal interaction.

## Decisions

- **Separate OS window** (BrowserWindow), not overlay or floating panel — user can arrange it alongside terminals
- **Fresh implementation** — new component tree under `src/renderer/src/editor-window/`, not extending old FileViewer
- **Same renderer entry point** — uses `?popout=editor-window` query param routing (existing pattern)
- **Singleton window** — main process tracks reference, re-invoke focuses existing window
- **Reuse existing infrastructure** — all git IPC channels, preload API, SCM sub-components (ScmCommitBox, ScmChangesList, ScmCommitGraph)
- **Full git UI** — staging, commit, push/pull, ahead/behind, commit graph — not just diffs

## Context

- **Visuals:** None
- **References:** Existing pop-out mechanism (`src/main/index.ts:162-192`), SourceControlPanel, FileViewer, SCM sub-components
- **Product alignment:** N/A (no agent-os/product/ directory)

## Standards Applied

- ipc/channel-naming — new `window:popout-editor` channel follows `domain:action` pattern
- ipc/validate-first-handlers — validate `{ projectPath: string }` in handler
- ipc/error-responses — return `{ error: 'popout_editor_failed' }` on failure
- ipc/preload-api-grouping — add `popoutEditor` to `window` namespace
- ipc/readonly-shared-types — readonly interfaces for new types
- ui/vanilla-dom-components — class-based with `dispose()` lifecycle
- ui/design-tokens — CSS custom properties only
- ui/keybinding-system — add to KEYBINDING_DEFAULTS
- ui/create-update-split — separate create/update functions
- global/unsubscribe-pattern — cleanup functions for event listeners

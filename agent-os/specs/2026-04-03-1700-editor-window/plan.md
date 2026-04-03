# Editor Window — Dedicated File Viewer & Source Control

## Context

The current VibeIDE file viewer is a modal overlay that blocks terminal interaction, forcing users out of context to browse files or review git changes. This makes it unusable during active agent sessions — the primary workflow. The enhancement replaces it with a **separate OS-level Electron BrowserWindow** that opens alongside the terminal, providing a full file browser and git UI without interrupting agent work.

## Scope

- **New**: Dedicated editor window (separate BrowserWindow) with file tree + CodeMirror editor + full git source control
- **Modify**: Keyboard shortcut (`Ctrl+Shift+E`) repointed to open the new window
- **Preserve**: Existing file viewer overlay remains functional (no breakage)
- **Reuse**: All existing IPC channels, git service, preload API, and SCM sub-components

## Architecture Decision

Use the **same renderer entry point** with `?popout=editor-window` query param routing (existing pattern at `src/renderer/src/main.ts:46`). This avoids a separate Vite entry and reuses the preload script.

**Singleton window**: Main process tracks the BrowserWindow reference. Re-invoking the shortcut focuses the existing window instead of creating a new one.

## New Files

All under `src/renderer/src/editor-window/`:

| File | ~Lines | Responsibility |
|------|--------|----------------|
| `editor-window-app.ts` | 400 | Top-level orchestrator: layout, sidebar tabs, coordination |
| `file-tree-panel.ts` | 300 | Lazy-loaded directory tree via `window.api.file.listDir()` |
| `scm-panel.ts` | 250 | Full git UI composing existing `ScmCommitBox`, `ScmChangesList`, `ScmCommitGraph` |
| `editor-pane.ts` | 350 | CodeMirror editor + MergeView + diff actions |
| `lang-extensions.ts` | 45 | Extracted `getLanguageExtension()` (shared with old FileViewer) |
| `editor-window.css` | 300 | Window-specific styles using design tokens |

## Modified Files

| File | Change |
|------|--------|
| `src/main/index.ts` | Add singleton `window:popout-editor` handler (~30 lines) |
| `src/shared/constants.ts` | Add `WINDOW_POPOUT_EDITOR` channel constant |
| `src/preload/index.ts` | Add `popoutEditor()` to `window` namespace |
| `src/renderer/src/main.ts` | Add `popout=editor-window` routing branch + keybinding action |
| `src/renderer/src/ui/keybinding-defaults.ts` | Add `editor-window` keybinding, demote `file-viewer` |
| `src/renderer/src/file/file-viewer.ts` | Import `getLanguageExtension` from shared module |

## Standards Applied

All 10 standards from `agent-os/standards/` (5ccec2cf worktree):
- **ipc/channel-naming** — `WINDOW_POPOUT_EDITOR: 'window:popout-editor'`
- **ipc/validate-first-handlers** — validate `{ projectPath: string }` in handler
- **ipc/error-responses** — return `{ error: 'popout_editor_failed' }` on failure
- **ipc/preload-api-grouping** — `api.window.popoutEditor(projectPath)`
- **ipc/readonly-shared-types** — readonly interfaces for new types
- **ui/vanilla-dom-components** — class-based with `dispose()` lifecycle
- **ui/design-tokens** — CSS custom properties only, no hardcoded values
- **ui/keybinding-system** — add to `KEYBINDING_DEFAULTS`, register in dispatcher
- **ui/create-update-split** — separate `create*()` and `update*()` functions
- **global/unsubscribe-pattern** — all subscriptions return `() => void` cleanup

## Tasks

### Task 1: Save Spec Documentation
Create `agent-os/specs/2026-04-03-1700-editor-window/` with plan.md, shape.md, standards.md, references.md.

### Task 2: Extract Shared Utilities + IPC Foundation
1. Create `src/renderer/src/editor-window/lang-extensions.ts` — extract `getLanguageExtension()` and CM theme from `file-viewer.ts`
2. Update `file-viewer.ts` to import from shared module
3. Add `WINDOW_POPOUT_EDITOR` to `src/shared/constants.ts`
4. Add `popoutEditor` to preload `window` namespace in `src/preload/index.ts`
5. Add singleton BrowserWindow handler in `src/main/index.ts`

### Task 3: Editor Pane
Create `src/renderer/src/editor-window/editor-pane.ts`:
- CodeMirror EditorView for file viewing/editing
- MergeView for diff viewing
- Read-only / edit mode toggle
- File save via `window.api.file.write()`
- Breadcrumb path display
- Diff action bar (stage, discard)
- `dispose()` cleanup

### Task 4: File Tree Panel
Create `src/renderer/src/editor-window/file-tree-panel.ts`:
- Lazy directory loading via `window.api.file.listDir()`
- Expand/collapse tree nodes
- File selection callback to parent
- Current file highlighting
- `dispose()` cleanup

### Task 5: SCM Panel
Create `src/renderer/src/editor-window/scm-panel.ts`:
- Compose existing `ScmCommitBox`, `ScmChangesList`, `ScmCommitGraph`
- Branch label + ahead/behind indicator
- Push/pull buttons
- File selection events (for diff viewing)
- Auto-refresh on 5s interval with `dispose()` cleanup

### Task 6: Window App + Styles + Routing
1. Create `src/renderer/src/editor-window/editor-window-app.ts` — orchestrator
2. Create `src/renderer/src/editor-window/editor-window.css`
3. Add `popout=editor-window` routing in `src/renderer/src/main.ts`

### Task 7: Keybinding Integration
1. Add `editor-window` entry to `KEYBINDING_DEFAULTS`
2. Add action handler in `src/renderer/src/main.ts` keybinding actions
3. Demote `file-viewer` keybinding (remove default key, keep action)

### Task 8: Polish
- Window position/size persistence (save on close, restore on open)
- Focus-on-reopen singleton behavior
- Handle project path changes while window is open
- Verify old file viewer overlay still works

## Verification

1. **Build**: `npm run build` passes with no TypeScript errors
2. **Shortcut**: Press `Ctrl+Shift+E` — new window opens with file tree for active project
3. **File browsing**: Navigate directories, open files, syntax highlighting works
4. **Source control**: Switch to SCM tab, see changed files, stage/unstage, commit, push
5. **Diff viewing**: Click a changed file, see side-by-side diff with stage/discard actions
6. **Singleton**: Press shortcut again — focuses existing window, doesn't create duplicate
7. **Independence**: Terminal remains fully usable while editor window is open
8. **Old overlay**: Old file viewer shortcut (if manually bound) still works

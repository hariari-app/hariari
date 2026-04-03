# References for Editor Window

## Similar Implementations

### Pop-out File Viewer (existing)

- **Location:** `src/main/index.ts:162-192`
- **Relevance:** Existing BrowserWindow creation pattern for file viewer pop-out
- **Key patterns:** Query param routing (`?popout=file-viewer`), same preload script, menu bar hidden

### SourceControlPanel

- **Location:** `src/renderer/src/scm/source-control-panel.ts`
- **Relevance:** Full git UI with commit, push/pull, staging — the new SCM panel wraps its sub-components
- **Key patterns:** Auto-refresh on 5s interval, branch/ahead-behind display, compose ScmCommitBox + ScmChangesList + ScmCommitGraph

### SCM Sub-Components

- **Location:** `src/renderer/src/scm/scm-commit-box.ts`, `scm-changes-list.ts`, `scm-commit-graph.ts`
- **Relevance:** Standalone components that take container + callbacks — directly reusable
- **Key patterns:** Callback-based interface, DOM-only rendering, no external dependencies

### FileViewer

- **Location:** `src/renderer/src/file/file-viewer.ts`
- **Relevance:** Reference for CodeMirror editor creation, MergeView diff, file tree rendering, language detection
- **Key patterns:** `getLanguageExtension()` utility, `cmTheme` constant, EditorState compartments for read-only toggle

### Keybinding System

- **Location:** `src/renderer/src/ui/keybinding-defaults.ts`, `src/renderer/src/ui/keybindings.ts`
- **Relevance:** Pattern for adding new keyboard shortcuts
- **Key patterns:** KEYBINDING_DEFAULTS array, keybindingActions map in main.ts, command palette registration

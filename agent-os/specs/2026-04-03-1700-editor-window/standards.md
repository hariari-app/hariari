# Standards for Editor Window

The following standards apply to this work (from agent-os/standards/ in worktree 5ccec2cf).

---

## ipc/channel-naming

All channels: `domain:action` format. Defined once in `shared/constants.ts` as `IPC_CHANNELS` const object.
- Never use string literals for channels
- Key name: `DOMAIN_ACTION` (screaming snake)
- Value: `domain:action` (lowercase colon-sep)

## ipc/validate-first-handlers

Every `ipcMain.handle` callback receives `raw: unknown` and validates before processing.
- Validate via dedicated functions in `ipc/validators.ts`
- Validators throw on invalid input
- Paths: resolved via `path.resolve()`

## ipc/error-responses

Handlers never throw across the IPC boundary. Return `{ error: 'snake_case_code' }` on failure.
- Wrap every handler body in try/catch
- Log full error server-side
- Never expose stack traces to renderer

## ipc/preload-api-grouping

The `contextBridge` API mirrors channel domains as nested objects.
- Group by domain: `api.window.*`
- Type the full API surface in `shared/ipc-types.ts` as `VibeIDEApi`

## ipc/readonly-shared-types

All IPC interfaces use `readonly` fields and `ReadonlyArray`.
- Never mutate received IPC data

## ui/vanilla-dom-components

All UI built with vanilla DOM APIs. No frameworks.
- Class-based components with `dispose()` for cleanup
- Use `role` and `aria-label` for accessibility

## ui/design-tokens

All styling uses CSS custom properties from `:root`.
- Use tokens, never raw values
- Colors: `--bg`, `--fg`, `--border`, `--accent`, `--surface`, etc.
- Spacing: `--space-1` through `--space-8`

## ui/keybinding-system

Centralized defaults with user-overridable bindings.
- Define in `KEYBINDING_DEFAULTS`
- Handle id in keybindings dispatcher
- Register in command palette

## ui/create-update-split

Separate `createX()` and `updateX()` functions.
- Never recreate DOM when only state changed

## global/unsubscribe-pattern

All event subscriptions return `() => void` cleanup.
- Caller stores return value and calls during dispose

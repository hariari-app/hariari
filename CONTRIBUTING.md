# Contributing to Hariari

Thanks for your interest in contributing to Hariari! This guide will help you get started.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/hariari/hariari/issues) to avoid duplicates
2. Use the **Bug Report** issue template
3. Include your OS, Hariari version, and steps to reproduce

### Suggesting Features

1. Open a [Feature Request](https://github.com/hariari/hariari/issues/new?template=feature_request.yml)
2. Describe the problem you're trying to solve, not just the solution
3. Check existing issues and discussions first

### Submitting Code

1. **Fork** the repository
2. **Create a branch** from `main` — use a descriptive name:
   - `feat/voice-command-history`
   - `fix/terminal-resize-crash`
   - `docs/update-shortcuts`
3. **Make your changes** following the guidelines below
4. **Open a Pull Request** against `main`

## Development Setup

```bash
git clone https://github.com/<your-fork>/hariari.git
cd hariari
npm install
npm run dev
```

### Build from Source

```bash
npm run dist:linux   # .deb + .AppImage
npm run dist:mac     # .dmg
npm run dist:win     # .exe
```

### Run Tests

```bash
npm test             # run once
npm run test:watch   # watch mode
```

## Coding Guidelines

### Style

- **TypeScript** — strict mode, no `any` unless unavoidable
- **Vanilla DOM** — no React/Vue/Angular; use direct DOM manipulation
- **Immutability** — create new objects, don't mutate existing ones
- **Small files** — aim for 200-400 lines, 800 max
- **Small functions** — under 50 lines

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add voice command history
fix: terminal resize crash on split pane
docs: update keyboard shortcuts table
refactor: extract theme manager from main
chore: bump electron to v33
```

### What Makes a Good PR

- **One concern per PR** — don't mix features with refactoring
- **Tests included** — add or update tests for your changes
- **TypeScript compiles** — `npx tsc --noEmit` must pass
- **Description explains why** — not just what changed, but why it matters

### Architecture Notes

- **Main process** (`src/main/`) — Electron main, IPC handlers, PTY management
- **Renderer** (`src/renderer/`) — terminal panels, UI, keybindings
- **Shared** (`src/shared/`) — IPC types, constants shared between processes
- **Preload** (`src/preload/`) — secure bridge between main and renderer

## Pull Request Process

1. Ensure CI passes (TypeScript check + tests + build)
2. A maintainer will review your PR
3. Address any feedback
4. Once approved, a maintainer will merge

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.

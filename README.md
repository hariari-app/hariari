# Hariari

[![npm version](https://img.shields.io/npm/v/hariari)](https://www.npmjs.com/package/hariari)
[![npm downloads](https://img.shields.io/npm/dm/hariari)](https://www.npmjs.com/package/hariari)
[![GitHub release](https://img.shields.io/github/v/release/hariari-app/hariari)](https://github.com/hariari-app/hariari/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

**The agent orchestrator for vibe coders.**

Run 12 AI coding agents side by side — Claude Code, Gemini CLI, Codex, and 9 more — with voice input, git worktree isolation, and split-pane terminals.

```bash
npx hariari@latest
```

Or install globally: `npm install -g hariari`

## Features

- **12 AI agents** — Claude Code, Gemini, Codex, Aider, OpenCode, Cline, Copilot, Amp, Continue, Cursor, Crush, Qwen
- **AI Skills integration** — install pre-packaged coding standards, TDD workflows, security patterns, and agent definitions during onboarding
- **Multi-project management** — sidebar with project groups, status badges, instant switching
- **Git worktree isolation** — each agent works in its own branch, review and merge with one click
- **Smart status detection** — knows when agents need input, complete, or errored
- **Toast notifications** — configurable sound, toast, and desktop alerts per event type
- **Voice input** — push-to-talk dictation (F3) and voice commands (F4)
- **File viewer** — CodeMirror 6 with syntax highlighting, git diff, pop-out to separate window
- **Source control** — commit graph, changes list, stage/unstage/discard
- **Command palette** — fuzzy search, context-aware filtering, agent-specific commands
- **Launch Workspace** — guided setup: pick project, choose agents, select layout, launch
- **Single Preview** — unified view of all active agents across all projects (`Ctrl+Shift+A`), with grid layout picker
- **Auto-arrange** — terminal panes automatically equalize when agents are added or closed
- **Clipboard screenshot paste** — `Ctrl+Shift+V` pastes screenshot as temp file path (works with Claude Code)
- **Copy-paste** — smart Ctrl+C (copies if selected, SIGINT if not), right-click context menu
- **12 themes** — 9 dark + 3 light (Tokyo Night, Dracula, Nord, Solarized, GitHub, Catppuccin, etc.)
- **Session persistence** — layout, agents, and scrollback restored on relaunch
- **First-run onboarding** — guided wizard: detect agents, install AI skills, select project

## AI Skills

Hariari bundles pre-packaged skills from the [AISkills](https://github.com/hariari-app/AISkills) repository. During onboarding (or later from the command palette), you can install:

- **Coding standards** — universal best practices, language-specific rules
- **TDD workflow** — test-driven development with 80%+ coverage enforcement
- **Security scanning** — AI regression testing, vulnerability detection
- **API design** — REST patterns, status codes, pagination, error responses
- **Agent definitions** — planner, code reviewer, security reviewer, architect, TDD guide
- **Language rules** — TypeScript, Python, Go, Rust, Kotlin, Java, Swift, C++, PHP, Perl

Skills are installed to each agent's config directory (`~/.claude/skills/`, `~/.gemini/rules/`, etc.) so your agents are effective out of the box.

## Install

### Quick Install (all platforms)

```bash
npx hariari@latest
```

This auto-detects your platform, downloads the latest release, verifies the checksum, and launches Hariari. Subsequent runs use the cached binary and auto-update when a new version is available.

Or install globally:

```bash
npm install -g hariari
hariari
```

### Manual Install

Download from the [Releases](https://github.com/hariari-app/hariari/releases) page, or use the commands below.

#### Linux

```bash
# Debian/Ubuntu
gh release download --repo hariari-app/hariari --pattern "*.deb" && sudo dpkg -i hariari_*_amd64.deb

# AppImage (any distro, no install needed)
gh release download --repo hariari-app/hariari --pattern "*.AppImage" && chmod +x Hariari-*.AppImage
```

#### macOS

```bash
gh release download --repo hariari-app/hariari --pattern "*.dmg"
```

Open the downloaded `.dmg` and drag Hariari to Applications. macOS builds are code-signed and notarized.

#### Windows

```bash
gh release download --repo hariari-app/hariari --pattern "*.exe"
```

Run the downloaded `.exe` installer. Windows builds are signed with Azure Trusted Signing.

## Quick Start

1. Open Hariari — the onboarding wizard detects installed agents
2. Install AI Skills (recommended preset or custom selection)
3. Add a project directory
4. Click **+** on a project to spawn an agent, or use **Launch Workspace** (sidebar play button) for multi-agent setup
5. Agents run in isolated git worktrees — review and merge changes when done

## Keyboard Shortcuts

On macOS, `Ctrl` is replaced by `Cmd` (`⌘`).

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+N` | New shell terminal |
| `Ctrl+Shift+D` | Split pane vertically |
| `Ctrl+C` | Copy selected text / SIGINT if no selection |
| `Ctrl+V` | Paste text from clipboard |
| `Ctrl+Shift+C` | Always copy selected text |
| `Ctrl+Shift+V` | Paste (image-aware — saves screenshot as temp file) |
| `Ctrl+Shift+A` | Toggle Single Preview (all agents across projects) |
| `Ctrl+P` | Quick open file |
| `Ctrl+Shift+E` | Open file viewer |
| `Ctrl+Shift+F2` | File viewer in new window |
| `Ctrl+Shift+G` | Git changes |
| `Ctrl+B` | Toggle sidebar |
| `F3` | Voice dictation (hold) |
| `F4` | Voice commands (hold) |

## Build from Source

```bash
git clone https://github.com/hariari-app/hariari.git
cd hariari
npm install
npm run dev        # development
npm run dist:linux # build .deb + .AppImage
npm run dist:mac   # build .dmg
npm run dist:win   # build .exe
```

## Tech Stack

- **Electron** + **electron-vite** + **TypeScript** (vanilla DOM, no React)
- **xterm.js 6** with WebGL addon for terminal rendering
- **node-pty** for PTY management
- **CodeMirror 6** for code viewing and editing
- **Web Audio API** for notification sounds
- **MediaRecorder** + Groq Whisper for voice-to-text

## License

[AGPL-3.0](LICENSE) — free for individual use.

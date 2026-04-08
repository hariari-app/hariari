# Hariari

**The agent orchestrator for vibe coders.**

Run 12 AI coding agents side by side — Claude Code, Gemini CLI, Codex, Copilot CLI, Amp, Cline, OpenCode, Continue, Cursor, Crush, Qwen Code, and Pi.

## Quick Start

```bash
npx hariari
```

This downloads and launches the latest Hariari release for your platform (Linux, macOS, or Windows).

## What it does

1. Detects your platform and architecture
2. Downloads the correct binary from [GitHub Releases](https://github.com/hariari-app/hariari/releases)
3. Verifies SHA256 checksum (when available)
4. Caches the binary at `~/.hariari/bin/` for instant subsequent launches
5. Auto-updates when a new version is available

## Global Install

```bash
npm install -g hariari
hariari
```

## Supported Platforms

| Platform | Architecture | Artifact |
|----------|-------------|----------|
| Linux | x64 | AppImage |
| Linux | arm64 | AppImage |
| macOS | x64 (Intel) | DMG |
| macOS | arm64 (Apple Silicon) | DMG |
| Windows | x64 | EXE installer |

## Links

- [GitHub](https://github.com/hariari-app/hariari)
- [Website](https://hariari.app)
- [Releases](https://github.com/hariari-app/hariari/releases)

## License

AGPL-3.0-or-later

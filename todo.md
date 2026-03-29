# VibeIDE — Goals, Phases & Tasks

> Last updated: 2026-03-29

---

## Product Goals

### Goal 1: Multi-Project Agent Orchestration

Be the first tool that lets vibe coders manage 3-7 projects with multiple AI agents each in a single window.

- **Phase 1 (Electron MVP)** — current
  - [x] Project-centric sidebar with collapsible project groups
  - [x] Agent list grouped under projects (not flat)
  - [x] Traffic-light status rollup per project (green/yellow/red/blue)
  - [x] Notification badges for unread events per project
  - [x] Instant project switching (pre-rendered in background)
- **Phase 2 (Native Rust)**
  - [ ] Port sidebar to native UI (egui/iced overlay)
  - [ ] Background state tracking for inactive projects
  - [ ] Overview mode — thumbnail previews of all project workspaces

---

### Goal 2: Agent-Aware Terminal Panes

Every pane surfaces real-time agent state so the user never reads raw output to know status.

- **Phase 1 (Electron MVP)**
  - [x] Agent status strip per pane: type, status, elapsed time
  - [x] Status states: running, idle, needs-input, error, complete
  - [x] "Needs input" amber/yellow urgency indicator
  - [x] Auto-detect agent type (Claude, Codex, Gemini) with branded icons
  - [x] Kill button per agent
  - [x] Agent-specific needs-input detection:
    - [x] Claude Code: detect permission prompts ("Allow", "Approve", tool use approval, plan confirmation)
    - [x] Claude Code: detect "Do you want to proceed?" and similar prompts
    - [x] Gemini CLI: detect input prompts and confirmation requests
    - [x] Codex: detect approval/confirmation patterns
    - [x] Detect agent waiting for user response (blocked state)
    - [x] Parse ANSI-styled prompts (colored/bold text in agent output)
  - [x] Configurable notification sounds per event type (needs-input, complete, error)
  - [x] One-click jump from sidebar notification badge to the specific agent terminal
  - [x] In-app toast notifications (top-right corner, 5s auto-dismiss)
  - [x] Per-event notification preferences UI (visual/sound/focus-steal toggles)
  - [x] Agent installation detection and guided install:
    - [x] Check if agent CLI is available on PATH before spawning (claude, gemini, codex)
    - [x] If not installed, show install prompt with instructions and install command
    - [x] Link to official install docs for each agent
    - [x] Detect installed version and show in agent status bar
    - [x] Auto-detect newly installed agents (periodic PATH check)
- **Phase 2 (Native Rust)**
  - [ ] GPU-rendered status overlays
  - [ ] Structured tool-call cards (Warp-style blocks)
  - [ ] OSC 133 shell integration for block-based output

---

### Goal 3: Voice as First-Class Input

Integrated local Whisper STT with cloud fallback. Linux market differentiator.

- **Spike (Week 0)**
  - [ ] whisper-rs push-to-talk proof of concept
  - [ ] Validate latency <2s on Linux (PulseAudio/PipeWire)
  - [ ] Validate small/base model accuracy for developer commands
- **Phase 1 (Electron MVP)**
  - [x] Push-to-talk hotkey (configurable)
  - [x] Voice transcript bar (overlay, auto-dismiss)
  - [x] Context-aware routing: app command vs. agent prompt
  - [x] Command prefix detection ("vibeide split vertical")
- **Phase 2 (Native Rust)**
  - [ ] Native whisper-rs integration (no Node overhead)
  - [ ] Cloud STT fallback (Deepgram/OpenAI)
  - [ ] Voice command history and corrections
  - [ ] Silero VAD for hands-free mode

---

### Goal 4: GPU-Accelerated Native Performance

Sub-5ms input latency, 120fps, <150MB memory with 4 agents.

- **Spike (Week 0)**
  - [ ] wgpu + cosmic-text glyph atlas: 120x40 grid at 120fps
  - [ ] alacritty_terminal as standalone library
  - [ ] Validate frame time <8.3ms on integrated GPUs
- **Phase 2.1 (Foundation)**
  - [ ] winit window + wgpu surface
  - [ ] Event loop with input handling
  - [ ] Config system (TOML)
- **Phase 2.2 (Terminal Rendering)**
  - [ ] Glyph atlas with cosmic-text/fontdue
  - [ ] Instanced draw call for terminal grid
  - [ ] PTY spawning via portable-pty
  - [ ] VT parsing via alacritty_terminal
  - [ ] Cursor rendering and blinking
  - [ ] Scrollback with ring buffer
- **Phase 2.3 (Multi-Terminal)**
  - [ ] Split panes (horizontal/vertical)
  - [ ] Resizable dividers
  - [ ] Focus management and keyboard navigation
  - [ ] Independent scrollback per pane

---

### Goal 5: Session Persistence and Restore

Close and reopen with zero setup cost — layout, agents, scrollback all restored.

- **Phase 1 (Electron MVP)**
  - [x] Save/restore window position and size
  - [x] Save/restore project list and active project
  - [x] Save/restore agent configurations per project
  - [ ] Save/restore terminal scrollback buffers
  - [x] Save/restore pane layout (splits, sizes)
- **Phase 2 (Native Rust)**
  - [ ] Binary serialization for fast restore (<500ms startup)
  - [ ] PTY reconnection for running agents
  - [ ] Session snapshots (named save points)

---

### Goal 6: Fast Read-Only File Viewer with Diff

Lightweight syntax-highlighted viewer for code review. Not a full editor.

- **Phase 1 (Electron MVP)**
  - [x] `Ctrl+P` fuzzy file finder scoped to current project
  - [x] Syntax-highlighted read-only viewer (CodeMirror 6)
  - [x] Git diff view (agent changes vs base branch)
  - [x] `Ctrl+Shift+H` cross-file search (ripgrep-backed)
  - [x] Temporary overlay pane (dismiss with Escape)
- **Phase 2 (Native Rust)**
  - [ ] tree-sitter syntax highlighting
  - [ ] GPU-rendered text viewer
  - [ ] Inline diff rendering

---

### Goal 7: Keyboard-First UX with Command Palette

Everything reachable via keybinding or fuzzy-searchable palette in <50ms.

- **Phase 1 (Electron MVP)**
  - [x] Fuzzy matching (replace `includes()` with proper fuzzy)
  - [x] Categorized commands (Agent, Layout, File, Theme)
  - [x] Recently-used commands at top
  - [ ] Context-aware filtering (commands change by focused pane)
  - [x] Inline keyboard shortcut display
  - [ ] Agent-registered custom commands
- **Phase 2 (Native Rust)**
  - [ ] GPU-rendered command palette overlay
  - [ ] Plugin-extensible command registry
  - [ ] Mode-based keybinding hints (Zellij-style)

---

### Goal 7b: Light Themes

Currently only 1 light theme (Tokyo Night Light). Add at least 3 more for users who prefer light mode.

- **Phase 1 (Electron MVP)**
  - [x] Solarized Light theme
  - [x] GitHub Light theme
  - [x] Catppuccin Latte theme (light variant)
  - [ ] Ensure all UI components (sidebar, status bars, command palette, file viewer, Source Control, commit graph) render correctly in light themes
  - [x] Ensure terminal WebGL renderer handles light backgrounds
  - [x] Light/dark mode toggle in command palette and settings

---

### Goal 8: Cross-Platform (Linux First)

Ship Linux first, then macOS and Windows.

- **Phase 1 (Electron MVP)**
  - [x] Linux .deb and .AppImage packages
  - [ ] macOS .dmg package
  - [ ] Windows .exe installer
  - [ ] CI/CD pipeline for all three platforms
- **Phase 2 (Native Rust)**
  - [ ] Linux: Wayland + X11 support
  - [ ] macOS: Metal backend via wgpu
  - [ ] Windows: DX12 backend via wgpu
  - [ ] Platform-specific keybinding defaults
  - [ ] One-line install script (`curl -sSL ... | sh`)

---

### Goal 9: WASM Plugin System

Extensibility via wasmtime-based plugins.

- **Phase 2.10 (Stretch)**
  - [ ] wasmtime runtime integration
  - [ ] Plugin API: register commands, intercept I/O, render UI
  - [ ] Plugin manifest format and discovery
  - [ ] Theme plugins
  - [ ] Layout preset plugins
  - [ ] Custom agent integration plugins
  - [ ] Plugin marketplace / community registry

---

### Goal 10: Reduce the Review Bottleneck

Every feature measured against: does it help the vibe coder review faster?

- **Phase 1 (Electron MVP)**
  - [x] Priority-based notification system (needs-input > error > complete > info)
  - [x] Visual triage: which agent to review first
  - [x] One-click jump to agent output from sidebar notification
  - [x] Configurable notification sounds per event type
- **Phase 2 (Native Rust)**
  - [ ] Smart review queue: agents sorted by priority/completion time
  - [ ] Agent output summary (collapsible, key changes highlighted)
  - [ ] Integration with git: show changed files per agent session

---

### Goal 10b: Git Worktree Isolation Per Agent

Run multiple agents safely on the same project by giving each agent its own isolated git worktree. Prevents merge conflicts and file corruption when agents edit the same codebase concurrently.

- **Phase 1 (Electron MVP)**
  - [ ] Auto-create git worktree when spawning an agent (`git worktree add`)
  - [ ] Each agent runs in its own worktree branch (e.g., `feature/agent-<id>-<type>`)
  - [ ] Display worktree branch name in agent status bar
  - [ ] Diff view: show agent's changes vs main branch
  - [ ] Merge workflow: one-click merge agent's branch back to main
  - [ ] Cleanup: remove worktree after merge or agent kill
  - [ ] Conflict detection: warn user if merge would conflict
  - [ ] Option to disable worktree isolation (run agent in main working directory)
- **Phase 2 (Native Rust)**
  - [ ] Automatic conflict resolution suggestions
  - [ ] Cherry-pick individual changes from agent worktrees
  - [ ] Worktree status dashboard (which agents have uncommitted changes)

---

### Goal 10c: Broad Agent Support

Support all major AI coding CLI agents so users can bring their preferred tools. Target: 11+ agents to match dmux.

- **Phase 1 (Electron MVP)**
  - [x] Claude Code (`claude`) — Anthropic
  - [x] Gemini CLI (`gemini`) — Google
  - [x] Codex CLI (`codex`) — OpenAI
  - **P0 — Must have for launch:**
  - [ ] Aider (`aider`) — 39K stars, pip install, most popular open-source agent
  - [ ] OpenCode (`opencode`) — 132K stars, npm/brew install, fast-growing Go TUI
  - [ ] Cline CLI (`cline`) — 60K stars, npm install, CLI 2.0 launched Feb 2026
  - **P1 — Should have for launch:**
  - [ ] GitHub Copilot CLI (`copilot`) — GA Feb 2026, npm/brew install
  - [ ] Amp (`amp`) — Sourcegraph-backed, npm install
  - [ ] Continue CLI (`cn`) — Open-source, npm install, same engine as IDE extensions
  - **P2 — Nice to have post-launch:**
  - [ ] Cursor CLI (`cursor-agent`) — Large commercial product, curl install
  - [ ] Crush (`crush`) — Charmbracelet fork of OpenCode, brew install
  - [ ] Qwen Code (`qwen`) — Alibaba-backed, free tier, curl install

  **Per-agent implementation checklist:**
  - [ ] Add to `AgentType` union in `agent-types.ts`
  - [ ] Add spawn config in `agent-config.ts` (command, args, env)
  - [ ] Add needs-input detection patterns in `input-detector.ts`
  - [ ] Add install info in `agent-install-info.ts` (install command, docs URL)
  - [ ] Add brand icon in `agent-icons.ts` (SVG)
  - [ ] Add version detection command in `agent-version-detector.ts`
  - [ ] Add to availability checker for periodic PATH scan

---

## Go-to-Market Goals

### Goal 11: Open-Core Licensing

Open source core, paid tier for premium features.

- **Pre-launch**
  - [ ] Choose license (MIT or Apache 2.0) for core
  - [ ] Define free vs. paid feature boundary
  - [ ] Draft EULA / Terms of Service for paid tier
- **Launch**
  - [ ] Open source repository (public GitHub)
  - [ ] CONTRIBUTING.md and contributor guidelines
  - [ ] License headers in all source files
- **Post-launch**
  - [ ] Paid tier: cloud sync (sessions/layouts across machines)
  - [ ] Paid tier: team collaboration (shared agent workspaces)
  - [ ] Paid tier: priority cloud STT
  - [ ] Payment integration (Stripe / Lemon Squeezy)
  - [ ] License key system or GitHub Sponsors integration

---

### Goal 12: Marketing Website

Single-page site with live demo, comparison table, and download links.

- **Design**
  - [ ] Domain registration (vibeide.dev or similar)
  - [ ] Brand identity: logo, color palette, typography
  - [ ] Wireframe the landing page layout
- **Build**
  - [ ] Hero section with 60-second demo video
  - [ ] Animated terminal screenshots (not static mockups)
  - [ ] Feature comparison table (vs. tmux, claude-squad, BridgeSpace, Warp)
  - [ ] Download buttons for Linux/macOS/Windows
  - [ ] Email capture for launch notifications
  - [ ] SEO optimization (meta tags, OG images, structured data)
- **Deploy**
  - [ ] Hosting setup (Vercel / Cloudflare Pages)
  - [ ] Analytics (Plausible or PostHog)
  - [ ] SSL and CDN

---

### Goal 13: Product Hunt Launch

Target top-5 finish on launch day.

- **Preparation (2-3 weeks before)**
  - [ ] Craft tagline: "The terminal for developers who talk to AI agents"
  - [ ] 4-6 gallery images showing key workflows
  - [ ] 90-second launch video (screen recording + voiceover)
  - [ ] Write maker story (solo founder narrative)
  - [ ] "First 500 users" incentive (early access to paid features free for life)
  - [ ] Build hunter network (reach out to top PH hunters)
- **Launch day (Tuesday or Wednesday)**
  - [ ] Publish listing at 12:01 AM PT
  - [ ] Post to social channels linking to PH
  - [ ] Respond to every comment within 1 hour
  - [ ] Send launch email to waitlist
- **Post-launch**
  - [ ] Follow up with upvoters
  - [ ] Publish "lessons learned" blog post
  - [ ] Update website with PH badge if top-5

---

### Goal 14: Social Media & Developer Community

Build presence on X/Twitter, YouTube, LinkedIn, and Discord.

- **Setup**
  - [ ] Create accounts: X/Twitter, YouTube, LinkedIn, Discord server
  - [ ] Brand all profiles consistently (logo, bio, links)
  - [ ] Discord: channels for #general, #feedback, #bugs, #showcase, #voice-beta
- **Content strategy**
  - [ ] Short-form demo clips (30-60s): voice-driven agent workflows
  - [ ] Before/after comparisons (tmux workflow vs. VibeIDE)
  - [ ] "How I build with 5 agents" workflow videos
  - [ ] Weekly dev log / changelog posts
  - [ ] Technical deep-dives (GPU rendering, Whisper integration)
- **Community growth**
  - [ ] Identify and engage developer influencers (Simon Willison, ThePrimeagen, etc.)
  - [ ] Cross-post to relevant subreddits (r/commandline, r/linux, r/programming)
  - [ ] Engage in HN, lobste.rs, and dev.to discussions about vibe coding
  - [ ] Early adopter beta program via Discord

---

### Goal 15: Hacker News & Dev Community Launch

Lead with the technical story for maximum HN engagement.

- **Content preparation**
  - [ ] Write "Show HN" post: WebKitGTK bottleneck discovery, Electron vs. Tauri benchmark, path to native Rust GPU rendering
  - [ ] Prepare benchmark data (latency comparisons, frame times)
  - [ ] Have a working demo ready (downloadable binary or live screencast)
- **Distribution**
  - [ ] Submit Show HN on a weekday morning (US time)
  - [ ] Cross-post to r/programming, r/commandline, r/linux, r/rust
  - [ ] Post to lobste.rs, dev.to, and relevant Discord servers
  - [ ] Respond to every HN comment substantively
- **Follow-up**
  - [ ] Write technical blog post expanding on the HN discussion
  - [ ] Address top questions/concerns raised in comments

---

### Goal 16: GitHub-First Distribution

The repo is the primary distribution and discovery channel.

- **Repository optimization**
  - [ ] README with GIF demos of key workflows
  - [ ] One-line install script for each platform
  - [ ] GitHub Releases with pre-built binaries (Linux, macOS, Windows)
  - [ ] GitHub Actions CI/CD for automated releases
  - [ ] CONTRIBUTING.md with setup guide and architecture overview
  - [ ] Issue templates (bug report, feature request)
  - [ ] Discussions tab enabled for Q&A
- **Growth targets**
  - [ ] 1,000 GitHub stars in first month
  - [ ] 10 external contributors in first quarter
  - [ ] Awesome-list submissions (awesome-cli, awesome-terminal, awesome-rust)
  - [ ] Package manager listings (Homebrew, AUR, Snap, winget)
- **Community health**
  - [ ] Respond to issues within 48 hours
  - [ ] Monthly release cadence
  - [ ] Public roadmap via GitHub Projects board

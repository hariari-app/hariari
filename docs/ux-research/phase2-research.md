# VibeIDE Phase 2 Research: Persona Validation, UX Design & Native Architecture

> Research Date: March 24, 2026
> Methodology: Web research, competitive analysis, codebase review of Phase 1 Electron MVP, founder validation interviews

---

## Table of Contents

1. [The Vibe Coder Persona](#1-the-vibe-coder-persona)
2. [Core User Journeys](#2-core-user-journeys)
3. [Competitive & Adjacent Product Analysis](#3-competitive--adjacent-product-analysis)
4. [Founder Validation](#4-founder-validation)
5. [Design Decisions (Validated)](#5-design-decisions-validated)
6. [Information Architecture](#6-information-architecture)
7. [UI Wireframes](#7-ui-wireframes-text-based)
8. [Phase 2 Technical Architecture](#8-phase-2-technical-architecture)
9. [Phase 1 MVP Assessment](#9-phase-1-mvp-assessment)
10. [Sources](#10-sources)

---

## 1. The Vibe Coder Persona

### 1.1 Who They Are

The vibe coder is a developer who has shifted from **code writer** to **orchestrator**. They describe what they want built in natural language and AI agents build it. Collins Dictionary named "vibe coding" the Word of the Year for 2025, signaling this is no longer a niche practice.

**Demographics:**
- Senior developers and technical founders (3-15+ years experience)
- Comfortable in terminals; many have tmux/Zellij muscle memory
- Run their own projects or lead small teams (1-5 people)
- Work across 2-5 codebases simultaneously
- Skew toward Linux and macOS power users
- Early adopters who treat AI agents as multipliers, not toys

**Identity:** They think of themselves as architects, reviewers, and directors, not typists. The terminal is their command center, not a secondary tool. As Simon Willison describes: they run "multiple terminal windows open running different coding agents in different directories."

### 1.2 Daily Workflow

A typical work session follows a four-phase cycle, repeated 3-5 times per day:

| Phase | Duration | Activity |
|-------|----------|----------|
| **Decompose** | 5 min | Break work into parallel-safe tasks with clear boundaries |
| **Launch** | 3 min | Spin up agents with focused prompts (voice or typed) |
| **Review** | 17+ min | Monitor progress, validate scope, catch errors |
| **Integrate** | 10 min | Merge branches, resolve conflicts, run tests |

The entire loop for a multi-agent session takes ~35-45 minutes. A full work day includes 3-5 of these cycles interspersed with design thinking, communication, and planning.

**Key behavioral pattern:** The vibe coder does NOT stare at one terminal continuously. They glance across multiple agent outputs, looking for signals: errors, completion messages, questions that need answers. The workflow is more like an air traffic controller than a pilot.

### 1.3 Tools Currently Used

| Tool | Role | Pain Point |
|------|------|-----------|
| Claude Code | Primary AI agent (terminal) | Rate limits when running 3+ instances; no native multi-session UI |
| Codex CLI | Secondary agent, async tasks | Separate tool, no unified view |
| Cursor / Windsurf | AI-first IDE for visual work | Context switches between terminal and IDE |
| tmux / Zellij | Terminal multiplexer | No agent awareness; panes are just dumb shells |
| claude-squad | Multi-agent orchestrator | TUI-only, limited UI richness |
| Git worktrees | Isolation per agent | Manual setup, easy to lose track |
| Wispr Flow | Voice dictation | Separate tool, not integrated |
| Raycast / command palette | Quick actions | Per-app, not unified across agents |

### 1.4 Pain Points (Ranked by Impact)

1. **Review is the bottleneck.** Five agents completing simultaneously creates a cognitive pile-up. "Your throughput as a reviewer caps the system." There is no tool that helps triage which agent output to review first.

2. **No unified multi-project view.** Developers lose an average of 23 minutes of productivity per context switch. Current tools force switching between tmux windows, browser tabs, and IDE instances to track progress across projects.

3. **Agents start fresh every time.** Developers are frustrated by agents that forget everything between sessions. Persistent memory across sessions is the #2 most-requested agentic IDE feature (RedMonk 2025 survey).

4. **Terminal multiplexers have no agent awareness.** tmux and Zellij treat every pane identically. They don't know which pane has a Claude agent that's waiting for input, which has an error, or which just finished successfully.

5. **Rate limits and cost opacity.** Running three Claude Code instances on a Pro plan burns through rate limits 3x faster. No tool shows real-time cost/token usage across agents.

6. **Voice input is bolted on, not integrated.** Voice is 5x faster than typing (220 WPM vs 45 WPM) but current solutions are separate apps (Wispr Flow, Murmur) that pipe text into whatever has focus. No tool makes voice a first-class dispatch mechanism for agents.

7. **File browsing requires context switching.** When reviewing agent work, the vibe coder needs to quickly read files, check diffs, and search the codebase. Currently this requires opening VS Code or running `cat` in a separate terminal.

### 1.5 What They Value

- **Speed.** Sub-100ms latency on everything. GPU rendering. Instant startup.
- **Keyboard-first, mouse-optional.** Everything reachable via keybinding or command palette.
- **Glanceability.** Status at a glance without reading terminal output. Color-coded states, badges, progress indicators.
- **Minimal chrome.** Maximum terminal real estate. Sidebars should be collapsible. No decorative elements.
- **Session persistence.** Close the app, reopen it, and everything is exactly where it was.
- **Opinionated defaults, deep customization.** Works perfectly out of the box; extensible when needed.

---

## 2. Core User Journeys

### Journey 1: Starting a Work Session

**Current behavior:** Open terminal, `cd` to project, run `tmux`, manually open panes, start agents in each pane. Or open BridgeSpace/Agents UI, configure workspace, wait for setup. This takes 2-5 minutes.

**Optimal VibeIDE experience:**

1. Launch VibeIDE. Previous session restores instantly (layout, agents, scrollback).
2. **Dashboard view** shows all projects with status summary:
   - Project A: 2 agents idle, last active 2 hours ago
   - Project B: 1 agent running, started 5 min ago
   - Project C: 3 agents complete, needs review
3. Click/select a project to enter its workspace. Agents resume where they left off.
4. If starting fresh: `Ctrl+Shift+P` -> "New Project" -> select directory -> choose agent template (e.g., "2x Claude + Shell" layout).

**Design implication:** VibeIDE needs a **project-level abstraction** above the current flat agent list. The sidebar should group agents by project, not show a flat list.

### Journey 2: Deep Work on a Single Project

**Typical setup:** 2-4 agents active for one project. Common configurations:
- 2 agents: builder + reviewer (side by side)
- 3 agents: feature A + feature B + shell for manual commands
- 4 agents: 2x2 grid (architect + 2 builders + tester)

**Workflow within a project:**

1. Type or voice-dictate a task to the focused agent pane.
2. Agent begins working. Status indicator changes from "idle" to "working" (visual: animated dot or progress pulse).
3. Glance at other panes periodically. **Agent output scrolls, but a status bar per pane shows the current state**: working, waiting for input, completed, error.
4. When an agent completes, a **subtle notification** (badge on sidebar + configurable sound) draws attention.
5. Switch focus to completed agent (`Alt+1/2/3/4` or click). Review output.
6. If agent needs input (e.g., "Should I proceed?"), the status bar shows "Needs Input" in amber/yellow — this is the highest-priority visual signal.

**Key insight:** The "needs input" state is the most time-critical notification. If an agent is blocked waiting for a yes/no, every second of delay wastes the agent's capacity. VibeIDE must make this state impossible to miss.

**Design implication:** Each terminal pane needs a thin but visible **agent status strip** showing: agent type, status (running/idle/needs-input/error/complete), and elapsed time. The Phase 1 MVP has `AgentStatusBar` with type, dot, status text, uptime, and kill button — this is a solid foundation but needs a "needs input" state and visual urgency levels.

### Journey 3: Multi-Project Monitoring

**Scenario:** Developer has 3-5 active projects (validated: 3-4 actively, up to 5-7). They launched agents on all of them and are doing focused work on one project.

**Current tools fail here.** tmux windows per project means you can only see one at a time. BridgeSpace's workspace tabs have the same problem.

**Optimal experience:**

1. **Sidebar shows all projects** with a traffic-light summary:
   - Green dot: all agents running normally
   - Yellow dot: agent needs input or has a warning
   - Red dot: agent errored or crashed
   - Blue dot: agent completed successfully
2. **Notification badges** on project entries show unread events (completions, errors).
3. Clicking a project switches the workspace area to that project's layout instantly (no reload, pre-rendered in background).
4. **Optional: Overview mode** — a compact view showing thumbnail-sized previews of all project workspaces on one screen (like macOS Mission Control for terminals).

**Design implication:** The sidebar is sufficient for 3-5 projects (validated). Must be efficient and collapsible. Projects are the primary organizational unit. Agents are children of projects.

### Journey 4: File Exploration and Code Review

**When it happens:** After an agent completes a task, the vibe coder needs to:
- Read the files the agent modified
- Check diffs against the branch
- Search the codebase for related code
- Occasionally edit a file manually

**Current behavior:** Open VS Code side-by-side, or run `cat`/`less`/`bat` in a terminal pane. This is high-friction.

**Optimal experience:**

1. **Command palette** -> "Open File" (`Ctrl+P`) opens a fuzzy file finder scoped to the current project.
2. File opens in a **read-only viewer pane** within VibeIDE (syntax highlighted, line numbers). This is NOT a full editor. It's a fast, read-only file viewer.
3. **Diff view** available via command palette or keybinding, showing agent changes vs base branch.
4. **Search across files** (`Ctrl+Shift+F`) with ripgrep-speed results.
5. The file viewer is a **temporary pane** — it overlays or splits the terminal area and dismisses with `Escape`.

**Key principle:** VibeIDE is NOT an IDE. It does not need a full editor. The vibe coder reviews code; they rarely write it manually. A fast read-only viewer with diff support covers 90% of the use case. If they need to edit, they can open their editor of choice via a command.

**Design implication:** File explorer should be a **modal/overlay panel**, not a persistent sidebar element. It appears when needed and disappears when done. Think Raycast, not VS Code's file tree. Founder validated: not used often, but valued for confidence (Cursor/Windsurf parity).

### Journey 5: Voice-Driven Workflow

**Current state of voice coding (March 2026):**
- Claude Code shipped push-to-talk voice mode on March 3, 2026 (5% rollout)
- Codex shipped voice input on February 26, 2026 via Wispr engine
- Wispr Flow + Warp integration allows voice commands in terminal
- Voice is 5x faster than typing for natural language prompts

**Founder validation: Voice is the PRIMARY input method, not secondary.** The founder uses voice for EVERYTHING via Lotus Q (external app). Wants built-in voice with local Whisper or cloud STT. Key insight: NO good voice app exists for Linux — this is a market differentiator. Building for Linux, macOS, AND Windows.

**How vibe coders use voice:**
1. **Dispatch commands to agents:** "Claude, add pagination to the users API endpoint." Voice is ideal for high-level instructions that are natural language anyway.
2. **Quick actions:** "New shell," "Split vertical," "Switch to project B." Short commands that interrupt keyboard flow minimally.
3. **Not for code review or reading.** Voice is input-only. Output is always visual.

**Optimal VibeIDE voice experience:**

1. **Push-to-talk hotkey** (e.g., hold `Caps Lock` or a configurable key). Audio transcribed locally via whisper-rs.
2. Transcript appears in a **voice input bar** (similar to a command palette but for voice). User can review before sending.
3. Voice commands are **context-aware**: if an agent pane is focused, the command goes to that agent. If no pane is focused, it's a global command.
4. **Command prefix detection:** If the transcript starts with "vibeide" or "app," it's treated as an app command (e.g., "vibeide split vertical"). Otherwise it goes to the focused agent.

**Voice input flow (Phase 2):**
```
Microphone → Whisper (local) or Cloud STT
  → Command router
    → If app command ("vibeide split vertical"): execute
    → If agent prompt: pipe to focused terminal's stdin
    → If ambiguous: show in command palette for confirmation
```

**Design implication:** Voice input needs a **visible but non-intrusive transcript bar** that appears during push-to-talk and auto-dismisses after sending. Voice is a primary UI element, not a secondary overlay. Linux voice support is a unique selling point.

---

## 3. Competitive & Adjacent Product Analysis

### 3.1 BridgeSpace (Direct Competitor — What VibeIDE Replaces)

**Architecture:** Tauri v2 + React 19 + xterm.js
**Performance:** Laggy on Linux due to WebKitGTK (detailed in VibeIDE's `bridgespace-research.md`)

**UI Patterns to Learn From:**
| Pattern | Implementation | Verdict for VibeIDE |
|---------|---------------|-------------------|
| Pre-configured grid layouts (2, 2x2, 3x4, 4x4) | Quick workspace setup | **Adopt** — but make layouts fluid, not just fixed grids |
| Workspace tabs (color-coded) | Tab per workspace/project | **Adopt with modification** — use sidebar project list instead of tabs (scales better beyond 5 projects) |
| BridgeSwarm agent roles | builder/reviewer/scout/coordinator | **Study** — role labels are useful metadata for glanceability |
| Task board (Kanban) | Integrated task management | **Defer** — out of scope for VibeIDE's terminal-focused identity |
| Warp-style command blocks (OSC 133) | Collapsible command output | **Consider for Phase 2** — useful but complex to implement in native renderer |
| Quick Open (Cmd+P) file viewer | Lightweight file access | **Adopt** — essential for code review workflow |

**BridgeSpace's core weakness:** It tries to be everything (terminal + editor + task board + swarm orchestrator). VibeIDE should be laser-focused on **terminal orchestration** and do it at native speed.

### 3.2 claude-squad (Direct Competitor — TUI Approach)

**Architecture:** Go TUI running in a terminal, uses tmux for session isolation and git worktrees for code isolation.

**UI Patterns:**
| Pattern | Verdict |
|---------|---------|
| Agent list with status indicators | **Already in VibeIDE** — refine with richer status states |
| tmux-backed session persistence | VibeIDE uses native PTY management instead — better approach |
| Git worktree per agent | **Not VibeIDE's job** — but could offer a "launch in worktree" option |
| YOLO/auto-accept mode | **Consider** — a "trust level" setting per agent |

**claude-squad's core weakness:** It's a TUI. No GPU rendering, no rich UI, no file viewer, limited to what a terminal can display. VibeIDE has a strictly superior rendering surface.

### 3.3 Agents UI (Direct Competitor — macOS/Tauri)

**Architecture:** Tauri + Rust, bundled Zellij for session persistence.

**UI Patterns:**
| Pattern | Verdict |
|---------|---------|
| 2-pane split with resizable dividers | **Already in VibeIDE** |
| Auto-detected AI CLIs with branded icons | **Adopt** — visual distinction between agent types matters |
| Cmd+K command palette | **Already in VibeIDE** (Ctrl+Shift+P) |
| Monaco editor integration | **Skip** — VibeIDE should have a read-only viewer, not an editor |
| Structured tool-call cards | **Consider for Phase 2** — shows agent actions in card format |

### 3.4 Warp Terminal (UX Innovation Leader)

**Key innovation:** Block-based command output. Each command and its output are a discrete "block" that can be individually scrolled, copied, collapsed, or re-run.

> "Being able to scroll, copy, rerun, and understand past commands as blocks (not raw text) is Warp's real killer feature. Once you've used block-based output for a week, going back to a traditional terminal feels like reading a wall of text with no paragraph breaks."

**Warp 2.0 (June 2025):** Rebranded as "Agentic Development Environment" with Code, Agents, Terminal, and Drive in one workflow-native app.

**Patterns to Learn From:**
| Pattern | Verdict |
|---------|---------|
| Block-based command output | **High-value for Phase 2** — dramatically improves terminal readability. Requires OSC 133 shell integration parsing. |
| Inline diff editing | **Skip** — VibeIDE is not an editor |
| Notification rings on tabs when agent finishes/errors | **Adopt** — critical for multi-agent monitoring |
| AI-native command input (natural language) | **Partially adopt** — VibeIDE's voice mode serves this purpose |

**Warp's core weakness for vibe coders:** Single-project focus. No multi-project orchestration. No project-level organization of agents.

### 3.5 Zellij (Terminal Multiplexer UX Leader)

**Key innovation:** Mode-based interaction with discoverable keybindings shown in a status bar that updates based on current mode.

**Patterns to Learn From:**
| Pattern | Verdict |
|---------|---------|
| Floating panes (overlay for temporary tasks) | **Adopt** — perfect for file viewer, command palette, and voice transcript |
| Mode-based keybinding with status bar hints | **Partially adopt** — show available shortcuts contextually, but avoid modal confusion |
| WASM plugin system | **Adopt for Phase 2 native app** — extensibility via plugins (wasmtime) |
| Session persistence across restarts | **Already in VibeIDE** |

### 3.6 Raycast / Superkey (Command Palette Pattern)

**Key insight:** The command palette is the most important UI element for keyboard-driven users. It must be:
- Instant to open (<50ms)
- Fuzzy-searchable
- Show keyboard shortcuts inline
- Extensible (agents can register commands)
- Context-aware (commands change based on focused pane)

**VibeIDE's current command palette** (in Phase 1) has the right foundation but needs:
- Fuzzy matching (not just `includes()`)
- Categorized commands (Agent, Layout, File, Theme)
- Recently-used commands at top
- Context-aware filtering

### 3.7 Summary: What VibeIDE Must Do Better Than All Competitors

1. **Multi-project orchestration in one window** — no competitor does this well
2. **Agent-aware terminal panes** — status, notifications, and priority signals per pane
3. **GPU-native speed** — 120fps, sub-5ms latency (Phase 2)
4. **Voice as a first-class input** — not bolted on; Linux market differentiator
5. **Fast file viewer for code review** — not a full editor, just what reviewers need
6. **Glanceable status** — know the state of all agents across all projects without reading terminal output

---

## 4. Founder Validation

The following open research questions were validated directly by the founder (ND). These answers confirm or redirect key design decisions.

### Q1: How many projects do you actively monitor?

**Answer:** 3-4 actively, can stretch to 5-7.

**Design implication:** Sidebar is sufficient — no separate dashboard view needed. Must be efficient and collapsible. Project list must scale gracefully from 3 to 7 entries with agent sub-items.

### Q2: Notification preference — visual only or forced interruption?

**Answer:** Wants BOTH visual AND auditory feedback. Must be configurable per notification type. Strongly wants this.

**Design implication:** Implement a full notification configuration UI. Each event type (needs input, complete, error, build done) gets independent visual style, sound toggle, and focus-steal toggle. This is a non-negotiable requirement.

### Q3: Do you use the same agent layout for every project?

**Answer:** Uses common plugin templates (ECC — Everything Claude Code) across projects. Starts with template presets. Workspace templates are a key feature.

**Design implication:** Implement a template system at `~/.vibeide/templates/`. Ship with ECC default template. Templates define agent config, layout arrangement, and plugin set. "New Project" flow offers template selection.

### Q4: How often do you read files during agent work?

**Answer:** Not often, but values having the capability for confidence (like Cursor/Windsurf). Confirms modal overlay approach.

**Design implication:** File viewer is a modal overlay (not persistent sidebar). Optimize for rare-but-important use. Keep the implementation lean — read-only, syntax highlighted, dismissible with Escape. Parity with Cursor/Windsurf in capability, not in prominence.

### Q5: What is your most common voice command? Is voice primary or secondary?

**Answer:** Uses voice for EVERYTHING via Lotus Q (external app). Voice is the PRIMARY input method, not secondary. Wants built-in voice with local Whisper or cloud STT. Key insight: NO good voice app exists for Linux — this is a market differentiator. Building for Linux, macOS, AND Windows.

**Design implication:** Voice is promoted from "nice-to-have" to **core feature**. Integrate whisper-rs for local STT with cloud fallback. Voice command router must handle both app commands and agent prompts. The voice input bar is a primary UI element, not a secondary overlay. Linux voice support is a unique selling point — no competitor offers this.

---

## 5. Design Decisions (Validated)

Summary of the five key decisions confirmed by founder validation:

| # | Decision | Status | Rationale |
|---|----------|--------|-----------|
| 1 | **Sidebar sufficient for project navigation** | VALIDATED | 3-4 active projects (up to 7). No separate dashboard needed. Sidebar must be efficient and collapsible. |
| 2 | **Visual + auditory notifications, configurable per type** | VALIDATED | Founder strongly wants both. Each event type (needs input, complete, error, build done) gets independent config for visual, sound, and focus-steal. Non-negotiable. |
| 3 | **Workspace templates as key feature** | VALIDATED | Uses ECC templates across projects. Template system at `~/.vibeide/templates/` with presets for agents, layout, and plugins. |
| 4 | **File viewer as modal overlay** | VALIDATED | Rarely used but valued for confidence. Read-only, syntax highlighted, dismissible. Cursor/Windsurf parity in capability, not prominence. |
| 5 | **Voice as PRIMARY input method** | VALIDATED | Voice for everything. Built-in Whisper + cloud STT. No good Linux voice app exists — market differentiator. Cross-platform: Linux, macOS, Windows. |

---

## 6. Information Architecture

### 6.1 Sidebar Design

**Recommendation: Project-centric hierarchy with collapsible sections**

The current Phase 1 sidebar shows a flat list of agents under an "Agents" header. This works for a single project but breaks down at scale. The Phase 2 sidebar should introduce **projects as the primary grouping**.

```
SIDEBAR
+--------------------------------------------------+
| [VibeIDE logo/icon]            [collapse button]  |
+--------------------------------------------------+
| PROJECTS                              [+ New]     |
|                                                   |
| > vibeide (3 agents)                    [*] [2]  |
|   |-- Claude Code         [running]   |||         |
|   |-- Claude Code #2      [needs input] !         |
|   |-- Shell               [idle]                  |
|                                                   |
| > client-app (2 agents)                [*] [1]   |
|   |-- Gemini CLI          [running]   |||         |
|   |-- Shell               [idle]                  |
|                                                   |
| > api-server (1 agent)                 [ok]      |
|   |-- Claude Code         [complete]   checkmark  |
|                                                   |
+--------------------------------------------------+
| QUICK ACTIONS                                     |
| [New Project]  [New Agent]  [Settings]            |
+--------------------------------------------------+
```

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| Projects sorted by last activity, not alphabetically | Most-relevant project at top; the one you're working on is always first |
| Pinned projects (star icon) stick to top | Override sort for always-visible projects |
| Notification badge (number) on project entry | Shows unread agent events without expanding |
| Color-coded status dot per project | Worst-status-wins: if any agent has an error, project dot is red |
| Agent entries show type icon + status | Branded icons for Claude, Gemini, Codex, Shell |
| Collapsible project sections | Hide agents for projects you're not focusing on |
| Sidebar width: 200-250px, collapsible to icon-only | Maximize terminal real estate when not navigating |

**Agent status visual language:**

| Status | Color | Icon/Symbol | Priority |
|--------|-------|-------------|----------|
| Needs Input | Amber/Yellow | `!` pulsing | HIGHEST — agent is blocked |
| Error | Red | `x` | HIGH — agent crashed |
| Running | Green | animated dots `|||` | NORMAL — working as expected |
| Complete | Blue | checkmark | LOW — review when ready |
| Idle | Gray | `-` | LOWEST — waiting for work |

### 6.2 Workspace Area

**Recommendation: Flexible split-based layout (current approach) with focus mode and overview mode**

The Phase 1 binary-split tree layout (`SplitNode` with horizontal/vertical children) is the correct foundation. Enhancements for Phase 2:

**Layout modes:**

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Split mode** (default) | Normal state | Multiple panes visible, resizable dividers |
| **Focus mode** | `Ctrl+Shift+M` or double-click pane | One pane maximized, others hidden. Status bar shows "Focused on Agent X — press Escape to return" |
| **Overview mode** | `Ctrl+Shift+O` | All panes shown in a reduced grid with large status indicators. Clicking one enters focus mode on it. |

**Agent status strip per pane:**

Each terminal pane has a 24px status strip at the top:
```
+------------------------------------------------------------------+
| [Claude icon] Claude Code  |  running  |  12:34  |  /project/dir | [x]
+------------------------------------------------------------------+
| (terminal content)                                                |
|                                                                   |
+------------------------------------------------------------------+
```

When status is "needs input," the strip background pulses amber.
When status is "error," the strip background turns red.

**Grid presets (via command palette):**

| Preset | Layout | Use case |
|--------|--------|----------|
| Single | 1 pane full width | Focused agent work |
| Side-by-side | 2 panes horizontal | Builder + reviewer |
| Triple | 1 large left + 2 stacked right | Main agent + auxiliary |
| Quad | 2x2 grid | Parallel agents |
| Custom | User-defined splits | Power users |

### 6.3 File Explorer

**Recommendation: Modal overlay panel, not a persistent sidebar**

The file explorer should behave like Raycast: appear on demand, do its job, disappear.

**Trigger:** `Ctrl+P` (Quick Open) or command palette -> "Open File"

**Layout:**
```
+-------- File Explorer Overlay (60% width, centered) ---------+
| [Search: _____________________________________________]       |
|                                                               |
| src/                                                          |
|   main/                                                       |
|     agent/                                                    |
|       agent-manager.ts                          142 lines     |
|       agent-config.ts                            38 lines     |
|       agent-recorder.ts                          89 lines     |
|     pty/                                                      |
|       pty-manager.ts                             76 lines     |
|   renderer/                                                   |
|     src/                                                      |
|       ...                                                     |
|                                                               |
| [Enter: Open] [Ctrl+D: Diff] [Ctrl+G: Grep] [Esc: Close]    |
+---------------------------------------------------------------+
```

**File operations:**

| Operation | Trigger | Behavior |
|-----------|---------|----------|
| Open file (read-only) | Enter | Opens in a floating pane with syntax highlighting |
| View diff | Ctrl+D on selected file | Shows git diff in floating pane |
| Search in files | Ctrl+G | Ripgrep-style search across project |
| Open in external editor | Ctrl+E | Launches $EDITOR or configured IDE |

**File viewer pane:** Opens as a **floating pane** (Zellij-style) that overlays the terminal area. Dismissible with Escape. Supports scroll, line numbers, syntax highlighting, and search within file.

### 6.4 Command Palette

**Recommendation: Extend the current implementation with categories, fuzzy matching, and context awareness**

```
+------------- Command Palette (50% width, top-center) --------+
| > [search input: "spl___"]                                    |
|                                                               |
| LAYOUT                                                        |
|   Split Vertical                          Ctrl+Shift+D       |
|   Split Horizontal                        Ctrl+Shift+E       |
|                                                               |
| AGENTS                                                        |
|   Spawn Claude Agent                      Ctrl+Shift+1       |
|   Spawn Gemini Agent                      Ctrl+Shift+2       |
|                                                               |
| RECENT                                                        |
|   (last 3 commands used)                                      |
+---------------------------------------------------------------+
```

**Command categories:**
- **Agent:** Spawn, kill, restart, switch focus
- **Layout:** Split, close, focus mode, overview, presets
- **File:** Open, diff, search, open in editor
- **Project:** New, switch, rename, remove
- **Theme:** Switch themes
- **Voice:** Toggle voice mode, adjust settings
- **Settings:** General configuration

### 6.5 Notification System

**Recommendation: Three-tier notification system with configurable visual + auditory feedback**

**Notification tiers:**

| Tier | Where | When | User Action |
|------|-------|------|-------------|
| **Inline** | Agent status strip changes color/text | Always | Glance at pane |
| **Badge** | Sidebar project entry shows number | Agent completes, errors, or needs input | Click project to investigate |
| **Toast** | Top-right corner, auto-dismiss after 5s | Agent error or needs input (when project is not focused) | Click toast to switch to that project+agent |

**Configurable notification matrix (founder-validated requirement):**

```
┌─────────────────┬─────────┬───────┬─────────────┐
│ Event           │ Visual  │ Sound │ Steal Focus  │
├─────────────────┼─────────┼───────┼─────────────┤
│ Needs Input     │ Pulse   │ Chime │ Configurable │
│ Agent Complete  │ Badge   │ Ding  │ Never        │
│ Agent Error     │ Red dot │ Alert │ Configurable │
│ Build Done      │ Badge   │ None  │ Never        │
└─────────────────┴─────────┴───────┴─────────────┘
```

**What does NOT generate a notification:**
- Agent producing normal output (just scrolling text)
- Agent running normally (steady state)
- Terminal resize events
- Theme changes

### 6.6 Voice Input System

**Voice is a PRIMARY input method** (validated by founder). Push-to-talk with local Whisper transcription and cloud STT fallback.

**Voice input flow:**
```
Microphone → Whisper (local) or Cloud STT
  → Command router
    → If app command ("vibeide split vertical"): execute
    → If agent prompt: pipe to focused terminal's stdin
    → If ambiguous: show in command palette for confirmation
```

**Voice input bar:** Docked at bottom of workspace. Appears when push-to-talk is held and shows live transcript. On release, user can review, edit, send, or cancel.

---

## 7. UI Wireframes (Text-Based)

### 7.1 Default Workspace View (Multi-Project, Sidebar Visible)

```
+---+--------------------------------------------------------------------+
|   |                                                                    |
| S |   +-----------------------------+  +-----------------------------+ |
| I |   | [Claude] running  3:42 /proj|  | [Shell]  idle     0:15 /proj| |
| D |   +-----------------------------+  +-----------------------------+ |
| E |   |                             |  |                             | |
| B |   | $ claude                    |  | $ _                         | |
| A |   |                             |  |                             | |
| R |   | I'll implement the          |  |                             | |
|   |   | pagination feature. Let me  |  |                             | |
| P |   | start by reading the        |  |                             | |
| R |   | existing API endpoint...    |  |                             | |
| O |   |                             |  |                             | |
| J |   | Reading src/api/users.ts    |  |                             | |
| E |   | ...                         |  |                             | |
| C |   |                             |  |                             | |
| T |   +-----------------------------+  +-----------------------------+ |
| S |                                                                    |
|   |   +-----------------------------+  +-----------------------------+ |
|   |   | [Claude] needs-input  7:21  |  | [Gemini] complete  2:05    | |
|   |   +====AMBER PULSE=============+  +-----------------------------+ |
|   |   |                             |  |                             | |
|   |   | I found 3 potential         |  | Done. Created 4 test       | |
|   |   | approaches for the cache    |  | files with 92% coverage.   | |
|   |   | layer:                      |  |                             | |
|   |   | 1. Redis                    |  | Summary:                    | |
|   |   | 2. In-memory LRU            |  |  - users.test.ts           | |
|   |   | 3. SQLite                   |  |  - api.test.ts             | |
|   |   |                             |  |  - cache.test.ts           | |
|   |   | Which approach should I     |  |  - integration.test.ts     | |
|   |   | use?                        |  |                             | |
|   |   | > _                         |  |                             | |
|   |   +-----------------------------+  +-----------------------------+ |
|   |                                                                    |
+---+--------------------------------------------------------------------+
```

### 7.2 Single Project Deep-Work View (Focus Mode on One Agent)

```
+---+--------------------------------------------------------------------+
|   |                                                                    |
| S |   +--------------------------------------------------------------+ |
| I |   | [Claude] Claude Code  |  running  |  12:34  |  ~/project/api | |
| D |   +--------------------------------------------------------------+ |
| E |   |                                                              | |
| B |   | I'll implement the pagination feature for the users API.     | |
| A |   |                                                              | |
| R |   | Let me start by reading the existing endpoint...             | |
|   |   |                                                              | |
|   |   | Reading src/api/users.ts                                     | |
|   |   | Reading src/models/user.ts                                   | |
|   |   | Reading src/middleware/pagination.ts                          | |
|   |   |                                                              | |
|   |   | I see the current implementation uses offset-based           | |
|   |   | pagination. I'll add cursor-based pagination support:        | |
|   |   |                                                              | |
|   |   | Writing src/api/users.ts                                     | |
|   |   | Writing src/middleware/cursor-pagination.ts                   | |
|   |   | Writing tests/api/users-pagination.test.ts                   | |
|   |   |                                                              | |
|   |   | Running tests...                                             | |
|   |   |  PASS  tests/api/users-pagination.test.ts (3.2s)             | |
|   |   |   12 passed, 0 failed                                       | |
|   |   |                                                              | |
|   |   +--------------------------------------------------------------+ |
|   |   | [Esc: exit focus]  [Ctrl+P: files]  [Ctrl+Shift+O: overview] | |
|   |   +--------------------------------------------------------------+ |
|   |                                                                    |
+---+--------------------------------------------------------------------+
```

### 7.3 File Explorer Open (Overlay)

```
+---+--------------------------------------------------------------------+
|   |                                                                    |
| S |   (dimmed terminal content behind overlay)                         |
| I |                                                                    |
| D |   +------- File Explorer (centered, 60% width) ----------------+ |
| E |   | > [search: user___]                                         | |
| B |   |                                                             | |
| A |   |   src/api/users.ts                            234 lines    | |
| R |   |   src/models/user.ts                          89 lines     | |
|   |   | > src/middleware/                                            | |
|   |   |     cursor-pagination.ts                      156 lines    | |
|   |   |   tests/api/users-pagination.test.ts          312 lines    | |
|   |   |   src/types/user-types.ts                     45 lines     | |
|   |   |                                                             | |
|   |   +-------------------------------------------------------------+ |
|   |   | [Enter: Open]  [Ctrl+D: Diff]  [Ctrl+G: Grep]  [Esc: Close]| |
|   |   +-------------------------------------------------------------+ |
|   |                                                                    |
+---+--------------------------------------------------------------------+
```

### 7.4 Notification Toast (Top-Right)

```
+---+--------------------------------------------------------------------+
|   |                                                   +--------------+ |
| S |                                                   | ! Claude #2  | |
| I |   (normal terminal workspace)                     | needs input  | |
| D |                                                   | in vibeide   | |
| E |                                                   | [Go to]      | |
| B |                                                   +--------------+ |
| A |                                                                    |
| R |   +-----------------------------+  +-----------------------------+ |
|   |   | (terminal pane 1)           |  | (terminal pane 2)           | |
|   |   |                             |  |                             | |
|   |   ...                                                              |
```

### 7.5 Command Palette Open

```
+---+--------------------------------------------------------------------+
|   |                                                                    |
| S |   (dimmed terminal content)                                        |
| I |                                                                    |
| D |          +---- Command Palette (50% width, top) --------+         |
| E |          | > [split v___]                                |         |
| B |          |                                               |         |
| A |          | LAYOUT                                        |         |
| R |          |   > Split Vertical            Ctrl+Shift+D   |         |
|   |          |     Split Horizontal          Ctrl+Shift+E   |         |
|   |          |                                               |         |
|   |          | RECENT                                        |         |
|   |          |     New Claude Agent           Ctrl+Shift+1   |         |
|   |          |     Close Pane                 Ctrl+Shift+W   |         |
|   |          +-----------------------------------------------+         |
|   |                                                                    |
|   |   +-----------------------------+  +-----------------------------+ |
|   |   | (terminal pane 1, dimmed)   |  | (terminal pane 2, dimmed)   | |
|   |   ...                                                              |
```

### 7.6 Voice Input Active

```
+---+--------------------------------------------------------------------+
|   |                                                                    |
| S |   (normal terminal workspace, slightly dimmed)                     |
| I |                                                                    |
| D |   +-----------------------------+  +-----------------------------+ |
| E |   | (terminal pane 1)           |  | (terminal pane 2)           | |
| B |   |                             |  |                             | |
| A |   ...                                                              |
| R |                                                                    |
|   |   +------------------------------------------------------------+ |
|   |   | VOICE [recording...]                                        | |
|   |   | "Add pagination to the users API endpoint using cursor..."  | |
|   |   |                                      [Send] [Cancel] [Edit] | |
|   |   +------------------------------------------------------------+ |
|   |                                                                    |
+---+--------------------------------------------------------------------+
```

The voice transcript bar sits at the bottom, docked. It appears when push-to-talk is held and shows the live transcript. On release, the user can review, edit, send, or cancel.

---

## 8. Phase 2 Technical Architecture

### 8.1 Crate-Based Approach (NOT a WezTerm Fork)

Phase 2 uses a crate-based architecture where each responsibility is handled by a focused, battle-tested Rust crate composed into a unified application.

```
Core crates:
├── wgpu              → GPU rendering (WebGPU backend)
├── portable-pty      → PTY management (from WezTerm)
├── alacritty_terminal → VT parser + terminal state machine
├── cosmic-text       → Text shaping + glyph cache (System76)
├── egui              → UI chrome (sidebar, file explorer, notifications)
├── tokio             → Async I/O for PTY streams
├── notify            → File system watching for explorer
└── whisper-rs        → Local speech-to-text (voice engine)
```

### 8.2 Architecture Principles

- Terminal grid and UI chrome share the **same wgpu render pass**
- egui renders sidebar, file explorer, notifications on the **same GPU context**
- Voice engine runs as a **separate async task**, feeds into command router
- Project data model: **Project → Agents → Terminals** (hierarchical)
- **WASM plugin system** for extensibility (wasmtime)

### 8.3 Voice Input Flow

```
Microphone → Whisper (local) or Cloud STT
  → Command router
    → If app command ("vibeide split vertical"): execute
    → If agent prompt: pipe to focused terminal's stdin
    → If ambiguous: show in command palette for confirmation
```

### 8.4 Notification System Configuration

```
┌─────────────────┬─────────┬───────┬─────────────┐
│ Event           │ Visual  │ Sound │ Steal Focus  │
├─────────────────┼─────────┼───────┼─────────────┤
│ Needs Input     │ Pulse   │ Chime │ Configurable │
│ Agent Complete  │ Badge   │ Ding  │ Never        │
│ Agent Error     │ Red dot │ Alert │ Configurable │
│ Build Done      │ Badge   │ None  │ Never        │
└─────────────────┴─────────┴───────┴─────────────┘
```

### 8.5 Workspace Templates

```
~/.vibeide/templates/
├── default/          ← ECC + standard skills
│   ├── agents.json   ← Which agents to spawn
│   ├── layout.json   ← Terminal arrangement
│   └── plugins/      ← Shared plugins
├── frontend/         ← React project template
└── backend/          ← API project template
```

### 8.6 Platform Targets

- **Linux** (primary) — market differentiator for voice; no good voice coding app exists
- **macOS** — feature parity
- **Windows** — feature parity

---

## 9. Phase 1 MVP Assessment

The current Electron MVP (`/home/ndev/projects/vibeide/`) provides a solid foundation:

**What's working well:**
- Binary split-tree layout with resizable dividers (`LayoutManager`)
- Agent lifecycle management with status tracking (`AgentManager`, `AgentControls`)
- Command palette with keybinding support
- Session state persistence and restore
- Agent status bar with type, status dot, uptime, and kill button
- Multiple agent type support (Claude, Gemini, Codex, Shell)
- Terminal search (xterm.js addon)

**What needs enhancement for Phase 2:**
- Sidebar needs project-level grouping (currently flat agent list)
- Agent status needs "needs input" and "complete" states (currently only: starting, running, stopped, error)
- Command palette needs fuzzy matching and categories
- No file explorer or file viewer
- No voice input integration
- No notification system (toasts, sounds)
- No focus mode or overview mode
- No grid layout presets
- Keybindings are hardcoded (should be configurable)
- No multi-project support (single workspace only)

---

## 10. Sources

- [The 10x Vibe Coder Workflow: Claude Code and Cursor Simultaneously](https://stormy.ai/blog/10x-vibe-coder-workflow-claude-code-cursor)
- [Vibe Coding: The Complete Developer's Guide (2026)](https://www.sitepoint.com/vibe-coding-complete-developers-guide/)
- [The AI Coding Tools War of 2026](https://redreamality.com/blog/ai-coding-tools-war-vibe-coding-mainstream/)
- [Claude Code Agent Teams Documentation](https://code.claude.com/docs/en/agent-teams)
- [claude-squad: Manage Multiple AI Terminal Agents](https://github.com/smtg-ai/claude-squad)
- [Embracing the Parallel Coding Agent Lifestyle — Simon Willison](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)
- [Agentmaxxing: Run Multiple AI Agents in Parallel (2026)](https://vibecoding.app/blog/agentmaxxing)
- [BridgeSpace: Agentic Development Environment](https://www.bridgemind.ai/products/bridgespace)
- [Agents UI: AI Coding Agent Terminal for macOS](https://agents-ui.com/)
- [How Warp Went From Terminal to Agentic Development Environment](https://thenewstack.io/how-warp-went-from-terminal-to-agentic-development-environment/)
- [Warp 2.0: The Agentic Development Environment](https://www.warp.dev/blog/reimagining-coding-agentic-development-environment)
- [Zellij: A Terminal Workspace with Batteries Included](https://github.com/zellij-org/zellij)
- [10 Things Developers Want from their Agentic IDEs in 2025 — RedMonk](https://redmonk.com/kholterhoff/2025/12/22/10-things-developers-want-from-their-agentic-ides-in-2025/)
- [Claude Code Voice Mode: Hands-Free Coding Workflow](https://www.digitalapplied.com/blog/claude-code-voice-mode-batch-hands-free-coding-workflow)
- [Voice Coding in 2026: The Complete Guide — Murmur](https://murmur-app.com/en/blog/voice-coding-complete-guide)
- [Vibe Coding: AI + Voice = The New Developer Workflow — Wispr Flow](https://wisprflow.ai/vibe-coding)
- [Configure Claude Code to Power Your Agent Team — David Haberlah](https://medium.com/@haberlah/configure-claude-code-to-power-your-agent-team-90c8d3bca392)
- [Complete Guide to Development Context Management 2025](https://devcontext.io/blog/complete-guide-development-context-management-2025)
- [Raycast: Your Shortcut to Everything](https://www.raycast.com/)

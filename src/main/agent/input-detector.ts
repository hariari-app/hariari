// Patterns that indicate an agent is waiting for user input.
// Includes generic terminal patterns and agent-specific patterns
// for Claude Code, Gemini CLI, and Codex.

import type { AgentType } from '../../shared/agent-types';

// Comprehensive ANSI/VT escape sequence stripper
// Handles: SGR, cursor movement, screen clearing, OSC, DCS, alternate buffer, mouse, etc.
const ANSI_RE = new RegExp(
  [
    '\\x1b\\[[0-9;?]*[a-zA-Z]',       // CSI sequences (SGR, cursor, clear, etc.)
    '\\x1b\\][^\\x07]*\\x07',          // OSC sequences (title, hyperlinks)
    '\\x1b\\][^\\x1b]*\\x1b\\\\',      // OSC with ST terminator
    '\\x1b[()][0-9A-Z]',              // Character set selection
    '\\x1b[=>NOM78]',                 // Various mode switches
    '\\x1b\\[\\?[0-9;]*[hlsr]',       // Private mode set/reset (alternate screen, mouse, etc.)
    '\\x07',                           // Bell
    '\\x0f',                           // SI (Shift In)
    '\\x0e',                           // SO (Shift Out)
    '\\r',                             // Carriage return
  ].join('|'),
  'g',
);

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ─── Generic patterns (all agent types) ───

const GENERIC_PATTERNS: readonly RegExp[] = [
  // Yes/No prompts
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y\/n\)\s*[?:]?\s*$/i,
  /\(yes\/no\)\s*[?:]?\s*$/i,

  // Proceed/continue prompts
  /\bproceed\b.*[?]\s*$/i,
  /\bcontinue\b.*[?]\s*$/i,
  /\bconfirm\b.*[?]\s*$/i,

  // Generic question prompts
  /\bdo you want\b.*[?]\s*$/i,
  /\bwould you like\b.*[?]\s*$/i,
  /\bshould I\b.*[?]\s*$/i,

  // Common tool prompts
  /\benter\b.*:\s*$/i,
  /\bpassword\b.*:\s*$/i,
  /\bpress\b.*to continue/i,
  /\bpress enter\b/i,

  // Package manager prompts
  /\bIs this OK\b/i,
  /\bOk to proceed\b/i,

  // Git prompts
  /\bAbort\b.*[?]\s*$/i,
  /\boverwrite\b.*[?]\s*$/i,
];

// ─── Claude Code specific patterns ───

const CLAUDE_PATTERNS: readonly RegExp[] = [
  // Permission/tool approval prompts
  /\bDo you want to proceed\b/i,
  /\bApprove\b/i,
  /\bAllow\b.*tool/i,
  /\bAllow\b.*[?]\s*$/i,
  /\bDeny\b.*\bAllow\b/i,
  /\bReject\b.*\bApprove\b/i,

  // File edit confirmation
  /\bAccept\b.*edit/i,
  /\bApply\b.*changes/i,
  /\bSave\b.*changes.*[?]/i,

  // Plan/execution confirmation
  /\bExecute\b.*plan/i,
  /\bRun\b.*command.*[?]/i,
  /\bProceed with\b/i,

  // Claude Code specific prompt patterns
  /\(y\)es\s*\/\s*\(n\)o/i,
  /\(a\)lways\s*\/\s*\(y\)es\s*\/\s*\(n\)o/i,
  /\by\b.*\bn\b.*\ba\b.*to (allow|approve)/i,

  // Tool use approval — Claude shows tool name then asks
  /\bBash\b.*\bAllow\b/i,
  /\bRead\b.*\bAllow\b/i,
  /\bWrite\b.*\bAllow\b/i,
  /\bEdit\b.*\bAllow\b/i,

  // Waiting for user response indicators
  /waiting for.*input/i,
  /waiting for.*response/i,
  /\bUser\b.*\binput\b.*required/i,

  // Permission prompt with options
  /\[\s*y\s*\/\s*n\s*\/\s*a\s*\]/i,
  /\byes\b.*\bno\b.*\balways\b/i,

  // Claude's numbered menu selection prompts
  /\bThis command requires approval\b/i,
  /\bEsc to cancel\b/i,
  /\bTab to amend\b/i,
  /\bctrl\+e to explain\b/i,
  /^\s*[❯>]\s*\d+\.\s*(Yes|No|Always)/i,
  /^\s*\d+\.\s*Yes,?\s*and don/i,

  // Claude's interactive selection UI
  /\bEnter to select\b/i,
  /to navigate.*Esc to cancel/i,
  /\bto navigate\b/i,
  /^\s*\d+\.\s*(Yes|No|Chat about|Type something)/i,
  /^\s*[❯›>]\s*\d+\./,
];

// ─── Gemini CLI specific patterns ───

const GEMINI_PATTERNS: readonly RegExp[] = [
  // Gemini confirmation prompts
  /\bDo you approve\b/i,
  /\bShall I\b.*[?]\s*$/i,
  /\bGo ahead\b.*[?]\s*$/i,

  // Gemini tool execution
  /\bExecute\b.*[?]\s*$/i,
  /\bRun this\b.*[?]\s*$/i,
  /\bApply this\b.*[?]\s*$/i,

  // Gemini sandbox/safety
  /\bsandbox\b.*\ballow\b/i,
  /\bpermission\b.*\bgrant\b/i,

  // Gemini interactive prompts
  /\bConfirm\b.*action/i,
  /\bAccept\b.*suggestion/i,
  /\bReview\b.*changes.*[?]/i,

  // Gemini specific option patterns
  /\[\s*accept\s*\/\s*reject\s*\]/i,
  /\[\s*yes\s*\/\s*no\s*\/\s*edit\s*\]/i,
];

// ─── Codex specific patterns ───

const CODEX_PATTERNS: readonly RegExp[] = [
  // Codex approval prompts
  /\bapprove\b.*\bdeny\b/i,
  /\ballow\b.*\bdeny\b/i,

  // Codex execution confirmation
  /\bRun\b.*command/i,
  /\bExecute\b.*script/i,
  /\bApply\b.*patch/i,
  /\bWrite\b.*file.*[?]/i,

  // Codex sandbox
  /\bsandbox\b.*\bapprove\b/i,
  /\bauto-approve\b/i,

  // Codex interactive
  /\bConfirm\b.*execution/i,
  /\bProceed\b.*execution/i,
  /\[\s*approve\s*\]/i,
];

// ─── Multi-line patterns (check last N lines, not just last line) ───

const MULTILINE_PATTERNS: readonly RegExp[] = [
  // Claude's permission block often spans multiple lines:
  // "Claude wants to use Bash"
  // "Allow? (y/n/a)"
  /wants to (?:use|run|execute|read|write|edit)\b/i,

  // Gemini's tool blocks
  /proposed.*(?:action|change|edit)/i,

  // Any agent showing a diff then asking for approval
  /\+{3}.*\n.*approve/i,
];

// ─── Exclusion patterns ───

const EXCLUDE_PATTERNS: readonly RegExp[] = [
  /^\s*\d+%/,
  /^\s*[.]+\s*$/,
  /downloading/i,
  /compiling/i,
  /building/i,
  /\bStreaming\b/i,
  /\bGenerating\b/i,
  /\bThinking\b/i,
  /\bSearching\b/i,
];

// ─── Agent-type to patterns mapping ───

function getPatternsForAgent(agentType: AgentType): readonly RegExp[] {
  switch (agentType) {
    case 'claude': return [...GENERIC_PATTERNS, ...CLAUDE_PATTERNS];
    case 'gemini': return [...GENERIC_PATTERNS, ...GEMINI_PATTERNS];
    case 'codex': return [...GENERIC_PATTERNS, ...CODEX_PATTERNS];
    default: return GENERIC_PATTERNS;
  }
}

// ─── Main detection function ───

export function detectNeedsInput(recentOutput: string, agentType: AgentType = 'shell'): boolean {
  const cleaned = stripAnsi(recentOutput);

  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const patterns = getPatternsForAgent(agentType);

  // Check the last 10 lines individually — agent prompts often have
  // the question on one line and options/hints on subsequent lines
  const recentLines = lines.slice(-10);
  for (const line of recentLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check exclusions
    let excluded = false;
    for (const exclude of EXCLUDE_PATTERNS) {
      if (exclude.test(trimmed)) { excluded = true; break; }
    }
    if (excluded) continue;

    // Check agent-specific + generic patterns
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) return true;
    }
  }

  // Check multi-line patterns on the recent block
  if (recentLines.length >= 2) {
    const block = recentLines.join('\n');
    for (const pattern of MULTILINE_PATTERNS) {
      if (pattern.test(block)) return true;
    }
  }

  return false;
}

// ─── Output buffer ───

export class OutputBuffer {
  private buffer = '';
  private readonly maxSize: number;

  constructor(maxSize: number = 4096) {
    this.maxSize = maxSize;
  }

  append(data: string): void {
    this.buffer += data;
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
  }

  getRecent(): string {
    return this.buffer;
  }

  clear(): void {
    this.buffer = '';
  }
}

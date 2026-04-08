// Voice command router — detects app commands vs terminal text
// App commands are prefixed with "hariari" or match known command aliases
// Everything else is typed into the focused terminal

export interface VoiceCommand {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly action: () => void;
}

export type TerminalWriteCallback = (text: string) => void;

export class VoiceRouter {
  private readonly commands: VoiceCommand[] = [];
  private readonly onTerminalWrite: TerminalWriteCallback;

  constructor(onTerminalWrite: TerminalWriteCallback) {
    this.onTerminalWrite = onTerminalWrite;
  }

  registerCommand(command: VoiceCommand): void {
    this.commands.push(command);
  }

  // Dictation mode — text goes to terminal
  routeDictation(transcript: string): void {
    this.onTerminalWrite(transcript);
  }

  // Command mode — strip punctuation, fuzzy match against known commands
  routeCommand(transcript: string): { matched: boolean; command?: string } {
    // Strip all punctuation, normalize whitespace
    const cleaned = transcript
      .toLowerCase()
      .replace(/[.,!?;:'"()\[\]{}\-—]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return { matched: false };

    // Try fuzzy match
    const matched = this.findCommand(cleaned);
    if (matched) {
      matched.action();
      return { matched: true, command: matched.id };
    }

    return { matched: false };
  }

  private findCommand(text: string): VoiceCommand | undefined {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

    // Score each command by how well its aliases match
    let bestMatch: VoiceCommand | undefined;
    let bestScore = 0;

    for (const cmd of this.commands) {
      for (const alias of cmd.aliases) {
        const aliasNorm = alias.toLowerCase();

        // Exact match
        if (normalized === aliasNorm) return cmd;

        // Starts-with match (e.g. "split vertical" matches "split vertical pane")
        if (normalized.startsWith(aliasNorm) || aliasNorm.startsWith(normalized)) {
          const score = Math.min(normalized.length, aliasNorm.length) / Math.max(normalized.length, aliasNorm.length);
          if (score > bestScore && score > 0.6) {
            bestScore = score;
            bestMatch = cmd;
          }
        }

        // Word overlap match
        const normWords = new Set(normalized.split(' '));
        const aliasWords = alias.toLowerCase().split(' ');
        const overlap = aliasWords.filter((w) => normWords.has(w)).length;
        const score = overlap / aliasWords.length;
        if (score > bestScore && score >= 0.8) {
          bestScore = score;
          bestMatch = cmd;
        }
      }
    }

    return bestMatch;
  }

  private findExactCommand(text: string): VoiceCommand | undefined {
    const normalized = text.replace(/\s+/g, ' ').trim();
    for (const cmd of this.commands) {
      for (const alias of cmd.aliases) {
        if (normalized === alias.toLowerCase()) return cmd;
      }
    }
    return undefined;
  }
}

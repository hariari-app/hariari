import { describe, it, expect } from 'vitest';
import { detectNeedsInput, OutputBuffer } from '../../src/main/agent/input-detector';

describe('detectNeedsInput', () => {
  describe('detects yes/no prompts', () => {
    it('detects [Y/n]', () => {
      expect(detectNeedsInput('Do you want to continue? [Y/n]')).toBe(true);
    });

    it('detects [y/N]', () => {
      expect(detectNeedsInput('Overwrite file? [y/N]')).toBe(true);
    });

    it('detects (y/n)', () => {
      expect(detectNeedsInput('Are you sure? (y/n)')).toBe(true);
    });

    it('detects (yes/no)', () => {
      expect(detectNeedsInput('Continue with this action? (yes/no)')).toBe(true);
    });
  });

  describe('detects proceed/continue prompts', () => {
    it('detects proceed?', () => {
      expect(detectNeedsInput('Do you want to proceed?')).toBe(true);
    });

    it('detects continue?', () => {
      expect(detectNeedsInput('Would you like to continue?')).toBe(true);
    });

    it('detects confirm?', () => {
      expect(detectNeedsInput('Please confirm?')).toBe(true);
    });
  });

  describe('detects common tool prompts', () => {
    it('detects npm "Ok to proceed"', () => {
      expect(detectNeedsInput('Ok to proceed? (y)')).toBe(true);
    });

    it('detects npm "Is this OK"', () => {
      expect(detectNeedsInput('Is this OK? (yes)')).toBe(true);
    });

    it('detects "press enter"', () => {
      expect(detectNeedsInput('Press enter to continue')).toBe(true);
    });

    it('detects password prompt', () => {
      expect(detectNeedsInput('Password:')).toBe(true);
    });

    it('detects "Enter" prompt', () => {
      expect(detectNeedsInput('Enter your name:')).toBe(true);
    });
  });

  describe('detects Claude Code prompts', () => {
    it('detects "Do you want to proceed"', () => {
      expect(detectNeedsInput('Do you want to proceed with these changes?', 'claude')).toBe(true);
    });

    it('detects "Approve"', () => {
      expect(detectNeedsInput('Approve this edit?', 'claude')).toBe(true);
    });

    it('detects "Allow"', () => {
      expect(detectNeedsInput('Allow this tool use?', 'claude')).toBe(true);
    });

    it('detects "(y)es / (n)o" pattern', () => {
      expect(detectNeedsInput('(y)es / (n)o', 'claude')).toBe(true);
    });

    it('detects "wants to use Bash" multi-line', () => {
      expect(detectNeedsInput('Some output\nClaude wants to use Bash\nAllow? (y/n)', 'claude')).toBe(true);
    });

    it('detects Deny/Allow pattern', () => {
      expect(detectNeedsInput('Deny  Allow', 'claude')).toBe(true);
    });

    it('detects "(a)lways / (y)es / (n)o"', () => {
      expect(detectNeedsInput('(a)lways / (y)es / (n)o', 'claude')).toBe(true);
    });

    it('detects Claude menu-style approval prompt', () => {
      const output = `This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for: xdg-open:*
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain`;
      expect(detectNeedsInput(output, 'claude')).toBe(true);
    });

    it('detects "This command requires approval"', () => {
      expect(detectNeedsInput('This command requires approval', 'claude')).toBe(true);
    });
  });

  describe('detects Gemini CLI prompts', () => {
    it('detects "Shall I" prompt', () => {
      expect(detectNeedsInput('Shall I apply these changes?', 'gemini')).toBe(true);
    });

    it('detects "Execute" prompt', () => {
      expect(detectNeedsInput('Execute this command?', 'gemini')).toBe(true);
    });

    it('detects "Accept suggestion" prompt', () => {
      expect(detectNeedsInput('Accept this suggestion?', 'gemini')).toBe(true);
    });
  });

  describe('detects Codex prompts', () => {
    it('detects approve/deny pattern', () => {
      expect(detectNeedsInput('approve or deny', 'codex')).toBe(true);
    });

    it('detects "Run command" prompt', () => {
      expect(detectNeedsInput('Run this command?', 'codex')).toBe(true);
    });

    it('detects "[approve]" pattern', () => {
      expect(detectNeedsInput('[approve]', 'codex')).toBe(true);
    });
  });

  describe('does not false-positive', () => {
    it('ignores normal output', () => {
      expect(detectNeedsInput('Compiling src/main.ts...')).toBe(false);
    });

    it('ignores empty string', () => {
      expect(detectNeedsInput('')).toBe(false);
    });

    it('ignores progress indicators', () => {
      expect(detectNeedsInput('50% complete...')).toBe(false);
    });

    it('ignores building output', () => {
      expect(detectNeedsInput('Building project...')).toBe(false);
    });

    it('ignores multi-line with question in middle', () => {
      expect(detectNeedsInput('question?\nNow doing something else')).toBe(false);
    });
  });

  describe('handles ANSI escape sequences', () => {
    it('strips ANSI codes before matching', () => {
      expect(detectNeedsInput('\x1b[33mContinue?\x1b[0m')).toBe(true);
    });

    it('handles colored prompts', () => {
      expect(detectNeedsInput('\x1b[1m\x1b[32m? \x1b[0mDo you want to proceed?')).toBe(true);
    });
  });

  describe('uses last line', () => {
    it('matches on the last non-empty line', () => {
      const output = 'Some output\nMore output\nProceed? [Y/n]\n';
      expect(detectNeedsInput(output)).toBe(true);
    });

    it('does not match when prompt is far above current output', () => {
      // If the prompt is buried under 15+ lines of new output, it's no longer relevant
      const output = 'Proceed? [Y/n]\n' + Array(15).fill('Building modules...').join('\n');
      expect(detectNeedsInput(output)).toBe(false);
    });
  });
});

describe('OutputBuffer', () => {
  it('appends and retrieves data', () => {
    const buf = new OutputBuffer();
    buf.append('hello ');
    buf.append('world');
    expect(buf.getRecent()).toBe('hello world');
  });

  it('truncates to max size', () => {
    const buf = new OutputBuffer(10);
    buf.append('12345678901234567890');
    expect(buf.getRecent()).toBe('1234567890');
    expect(buf.getRecent().length).toBe(10);
  });

  it('clears buffer', () => {
    const buf = new OutputBuffer();
    buf.append('data');
    buf.clear();
    expect(buf.getRecent()).toBe('');
  });

  it('handles multiple appends exceeding max', () => {
    const buf = new OutputBuffer(10);
    buf.append('12345');
    buf.append('67890');
    buf.append('abc');
    expect(buf.getRecent().length).toBe(10);
    expect(buf.getRecent()).toBe('4567890abc');
  });
});

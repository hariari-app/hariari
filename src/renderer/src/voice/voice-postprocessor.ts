// Developer-aware voice post-processor
// Transforms spoken text into code-friendly syntax
// Works with any STT backend (Groq, OpenAI, Queue, local Whisper)

interface TransformRule {
  readonly pattern: RegExp;
  readonly replace: string | ((match: RegExpMatchArray) => string);
}

// Spoken punctuation and symbols
const SYMBOL_RULES: TransformRule[] = [
  { pattern: /\bforward slash\b/gi, replace: '/' },
  { pattern: /\bback slash\b/gi, replace: '\\' },
  { pattern: /\bdot\b/gi, replace: '.' },
  { pattern: /\bperiod\b/gi, replace: '.' },
  { pattern: /\bcomma\b/gi, replace: ',' },
  { pattern: /\bcolon\b/gi, replace: ':' },
  { pattern: /\bsemicolon\b/gi, replace: ';' },
  { pattern: /\bopen paren\b/gi, replace: '(' },
  { pattern: /\bclose paren\b/gi, replace: ')' },
  { pattern: /\bopen bracket\b/gi, replace: '[' },
  { pattern: /\bclose bracket\b/gi, replace: ']' },
  { pattern: /\bopen brace\b/gi, replace: '{' },
  { pattern: /\bclose brace\b/gi, replace: '}' },
  { pattern: /\bequals\b/gi, replace: '=' },
  { pattern: /\bdouble equals\b/gi, replace: '==' },
  { pattern: /\btriple equals\b/gi, replace: '===' },
  { pattern: /\bnot equals?\b/gi, replace: '!=' },
  { pattern: /\bgreater than\b/gi, replace: '>' },
  { pattern: /\bless than\b/gi, replace: '<' },
  { pattern: /\bpipe\b/gi, replace: '|' },
  { pattern: /\bdouble pipe\b/gi, replace: '||' },
  { pattern: /\bdouble ampersand\b/gi, replace: '&&' },
  { pattern: /\bampersand\b/gi, replace: '&' },
  { pattern: /\bat sign\b/gi, replace: '@' },
  { pattern: /\bhash\b/gi, replace: '#' },
  { pattern: /\bdollar sign\b/gi, replace: '$' },
  { pattern: /\bpercent\b/gi, replace: '%' },
  { pattern: /\bcaret\b/gi, replace: '^' },
  { pattern: /\btilde\b/gi, replace: '~' },
  { pattern: /\bbacktick\b/gi, replace: '`' },
  { pattern: /\bsingle quote\b/gi, replace: "'" },
  { pattern: /\bdouble quote\b/gi, replace: '"' },
  { pattern: /\bunderscore\b/gi, replace: '_' },
  { pattern: /\bdash\b/gi, replace: '-' },
  { pattern: /\bhyphen\b/gi, replace: '-' },
  { pattern: /\bplus\b/gi, replace: '+' },
  { pattern: /\basterisk\b/gi, replace: '*' },
  { pattern: /\bstar\b/gi, replace: '*' },
  { pattern: /\barrow\b/gi, replace: '=>' },
  { pattern: /\bnew line\b/gi, replace: '\n' },
  { pattern: /\btab\b/gi, replace: '\t' },
  { pattern: /\bspace\b/gi, replace: ' ' },
];

// Terminal/shell specific
const TERMINAL_RULES: TransformRule[] = [
  { pattern: /\bsudo\b/gi, replace: 'sudo ' },
  { pattern: /\bexit\b/gi, replace: 'exit' },
  { pattern: /\bclear\b/gi, replace: 'clear' },
  { pattern: /\benter\b/gi, replace: '\n' },
  { pattern: /\breturn\b/gi, replace: '\n' },
];

// Case conversion triggers
// "snake case get user ID by name" → get_user_id_by_name
// "camel case get user ID" → getUserId
// "kebab case my component" → my-component
const CASE_RULES: TransformRule[] = [
  {
    pattern: /\bsnake[_ ]?case\s+(.+?)(?=\s*(?:camel|kebab|pascal|snake|$|\.))/gi,
    replace: (_match) => {
      const words = _match[1].trim().toLowerCase().split(/\s+/);
      return words.join('_');
    },
  },
  {
    pattern: /\bcamel[_ ]?case\s+(.+?)(?=\s*(?:camel|kebab|pascal|snake|$|\.))/gi,
    replace: (_match) => {
      const words = _match[1].trim().toLowerCase().split(/\s+/);
      return words
        .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join('');
    },
  },
  {
    pattern: /\bpascal[_ ]?case\s+(.+?)(?=\s*(?:camel|kebab|pascal|snake|$|\.))/gi,
    replace: (_match) => {
      const words = _match[1].trim().toLowerCase().split(/\s+/);
      return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    },
  },
  {
    pattern: /\bkebab[_ ]?case\s+(.+?)(?=\s*(?:camel|kebab|pascal|snake|$|\.))/gi,
    replace: (_match) => {
      const words = _match[1].trim().toLowerCase().split(/\s+/);
      return words.join('-');
    },
  },
];

// Common developer abbreviations
const ABBREVIATION_RULES: TransformRule[] = [
  { pattern: /\bID\b/g, replace: 'id' },
  { pattern: /\bAPI\b/g, replace: 'api' },
  { pattern: /\bURL\b/g, replace: 'url' },
  { pattern: /\bHTTP\b/g, replace: 'http' },
  { pattern: /\bHTTPS\b/g, replace: 'https' },
  { pattern: /\bJSON\b/g, replace: 'json' },
  { pattern: /\bHTML\b/g, replace: 'html' },
  { pattern: /\bCSS\b/g, replace: 'css' },
  { pattern: /\bSQL\b/g, replace: 'sql' },
  { pattern: /\bGIT\b/g, replace: 'git' },
  { pattern: /\bNPM\b/g, replace: 'npm' },
];

export type PostProcessMode = 'natural' | 'command' | 'code';

export function postProcessTranscription(
  text: string,
  mode: PostProcessMode = 'command',
): string {
  if (!text || text.trim().length === 0) return text;

  let result = text.trim();

  if (mode === 'natural') {
    // Natural mode: minimal processing, just clean up
    return result;
  }

  // Apply case conversion rules first (they consume multiple words)
  for (const rule of CASE_RULES) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(result)) !== null) {
      const replacement =
        typeof rule.replace === 'function' ? rule.replace(match) : rule.replace;
      result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
      regex.lastIndex = match.index + replacement.length;
    }
  }

  // Apply symbol rules (all string replacements)
  for (const rule of SYMBOL_RULES) {
    result = result.replace(rule.pattern, rule.replace as string);
  }

  // Apply abbreviation rules in command/code mode
  if (mode === 'command' || mode === 'code') {
    for (const rule of ABBREVIATION_RULES) {
      result = result.replace(rule.pattern, rule.replace as string);
    }
  }

  // Apply terminal rules in command mode
  if (mode === 'command') {
    for (const rule of TERMINAL_RULES) {
      result = result.replace(rule.pattern, rule.replace as string);
    }
  }

  // Collapse spaces around path-like symbols (/ \ ~ .)
  result = result.replace(/\s*([/\\~])\s*/g, '$1');
  // Collapse spaces around brackets/parens/braces
  result = result.replace(/\s*([([{])\s*/g, '$1');
  result = result.replace(/\s*([)\]}])\s*/g, '$1');
  // Collapse spaces around quotes (keep content spaces)
  result = result.replace(/"\s+/g, '"');
  result = result.replace(/\s+"/g, '"');
  // Collapse spaces around underscore
  result = result.replace(/\s*_\s*/g, '_');
  // Consecutive dashes (e.g. "dash dash" → "--") should merge
  result = result.replace(/-\s+-/g, '--');
  // Dot should attach to adjacent words (e.g. "console.log")
  result = result.replace(/\s*\.\s*/g, '.');

  // Clean up extra spaces
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

// Examples for reference/testing:
// "forward slash help" → "/help"
// "snake case get user ID by name" → "get_user_id_by_name"
// "camel case get user name" → "getUserName"
// "git commit dash m double quote initial commit double quote" → "git commit -m "initial commit""
// "cd tilde forward slash projects" → "cd ~/projects"
// "npm install dash dash save dev typescript" → "npm install --save dev typescript"

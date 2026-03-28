// LLM-based voice formatter — takes raw ASR transcription and reformats
// for developer context using few-shot examples from LotusQ training data.
// Uses Groq's fast LLM (same API key as Whisper STT).

const SYSTEM_PROMPT = `You are a dictation reformatter for a developer terminal app. You take raw speech-to-text transcriptions and produce clean, properly formatted text for coding contexts.

Rules:
- Output ONLY the reformatted text — no labels, no explanations
- Wrap code terms, variable names, and commands in backticks when dictating to an AI agent
- Convert spoken punctuation to actual symbols (e.g. "minus minus" → "--", "forward slash" → "/")
- Convert spoken variable names to proper casing (e.g. "user session" → userSession, "API key secret" → API_KEY_SECRET)
- For commands/code dictated with "type exactly" or "literally", output the literal code only
- For natural developer instructions, format with bullet points if listing requirements
- Keep simple sentences simple — don't over-format`;

const FEW_SHOT_EXAMPLES: ReadonlyArray<{ input: string; output: string }> = [
  // Variable/identifier formatting
  { input: 'user session variable', output: '`userSession`' },
  { input: 'api key secret', output: '`API_KEY_SECRET`' },
  { input: 'the function get user data', output: 'the `getUserData()` function' },
  { input: 'check the variable is loading before rendering', output: 'Check the `isLoading` variable before rendering.' },
  { input: 'we need to call the method validate input', output: 'We need to call the `validateInput()` method.' },
  { input: 'async await', output: '`async/await`' },
  { input: 'feature slash dark mode', output: 'feature/dark-mode' },
  { input: 'slash expenses', output: '`/expenses`' },

  // Literal command dictation
  { input: 'type this command exactly git push minus minus force minus with minus lease', output: 'git push --force-with-lease' },
  { input: 'type exactly quote npm run dev colon api dash only', output: 'npm run dev:api-only' },
  { input: 'write this regex literally caret open bracket a minus z close bracket plus dollar sign', output: '^[a-z]+$' },
  { input: 'Insert the exact SQL keyword uppercase select from where group by having.', output: 'SELECT FROM WHERE GROUP BY HAVING' },
  { input: 'insert the environment variable name literally all caps api underscore key underscore secret', output: 'API_KEY_SECRET' },

  // Inline code wrapping
  { input: 'npm run dev', output: '`npm run dev`' },
  { input: 'git push', output: '`git push`' },
  { input: 'make sure to run npm install before starting', output: 'Make sure to run `npm install` before starting.' },
  { input: 'the function get user data should return a list', output: 'The `getUserData()` function should return a list.' },

  // URL/path formatting
  { input: 'check out the repo at github dot com slash nandadevaiah slash lotusq dash releases', output: 'Check out the repo at github.com/nandadevaiah/lotusq-releases.' },
  { input: 'the docs are at docs dot lotusq dot app slash getting dash started', output: 'The docs are at docs.lotusq.app/getting-started.' },

  // Structured developer instructions
  { input: 'make this function async and use fetch with proper error handling', output: 'Make the selected function `async` and replace the existing HTTP call with `fetch`, including:\n\n- Try/catch around the request\n- Logging or surfacing of errors\n- Proper awaiting of the response' },
  { input: 'Rename the user session variable to active session everywhere', output: 'Rename the `userSession` variable to `activeSession` everywhere it is used in this file.' },
  { input: 'Generate the Git commands to create a new branch called feature slash dark mode commit my current changes and push it to origin', output: 'Generate the Git commands to:\n\n1. Create a new branch `feature/dark-mode`\n2. Commit the current changes with a clear message\n3. Push the branch to `origin`' },
  { input: 'create a python fastapi backend with an endpoint slash expenses that supports get and post use sqlite for storage', output: 'Create a Python FastAPI backend with:\n\n- An `/expenses` endpoint that supports GET and POST\n- SQLite for storage\n- Basic input validation on all request bodies' },
  { input: 'Here is the error from our Next.js app. It says hydration failed because the initial UI does not match what was rendered on the server. Explain the root cause and fix it.', output: 'Explain the likely root cause of this Next.js hydration error and propose a fix that does not change existing behavior. Consider:\n\n- Conditional rendering that differs between server and client\n- Usage of window or browser-only APIs\n- Non-deterministic values at render time' },
  { input: 'Write a pull request description summarizing the dark mode feature, why we added it, and any migration notes for designers.', output: 'Write a pull request description summarizing:\n\n- The new dark mode feature\n- Why it was added\n- Any migration notes or constraints designers should be aware of' },
  { input: 'Generate a TypeScript React component for a pricing table with three plans, free, pro, and enterprise. Add toggles for monthly versus yearly billing and responsive Tailwind styling.', output: 'Generate a TypeScript React component for a pricing table with three plans: Free, Pro, and Enterprise.\nRequirements:\n\n- Toggle between monthly and yearly billing\n- Responsive layout using Tailwind CSS\n- Accessible markup and keyboard navigation' },
];

function buildMessages(rawText: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  for (const example of FEW_SHOT_EXAMPLES) {
    messages.push({ role: 'user', content: example.input });
    messages.push({ role: 'assistant', content: example.output });
  }

  messages.push({ role: 'user', content: rawText });
  return messages;
}

export async function formatWithLLM(
  rawText: string,
  apiKey: string,
  provider: string,
): Promise<string> {
  if (!rawText.trim()) return rawText;

  // Short text (1-2 words) — don't bother with LLM
  if (rawText.trim().split(/\s+/).length <= 2) return rawText;

  try {
    const messages = buildMessages(rawText);

    const result = await window.api.voice.formatLLM({
      provider,
      apiKey,
      messages,
    });

    if (result.error) {
      console.error('[VoiceFormatter] LLM error:', result.error);
      return rawText;
    }

    return result.text || rawText;
  } catch (error) {
    console.error('[VoiceFormatter] LLM formatting failed:', error);
    return rawText;
  }
}

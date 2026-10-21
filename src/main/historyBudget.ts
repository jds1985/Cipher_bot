import type { OllamaMessage } from './ollama';

/**
 * History budget: the model only gets the system prompt (job, hints, memory note) plus as many of the most
 * recent turns as fit in a character budget. Without this, long chats overflow the model's context window
 * (Ollama silently drops the oldest tokens, which can include the system prompt; small local models such as
 * Cipher have only 1024 tokens). Characters are a cheap, model-agnostic stand-in for tokens (~4 chars/token).
 */
export const DEFAULT_HISTORY_CHARS = 24_000;
export const MIN_HISTORY_CHARS = 1_000;

/** Budget in characters: CIPHER_HISTORY_CHARS (developer/config override) or the default. */
export function historyBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.CIPHER_HISTORY_CHARS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_HISTORY_CHARS, n) : DEFAULT_HISTORY_CHARS;
}

const size = (m: OllamaMessage): number => m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 16;

/**
 * Keep leading system message(s) always, then the newest messages that fit in `budget` characters.
 * The newest message is always kept (cut to the budget if it alone is too long). The kept history never
 * starts with a tool result whose tool call was dropped.
 */
export function trimHistory(messages: readonly OllamaMessage[], budget = historyBudgetChars()): OllamaMessage[] {
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') i++;
  const system = messages.slice(0, i);
  const rest = messages.slice(i);
  if (!rest.length) return [...system];
  let left = Math.max(MIN_HISTORY_CHARS, budget - system.reduce((n, m) => n + size(m), 0));
  const kept: OllamaMessage[] = [];
  for (let k = rest.length - 1; k >= 0; k--) {
    const s = size(rest[k]);
    if (s > left) {
      if (!kept.length) kept.unshift({ ...rest[k], content: rest[k].content.slice(-(left - 16)) });
      break;
    }
    kept.unshift(rest[k]);
    left -= s;
  }
  while (kept.length > 1 && kept[0].role === 'tool') kept.shift();
  return [...system, ...kept];
}

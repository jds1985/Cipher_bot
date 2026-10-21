import type { ChatMessage } from './backend';

/**
 * Token-based history budget for Cipher's small context (1,024 tokens on the 135M stand-in; set per model in the
 * manifest). The prompt gets the system message plus the newest turns that fit in
 * nCtx − reply tokens − a safety margin. Tokens are estimated on this side (UTF-8 bytes / 3, a deliberate
 * over-estimate for Cipher's 32k BPE, which averages ~4 bytes/token on English) and cipher-serve trims exactly with the
 * real tokenizer as a backstop (oldest turns first, never the system prompt).
 */
export const BYTES_PER_TOKEN = 3;
/** Per-message template overhead (role token + newline / end-of-turn). */
export const MESSAGE_OVERHEAD = 3;
export const SAFETY_MARGIN = 16;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

const size = (m: ChatMessage): number => estimateTokens(m.content) + MESSAGE_OVERHEAD;

/** Tokens left for history once the reply has room. */
export function historyBudgetTokens(nCtx: number, replyTokens: number): number {
  return Math.max(64, nCtx - replyTokens - SAFETY_MARGIN);
}

/**
 * Keep leading system message(s) (cut to half the budget if huge), then the newest messages that fit.
 * The newest message is always kept (its start cut off if it alone is too long). Never starts with a tool result.
 */
export function trimHistory(messages: readonly ChatMessage[], budgetTokens: number): ChatMessage[] {
  let i = 0;
  while (i < messages.length && messages[i].role === 'system') i++;
  let system = messages.slice(0, i);
  const rest = messages.slice(i);
  const sysMax = Math.floor(budgetTokens / 2);
  let sysUsed = system.reduce((n, m) => n + size(m), 0);
  if (sysUsed > sysMax) {
    const keepBytes = (sysMax - MESSAGE_OVERHEAD) * BYTES_PER_TOKEN;
    system = [{ role: 'system', content: system.map((m) => m.content).join('\n\n').slice(0, keepBytes) }];
    sysUsed = size(system[0]);
  }
  if (!rest.length) return [...system];
  let left = budgetTokens - sysUsed;
  const kept: ChatMessage[] = [];
  for (let k = rest.length - 1; k >= 0; k--) {
    const s = size(rest[k]);
    if (s > left) {
      if (!kept.length) {
        const chars = Math.max(0, (left - MESSAGE_OVERHEAD) * BYTES_PER_TOKEN);
        kept.unshift({ ...rest[k], content: rest[k].content.slice(-chars) });
      }
      break;
    }
    kept.unshift(rest[k]);
    left -= s;
  }
  while (kept.length > 1 && kept[0].role === 'tool') kept.shift();
  return [...system, ...kept];
}

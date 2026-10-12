// v1.18: one-time confirmation tokens for web search. Main issues a token only when the user presses Search on the
// confirm card that main itself put up for that exact query in that chat. A token is single-use, bound to the query
// and the chat, and expires. webSearch() consumes it immediately before the request; without it, nothing is sent.
import crypto from 'node:crypto';

export const CONSENT_TTL_MS = 60_000;

interface Grant { chatId: number; query: string; expiresAt: number }

export class SearchConsent {
  private grants = new Map<string, Grant>();
  constructor(private now: () => number = Date.now) {}

  /** Called by main when the user presses Search for this query in this chat. */
  issue(chatId: number, query: string): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.grants.set(token, { chatId, query, expiresAt: this.now() + CONSENT_TTL_MS });
    return token;
  }

  /** True once, for the exact chat and query it was issued for, before it expires. Always removes the token. */
  consume(token: unknown, chatId: number, query: string): boolean {
    if (typeof token !== 'string') return false;
    const g = this.grants.get(token);
    this.grants.delete(token);
    return !!g && g.chatId === chatId && g.query === query && this.now() <= g.expiresAt;
  }

  /** Online off or lock: forget every unused token. */
  revokeAll(): void { this.grants.clear(); }

  get size(): number { return this.grants.size; }
}

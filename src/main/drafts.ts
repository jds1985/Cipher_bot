// v1.25: file drafts. A bot can draft a text file and wait: the draft is kept in main's memory only (never in cipher.db,
// never on disk) until the user presses Save, which runs the v1.22 path: native confirm in main, one-time write token,
// then commitWrite. Discard, lock and quit drop drafts. Same limits as write_file (planWrite: path, size, extension).
import { checkContent, checkRelPath } from './fileWrite';
import { randomBytes } from 'node:crypto';

export const MAX_DRAFTS_PER_CHAT = 5;

export const DRAFT_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'draft_file',
    description:
      'Prepare a text file for the user WITHOUT writing it. The draft waits in the chat until the user chooses to save it ' +
      '(they are then asked to confirm) or discards it. Pass a path relative to the folder and the full text content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the folder (no absolute paths, no "..").' },
        content: { type: 'string', description: 'The complete text of the draft.' },
      },
      required: ['path', 'content'],
    },
  },
} as const;

export interface Draft { id: string; chatId: number; botId: number; path: string; content: string; createdAt: string }

export class DraftStore {
  private drafts = new Map<string, Draft>();
  constructor(private now: () => Date = () => new Date()) {}

  /** Validate (path, size) and keep. Writes nothing. */
  add(chatId: number, botId: number, path: unknown, content: unknown): Draft {
    const parts = checkRelPath(path);
    const text = checkContent(content);
    if (this.list(chatId).length >= MAX_DRAFTS_PER_CHAT) throw new Error(`Up to ${MAX_DRAFTS_PER_CHAT} drafts can wait in one chat. Save or discard one first.`);
    const d: Draft = { id: randomBytes(12).toString('hex'), chatId, botId, path: parts.join('/'), content: text, createdAt: this.now().toISOString() };
    this.drafts.set(d.id, d);
    return d;
  }
  list(chatId: number): Draft[] { return [...this.drafts.values()].filter((d) => d.chatId === chatId); }
  get(id: unknown, chatId: number): Draft | null {
    const d = typeof id === 'string' ? this.drafts.get(id) : undefined;
    return d && d.chatId === chatId ? d : null;
  }
  /** One use: a draft is taken out before it is saved (so a second Save can't write it twice). */
  take(id: unknown, chatId: number): Draft | null { const d = this.get(id, chatId); if (d) this.drafts.delete(d.id); return d; }
  discard(id: unknown, chatId: number): boolean { return !!this.take(id, chatId); }
  clearAll(): void { this.drafts.clear(); }
  get size(): number { return this.drafts.size; }
}

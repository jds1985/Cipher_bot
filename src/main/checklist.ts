// v1.22: the checklist tool. Items live in cipher.db (checklist_items). The user adds, checks and deletes them in
// the app. A bot can only ADD an item, and only after the user presses Add in main's native dialog; main then
// issues a one-time token bound to the chat, the bot and the exact text, and the add consumes it. Nothing in a
// bot's reply can approve it.
import { SearchConsent } from './searchConsent';

export const CHECKLIST_ITEM_MAX = 300;
export const CHECKLIST_MAX_ITEMS = 200;

export const CHECKLIST_TOOL = {
  type: 'function',
  function: {
    name: 'checklist_add',
    description: "Add one item to the user's checklist for this bot. The user is asked first and may decline.",
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The checklist item, short and plain.' } },
      required: ['text'],
    },
  },
} as const;

export function normalizeItem(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Checklist items are text.');
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('The checklist item is empty.');
  if (t.length > CHECKLIST_ITEM_MAX) throw new Error(`Checklist items are up to ${CHECKLIST_ITEM_MAX} characters.`);
  return t;
}

const key = (botId: number, text: string): string => `${botId}\n${text}`;

export interface ChecklistConfirmDeps {
  consent: SearchConsent;
  isLocked: () => boolean;
  ask: (text: { message: string; detail: string; buttons: string[] }) => Promise<number>;
  /** Adds the item; only called through consumeAndAdd. */
  add: (botId: number, text: string) => void;
}

/** Add an item with a live one-time token for this chat, bot and exact text. */
export function consumeAndAdd(d: ChecklistConfirmDeps, token: unknown, chatId: number, botId: number, text: string): void {
  if (!d.consent.consume(token, chatId, key(botId, text))) throw new Error('Not added: the user did not confirm this item.');
  d.add(botId, text);
}

/** The bot's checklist_add call: native confirm, then token, then add. */
export async function confirmChecklistAdd(d: ChecklistConfirmDeps, chatId: number, botId: number, botName: string,
  raw: unknown): Promise<{ ok: boolean; content: string; text: string }> {
  let text = '';
  try {
    if (d.isLocked()) throw new Error('Cipher Bot is locked.');
    text = normalizeItem(raw);
    const answer = await d.ask({ message: `${botName} wants to add a checklist item.`, detail: text, buttons: ['Cancel', 'Add item'] });
    if (d.isLocked()) throw new Error('Cipher Bot is locked.');
    if (answer !== 1) return { ok: false, text, content: 'The user declined: the item was not added. Do not ask again unless they want it.' };
    consumeAndAdd(d, d.consent.issue(chatId, key(botId, text)), chatId, botId, text);
    return { ok: true, text, content: `Added to the checklist: ${text}` };
  } catch (e) {
    return { ok: false, text, content: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

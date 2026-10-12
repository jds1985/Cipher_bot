// v1.24: bot tags (filter the dock) and dock folders (group bots; collapse a group). Local only (cipher.db).
export const TAG_MAX = 5;
export const TAG_LEN = 20;
export const GROUP_LEN = 30;
export const REACTIONS = ['like', 'heart', 'laugh', 'check', 'star'] as const;
export type ReactionId = (typeof REACTIONS)[number];

export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const v = t.replace(/[\u0000-\u001f]/g, '').trim().toLowerCase().slice(0, TAG_LEN);
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length > TAG_MAX) throw new Error(`Up to ${TAG_MAX} tags per Cipher bot.`);
  return out;
}

export function normalizeGroup(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') throw new Error('Invalid folder name.');
  return raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, GROUP_LEN);
}

export const parseReaction = (v: unknown): ReactionId | null => {
  if (v === null || v === '') return null;
  if (!(REACTIONS as readonly unknown[]).includes(v)) throw new Error('Unknown reaction.');
  return v as ReactionId;
};

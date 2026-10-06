// Liz's Cipher bot icon set (v1.4). Each bot gets one automatically when it is created; there is no picker.
// The stored value is only ever one of these keys. The renderer maps a key to its bundled file
// (src/renderer/botIcon.ts); a test keeps both lists and the files in assets/bot-icons/ in sync.

/** The icon keys, in set order (01 hex … 09 pentagon). */
export const BOT_ICONS = ['hex', 'circle', 'square', 'diamond', 'triangle', 'shield', 'octagon', 'capsule', 'pentagon'] as const;

export type BotIcon = (typeof BOT_ICONS)[number];

/** Used for any stored value that isn't a known icon. */
export const DEFAULT_BOT_ICON: BotIcon = BOT_ICONS[0];

export const isBotIcon = (v: unknown): v is BotIcon => typeof v === 'string' && (BOT_ICONS as readonly string[]).includes(v);

/** A known icon key, or the first icon of the set for anything else (null, empty, unknown, tampered). */
export const normalizeBotIcon = (v: unknown): BotIcon => (isBotIcon(v) ? v : DEFAULT_BOT_ICON);

/**
 * The least-used icon among the icons already in use, ties broken in set order, so bots look different.
 * Unknown values in `used` count as the fallback icon, since that's what they show.
 */
export function pickLeastUsedIcon(used: Iterable<unknown>): BotIcon {
  const counts = new Map<BotIcon, number>(BOT_ICONS.map((k) => [k, 0]));
  for (const v of used) {
    const k = normalizeBotIcon(v);
    counts.set(k, counts.get(k)! + 1);
  }
  let best: BotIcon = BOT_ICONS[0];
  for (const k of BOT_ICONS) if (counts.get(k)! < counts.get(best)!) best = k;
  return best;
}

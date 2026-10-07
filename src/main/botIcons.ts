// Liz's Cipher bot icons. v1.5: the user picks a shape (12, from Liz's currentColor SVG set) and a color
// (fixed palette) when creating a bot. Stored values are only ever keys from the lists below; the renderer
// keeps its own copy of both whitelists (src/renderer/botIcon.ts) and a test keeps them in sync.

/** v1.4 icon keys, in set order (01 hex … 09 pentagon). Still used to backfill bots.icon for older databases. */
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

// ---- v1.5: shape + color, picked on create ----

/** Shape keys in Liz's v1.5 set order (01 hex … 12 monitor). The first nine are the v1.4 icons, same names. */
export const BOT_SHAPES = [...BOT_ICONS, 'chip', 'antenna', 'monitor'] as const;
export type BotShape = (typeof BOT_SHAPES)[number];
export const DEFAULT_BOT_SHAPE: BotShape = 'hex';

/** Color keys of the fixed palette (CSS classes .c-<key> in styles.css). blue = #5b8cff is the default. */
export const BOT_COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'coral', 'pink', 'violet'] as const;
export type BotColor = (typeof BOT_COLORS)[number];
export const DEFAULT_BOT_COLOR: BotColor = 'blue';

export const isBotShape = (v: unknown): v is BotShape => typeof v === 'string' && (BOT_SHAPES as readonly string[]).includes(v);
export const isBotColor = (v: unknown): v is BotColor => typeof v === 'string' && (BOT_COLORS as readonly string[]).includes(v);

/** Whitelist: a known shape key, or the default shape for anything else. */
export const normalizeBotShape = (v: unknown): BotShape => (isBotShape(v) ? v : DEFAULT_BOT_SHAPE);
/** Whitelist: a known color key, or the default color (#5b8cff) for anything else. */
export const normalizeBotColor = (v: unknown): BotColor => (isBotColor(v) ? v : DEFAULT_BOT_COLOR);

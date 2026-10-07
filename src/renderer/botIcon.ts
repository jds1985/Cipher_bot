// Bot icon shape/color whitelists for the renderer (pure, no DOM). The values come from the main process
// (already validated there) and are checked against these lists again here; anything unknown falls back to
// the defaults. Shapes map only to the bundled SVG strings in botIconSvgs.ts and colors only to CSS classes,
// so no file path or style is ever built from a stored value.
import { BOT_SHAPE_SVGS } from './botIconSvgs.js';

/** Same keys and order as BOT_SHAPES in src/main/botIcons.ts (kept in sync by a test). */
export const BOT_SHAPES = ['hex', 'circle', 'square', 'diamond', 'triangle', 'shield', 'octagon', 'capsule', 'pentagon', 'chip', 'antenna', 'monitor'] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

/** Same keys and order as BOT_COLORS in src/main/botIcons.ts. Each has a .c-<key> class in styles.css. */
export const BOT_COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'coral', 'pink', 'violet'] as const;
export type BotColor = (typeof BOT_COLORS)[number];

export const DEFAULT_SHAPE: BotShape = 'hex';
export const DEFAULT_COLOR: BotColor = 'blue';

/** Labels for the pickers (accessible names). */
export const SHAPE_LABELS: Record<BotShape, string> = {
  hex: 'Hexagon', circle: 'Circle', square: 'Square', diamond: 'Diamond', triangle: 'Triangle', shield: 'Shield',
  octagon: 'Octagon', capsule: 'Capsule', pentagon: 'Pentagon', chip: 'Chip', antenna: 'Antenna', monitor: 'Monitor',
};
export const COLOR_LABELS: Record<BotColor, string> = {
  blue: 'Blue', cyan: 'Cyan', green: 'Green', yellow: 'Yellow', orange: 'Orange', coral: 'Coral', pink: 'Pink', violet: 'Violet',
};

/** Whitelist: a known shape key, or the default for anything else. */
export const shapeOf = (v: unknown): BotShape => (typeof v === 'string' && (BOT_SHAPES as readonly string[]).includes(v) ? (v as BotShape) : DEFAULT_SHAPE);
/** Whitelist: a known color key, or the default for anything else. */
export const colorOf = (v: unknown): BotColor => (typeof v === 'string' && (BOT_COLORS as readonly string[]).includes(v) ? (v as BotColor) : DEFAULT_COLOR);

/** CSS class that sets the icon color (currentColor) and its glow. */
export const colorClass = (v: unknown): string => `c-${colorOf(v)}`;

/** The bundled SVG markup for a shape (trusted, generated from Liz's files). */
export const shapeSvg = (v: unknown): string => BOT_SHAPE_SVGS[shapeOf(v)];

/** The least-used shape among existing bots (ties in set order): the picker's preselection, so new bots look different. */
export function leastUsedShape(used: Iterable<unknown>): BotShape {
  const counts = new Map<BotShape, number>(BOT_SHAPES.map((k) => [k, 0]));
  for (const v of used) { const k = shapeOf(v); counts.set(k, counts.get(k)! + 1); }
  let best: BotShape = BOT_SHAPES[0];
  for (const k of BOT_SHAPES) if (counts.get(k)! < counts.get(best)!) best = k;
  return best;
}

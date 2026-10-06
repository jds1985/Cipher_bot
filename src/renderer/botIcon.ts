// Bot icon key -> bundled image (pure, no DOM). Only these files can ever be referenced: the key comes from
// the main process (already validated there) and is checked against this whitelist again here.

/** Same keys and order as BOT_ICONS in src/main/botIcons.ts (kept in sync by a test). */
export const BOT_ICON_FILES = {
  hex: 'cipher-bot-01-hex.png',
  circle: 'cipher-bot-02-circle.png',
  square: 'cipher-bot-03-square.png',
  diamond: 'cipher-bot-04-diamond.png',
  triangle: 'cipher-bot-05-triangle.png',
  shield: 'cipher-bot-06-shield.png',
  octagon: 'cipher-bot-07-octagon.png',
  capsule: 'cipher-bot-08-capsule.png',
  pentagon: 'cipher-bot-09-pentagon.png',
} as const;

/** Relative URL of a bot's icon; unknown keys fall back to the first icon of the set. */
export function botIconSrc(icon: unknown): string {
  const file = typeof icon === 'string' && Object.hasOwn(BOT_ICON_FILES, icon)
    ? BOT_ICON_FILES[icon as keyof typeof BOT_ICON_FILES]
    : BOT_ICON_FILES.hex;
  return `assets/bot-icons/${file}`;
}

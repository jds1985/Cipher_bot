// v1.17: small display preferences, stored locally in cipher.db's settings table.
export const UI_PREFS = {
  /** Show the time under each message. On by default. */
  showTimes: { key: 'show_message_times', default: true },
  /** Bot dock collapsed to icons only. Off (expanded) by default. */
  dockCollapsed: { key: 'dock_collapsed', default: false },
  /** v1.22: stop icon animation and the splash fade. Off by default (the system's prefers-reduced-motion also applies). */
  reduceMotion: { key: 'reduce_motion', default: false },
} as const;

/** v1.22: accent colors (Liz's swatches). The stylesheet maps each name to its CSS variables. */
export const ACCENTS = [
  { id: 'blue', label: 'Blue (default)', hex: '#5b8cff' },
  { id: 'teal', label: 'Teal', hex: '#2ec4b6' },
  { id: 'violet', label: 'Violet', hex: '#9b7bff' },
  { id: 'amber', label: 'Amber', hex: '#f5a524' },
  { id: 'rose', label: 'Rose', hex: '#ff6b8a' },
] as const;
export type AccentId = (typeof ACCENTS)[number]['id'];
export const ACCENT_KEY = 'accent';
export const parseAccent = (v: unknown): AccentId => (ACCENTS.find((a) => a.id === v)?.id ?? 'blue');
export type UiPrefName = keyof typeof UI_PREFS;
export type UiPrefs = Record<UiPrefName, boolean>;

export const isUiPrefName = (v: unknown): v is UiPrefName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(UI_PREFS, v);

/** Stored '1'/'0'; absent or anything else means the default. */
export function readUiPrefs(get: (key: string) => string | null): UiPrefs {
  const out = {} as UiPrefs;
  for (const name of Object.keys(UI_PREFS) as UiPrefName[]) {
    const v = get(UI_PREFS[name].key);
    out[name] = v === '1' ? true : v === '0' ? false : UI_PREFS[name].default;
  }
  return out;
}

// v1.17: small display preferences, stored locally in cipher.db's settings table.
export const UI_PREFS = {
  /** Show the time under each message. On by default. */
  showTimes: { key: 'show_message_times', default: true },
  /** Bot dock collapsed to icons only. Off (expanded) by default. */
  dockCollapsed: { key: 'dock_collapsed', default: false },
} as const;
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

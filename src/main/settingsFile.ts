// v1.24: export and import Settings as a small JSON file (Save/Open dialogs in main). ONLY the keys below, each
// validated on import; unknown keys are ignored. Never chats, messages, bots, the lock/passphrase, pairing codes,
// search history, blocked sites or any folder path. Memory notes only when the user ticks the opt-in box.
import { ACCENTS } from './uiPrefs';
import { LOCK_TIMEOUTS } from './lockTimeout';
import { BACKUP_SCHEDULES } from './scheduledBackup';

export const SETTINGS_FILE_MAX = 16 * 1024;
/** 'system' = the desktop's own font (as before); the others are the DejaVu fonts bundled in the app (no web fonts). */
export const FONTS = ['system', 'sans', 'serif', 'mono'] as const;
export type FontId = (typeof FONTS)[number];
export const FONT_KEY = 'font';
export const TPS_KEY = 'show_tps';
export const parseFont = (v: unknown): FontId => ((FONTS as readonly unknown[]).includes(v) ? (v as FontId) : 'system');

const bool = ['0', '1'] as const;
/** Exported key → allowed stored values. */
export const SETTINGS_EXPORT: Record<string, readonly string[]> = {
  accent: ACCENTS.map((a) => a.id),
  font: FONTS,
  show_tps: bool,
  lock_timeout_min: LOCK_TIMEOUTS,
  backup_schedule: BACKUP_SCHEDULES,
  show_message_times: bool,
  dock_collapsed: bool,
  reduce_motion: bool,
  send_sound: bool,
};

export const MEMORY_IMPORT_MAX = 100;

export function buildSettingsExport(get: (key: string) => string | null, version: string,
  memory: { bot: string; note: string }[] | null = null): string {
  const settings: Record<string, string> = {};
  for (const [k, allowed] of Object.entries(SETTINGS_EXPORT)) {
    const v = get(k);
    if (v !== null && allowed.includes(v)) settings[k] = v;
  }
  const file: Record<string, unknown> = { app: 'Cipher Bot', kind: 'settings', version, settings };
  if (memory) file.memory = memory.slice(0, MEMORY_IMPORT_MAX).map((m) => ({ bot: m.bot, note: m.note }));
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Memory notes in an imported file (only used when the user opts in on import too). Bad entries are skipped. */
export function parseMemoryImport(text: unknown, noteMax: number): { bot: string; note: string }[] {
  if (typeof text !== 'string' || text.length > SETTINGS_FILE_MAX) return [];
  try {
    const mem = (JSON.parse(text) as { memory?: unknown }).memory;
    if (!Array.isArray(mem)) return [];
    return mem.slice(0, MEMORY_IMPORT_MAX)
      .filter((m): m is { bot: string; note: string } => !!m && typeof m.bot === 'string' && typeof m.note === 'string' && m.note.trim().length > 0 && m.note.length <= noteMax)
      .map((m) => ({ bot: m.bot, note: m.note }));
  } catch { return []; }
}

export function parseSettingsImport(text: unknown): { key: string; value: string }[] {
  if (typeof text !== 'string' || text.length > SETTINGS_FILE_MAX) throw new Error('That is not a Cipher Bot settings file (too large).');
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error('That is not a Cipher Bot settings file (not JSON).'); }
  const o = obj as { app?: unknown; kind?: unknown; settings?: unknown };
  if (!o || typeof o !== 'object' || o.app !== 'Cipher Bot' || o.kind !== 'settings' || !o.settings || typeof o.settings !== 'object' || Array.isArray(o.settings)) {
    throw new Error('That is not a Cipher Bot settings file.');
  }
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(o.settings as Record<string, unknown>)) {
    const allowed = Object.prototype.hasOwnProperty.call(SETTINGS_EXPORT, k) ? SETTINGS_EXPORT[k] : null;
    if (allowed && typeof v === 'string' && allowed.includes(v)) out.push({ key: k, value: v });
  }
  if (!out.length) throw new Error('No settings in that file could be used.');
  return out;
}

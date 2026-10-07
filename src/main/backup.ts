// Backup and restore (v1.13). Local files only, chosen by the user in the native Save/Open dialogs.
// A backup is a consistent copy of cipher.db (better-sqlite3 backup API). It is not encrypted and contains all
// bots, chats, rooms, routines and settings. It never contains the app lock: that lives in lock.json, not in the DB.
// Restore replaces only the database. lock.json is never touched, and Online is forced off in the restored copy.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from './db';
import { ONLINE_SETTING_KEY, onlineSettingValue } from './networkGuard';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Default backup file name: cipher-backup-YYYY-MM-DD.db (local date). */
export const backupFileName = (d: Date): string => `cipher-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.db`;

/** Suffix for the automatic copy kept before a restore: YYYYMMDD-HHMMSS (local time). */
export const restoreStamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** The tables every Cipher database has (schema v1+). */
export const REQUIRED_TABLES = ['bots', 'chats', 'messages'] as const;

export type BackupCheck =
  | { ok: true; schemaVersion: number; bots: number; rooms: number }
  | { ok: false; error: string };

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Check a file before restoring it: it must be an SQLite database with Cipher's tables and a schema version no
 * newer than this Cipher's (older ones are migrated up after the restore). Opens the file read-only.
 */
export function validateBackupFile(file: string): BackupCheck {
  let header: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, error: 'Could not read that file.' };
  }
  if (!header.equals(SQLITE_HEADER)) return { ok: false, error: 'That file is not a Cipher backup (not an SQLite database).' };
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (!REQUIRED_TABLES.every((t) => tables.has(t))) return { ok: false, error: 'That database is not a Cipher backup (Cipher\'s tables are missing).' };
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 1) return { ok: false, error: 'That database is not a Cipher backup (no Cipher schema version).' };
    if (version > SCHEMA_VERSION) return { ok: false, error: 'That backup is from a newer version of Cipher. Update Cipher first.' };
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, error: 'That backup file is damaged.' };
    const count = (t: string) => (tables.has(t) ? (db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : 0);
    return { ok: true, schemaVersion: version, bots: count('bots'), rooms: count('rooms') };
  } catch {
    return { ok: false, error: 'That file is not a Cipher backup (it could not be opened as a database).' };
  } finally {
    db?.close();
  }
}

/** Settings a restored database may not bring back: Online is forced off; any lock-like row is dropped. */
export function sanitizeRestoredDb(file: string): void {
  const db = new CipherDb(file); // migrates an older backup up to the current schema
  try {
    db.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(false));
  } finally {
    db.close();
  }
  const raw = new Database(file);
  try {
    raw.prepare("DELETE FROM settings WHERE key LIKE '%lock%' OR key LIKE '%passphrase%'").run();
  } finally {
    raw.close();
  }
}

/**
 * Replace the live database with a validated backup. Order:
 * 1) validate the file, 2) copy it next to cipher.db and migrate + sanitize that copy (Online off),
 * 3) save a consistent copy of the current database as cipher.db.before-restore-<stamp>,
 * 4) close the live database and move the prepared copy into place.
 * lock.json is never touched. The caller relaunches Cipher afterwards (the live CipherDb is closed).
 */
export async function restoreDatabase(opts: { live: CipherDb; livePath: string; source: string; now?: Date }): Promise<{ beforeRestorePath: string }> {
  const check = validateBackupFile(opts.source);
  if (!check.ok) throw new Error(check.error);
  if (path.resolve(opts.source) === path.resolve(opts.livePath)) throw new Error('That is Cipher\'s current database.');
  const tmp = `${opts.livePath}.restore-tmp`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(opts.source, tmp);
  try {
    sanitizeRestoredDb(tmp);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const beforeRestorePath = `${opts.livePath}.before-restore-${restoreStamp(opts.now ?? new Date())}`;
  await opts.live.backup(beforeRestorePath);
  opts.live.close();
  for (const f of [`${opts.livePath}-wal`, `${opts.livePath}-shm`, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  fs.renameSync(tmp, opts.livePath);
  return { beforeRestorePath };
}

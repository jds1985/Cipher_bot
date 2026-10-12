// v1.24: scheduled backup, daily or weekly, to ONE local folder the user picked with the native folder dialog in main.
// No network. The file is a consistent SQLite copy (db.backup) named cipher-backup-YYYY-MM-DD.db, written only inside
// that folder (checked: absolute, exists, a directory, not a symlink to elsewhere). Old backups are never deleted.
import fs from 'node:fs/promises';
import path from 'node:path';
import { backupFileName } from './backup';

export const BACKUP_SCHEDULES = ['off', 'daily', 'weekly'] as const;
export type BackupSchedule = (typeof BACKUP_SCHEDULES)[number];
export const BACKUP_SCHEDULE_KEY = 'backup_schedule';
export const BACKUP_FOLDER_KEY = 'backup_folder';
export const BACKUP_LAST_KEY = 'backup_last';
export const BACKUP_CHECK_MS = 10 * 60_000;

export const parseSchedule = (v: unknown): BackupSchedule =>
  (BACKUP_SCHEDULES as readonly unknown[]).includes(v) ? (v as BackupSchedule) : 'off';

const DAY = 24 * 3600_000;
export function isBackupDue(schedule: BackupSchedule, lastIso: string | null, now: Date): boolean {
  if (schedule === 'off') return false;
  const last = lastIso ? Date.parse(lastIso) : NaN;
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= (schedule === 'daily' ? DAY : 7 * DAY) - 60_000;
}

/** The chosen folder, checked: absolute, a real directory (symlinks resolved), or an error. */
export async function checkBackupFolder(folder: unknown): Promise<string> {
  if (typeof folder !== 'string' || !folder || !path.isAbsolute(folder)) throw new Error('Choose a backup folder first.');
  const real = await fs.realpath(folder).catch(() => { throw new Error('The backup folder no longer exists.'); });
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new Error('The backup location is not a folder.');
  return real;
}

/** Write one backup into the folder. `backup` is CipherDb.backup (SQLite online backup to a local path). */
export async function runScheduledBackup(o: { folder: unknown; now: Date; backup: (dest: string) => Promise<unknown> }): Promise<string> {
  const dir = await checkBackupFolder(o.folder);
  const dest = path.join(dir, backupFileName(o.now));
  if (path.dirname(dest) !== dir) throw new Error('Bad backup path.');
  if (await fs.stat(dest).then(() => true, () => false)) throw new Error('A backup with that name already exists.');
  await o.backup(dest);
  return dest;
}

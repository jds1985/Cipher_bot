// v1.23: Settings → Storage. How much disk Cipher Bot's data uses, measured on this computer only.
// Chats: cipher.db (+ its -wal/-shm). Files: the bots' attached folders (walked without following symlinks, capped).
// Backups: Cipher Bot doesn't keep a list of the backups you save (you choose where in the Save dialog), so their
// size is unknown; only the before-restore copies Cipher Bot makes next to cipher.db are counted.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiskUsage } from '../shared/types';

export const WALK_MAX_ENTRIES = 100_000;
export const WALK_MAX_MS = 5_000;

async function sizeOf(p: string): Promise<number> {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

/** Sum of regular files under the given folders (each counted once, symlinks never followed). */
export async function folderBytes(folders: string[], now: () => number = Date.now): Promise<{ bytes: number; capped: boolean }> {
  const seen = new Set<string>();
  const start = now();
  let bytes = 0, entries = 0, capped = false;
  const stack: string[] = [];
  for (const f of folders) {
    try { const real = await fs.realpath(f); if (!seen.has(real)) { seen.add(real); stack.push(real); } } catch { /* gone */ }
  }
  while (stack.length) {
    const dir = stack.pop()!;
    let list: import('node:fs').Dirent[];
    try { list = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of list) {
      if (++entries > WALK_MAX_ENTRIES || now() - start > WALK_MAX_MS) { capped = true; return { bytes, capped }; }
      const p = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { if (!seen.has(p)) { seen.add(p); stack.push(p); } }
      else if (d.isFile()) bytes += await sizeOf(p);
    }
  }
  return { bytes, capped };
}

export async function diskUsage(opts: { dbPath: string; folders: string[] }): Promise<DiskUsage> {
  const chats = (await sizeOf(opts.dbPath)) + (await sizeOf(`${opts.dbPath}-wal`)) + (await sizeOf(`${opts.dbPath}-shm`));
  const unique = [...new Set(opts.folders)];
  const files = unique.length ? await folderBytes(unique) : { bytes: 0, capped: false };
  const dir = path.dirname(opts.dbPath), base = path.basename(opts.dbPath);
  let restoreCopies = 0, n = 0;
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.startsWith(`${base}.before-restore-`)) continue;
      restoreCopies += await sizeOf(path.join(dir, f)); // a copy's -wal/-shm sidecars count toward its size
      if (!/-(wal|shm)$/.test(f)) n++;
    }
  } catch { /* none */ }
  return {
    chats, files: files.bytes, filesCapped: files.capped, folders: unique.length,
    backups: n ? restoreCopies : null,
    backupsNote: n
      ? `${n} before-restore cop${n === 1 ? 'y' : 'ies'} next to cipher.db. Backups you saved yourself are wherever you chose and are not tracked.`
      : 'Backups are saved where you choose in the Save dialog; Cipher Bot does not keep track of them, so their size is not shown.',
  };
}

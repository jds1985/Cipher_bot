import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { backupFileName, restoreDatabase, restoreStamp, validateBackupFile } from '../main/backup';
import { AppLock, LOCK_FILE_NAME, LockStore } from '../main/lock';
import { ONLINE_SETTING_KEY } from '../main/networkGuard';

const PASS = 'backup test passphrase';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-backup-'));
const mk = (db: CipherDb, name: string) => db.createBot({ name, systemPrompt: `${name} job`, toolsEnabled: false, folderPath: null });

function snapshot(db: CipherDb) {
  const bots = db.listBots();
  return {
    bots: bots.map((b) => [b.name, b.systemPrompt, b.shape, b.color]),
    messages: bots.map((b) => db.listMessages(db.getBotChat(b.id).id).map((m) => [m.role, m.content, m.routine])),
    rooms: db.listRooms().map((r) => [r.name, r.memberIds.length, db.listRoomMessages(r.id).map((m) => m.content)]),
    routines: db.listRoutines().map((r) => [r.prompt, r.time, r.enabled]),
  };
}

function seed(file: string) {
  const db = new CipherDb(file);
  const a = mk(db, 'Ada');
  const b = mk(db, 'Bo');
  db.addMessage({ chatId: db.getBotChat(a.id).id, role: 'user', content: 'hello Ada' });
  db.addMessage({ chatId: db.getBotChat(a.id).id, role: 'assistant', content: 'hi there' });
  const room = db.createRoom({ name: 'Team', botIds: [a.id, b.id] });
  db.addRoomMessage({ roomId: room.id, role: 'user', content: 'team hello' });
  db.setRoutine(a.id, { prompt: 'Daily plan', time: '08:30', enabled: true });
  return db;
}

test('backup file name: cipher-backup-YYYY-MM-DD.db; restore stamp is local date-time', () => {
  assert.equal(backupFileName(new Date(2026, 9, 7, 16, 5)), 'cipher-backup-2026-10-07.db');
  assert.equal(restoreStamp(new Date(2026, 9, 7, 16, 5, 9)), '20261007-160509');
});

test('backup round-trip: back up, change things, restore → same data as the backup; a copy of the previous DB is kept', async () => {
  const dir = tmpDir();
  const livePath = path.join(dir, 'cipher.db');
  const live = seed(livePath);
  const before = snapshot(live);
  const backupPath = path.join(dir, 'cipher-backup-2026-10-07.db');
  await live.backup(backupPath);
  assert.deepEqual(validateBackupFile(backupPath), { ok: true, schemaVersion: SCHEMA_VERSION, bots: 2, rooms: 1 });

  // Change the live database after the backup.
  mk(live, 'Cy');
  live.addMessage({ chatId: live.getBotChat(live.listBots()[0].id).id, role: 'user', content: 'after the backup' });
  const changed = snapshot(live);
  assert.notDeepEqual(changed, before);

  const { beforeRestorePath } = await restoreDatabase({ live, livePath, source: backupPath, now: new Date(2026, 9, 7, 16, 30, 0) });
  assert.equal(path.basename(beforeRestorePath), 'cipher.db.before-restore-20261007-163000');
  assert.ok(fs.existsSync(beforeRestorePath), 'pre-restore copy created next to cipher.db');
  assert.ok(!fs.existsSync(`${livePath}.restore-tmp`), 'no temp file left');

  const restored = new CipherDb(livePath);
  assert.deepEqual(snapshot(restored), before, 'restored data equals the backup');
  restored.close();
  const prev = new CipherDb(beforeRestorePath);
  assert.deepEqual(snapshot(prev), changed, 'the pre-restore copy holds what was there before');
  prev.close();
  assert.ok(fs.existsSync(backupPath), 'the backup file itself is untouched');
});

test('backups never contain the lock, and restore never touches lock.json', async () => {
  const dir = tmpDir();
  const livePath = path.join(dir, 'cipher.db');
  const live = seed(livePath);
  await new AppLock(new LockStore(dir)).enable(PASS, PASS);
  const lockFile = path.join(dir, LOCK_FILE_NAME);
  const lockText = fs.readFileSync(lockFile, 'utf8');
  const rec = JSON.parse(lockText) as { salt: string; hash: string };
  const backupPath = path.join(dir, 'b.db');
  await live.backup(backupPath);
  const bytes = fs.readFileSync(backupPath).toString('latin1');
  for (const needle of [rec.salt, rec.hash, 'scrypt', PASS, LOCK_FILE_NAME]) assert.ok(!bytes.includes(needle), `backup has no ${needle.slice(0, 12)}`);
  const settings = new Database(backupPath, { readonly: true }).prepare('SELECT key FROM settings').all() as { key: string }[];
  assert.ok(!settings.some((s) => /lock|pass/i.test(s.key)));

  await restoreDatabase({ live, livePath, source: backupPath });
  assert.equal(fs.readFileSync(lockFile, 'utf8'), lockText, 'lock.json unchanged by restore');
  // Restoring a backup made while the lock was off doesn't turn it off either: the lock follows lock.json only.
  assert.deepEqual(new AppLock(new LockStore(dir)).state(), { enabled: true, locked: true });
});

test('restore forces Online off and drops any lock-like setting from the restored database', async () => {
  const dir = tmpDir();
  const srcPath = path.join(dir, 'other.db');
  const other = seed(srcPath);
  other.setSetting(ONLINE_SETTING_KEY, '1');
  other.setSetting('app_lock_hash', 'something');
  other.close();
  const livePath = path.join(dir, 'cipher.db');
  const live = new CipherDb(livePath);
  await restoreDatabase({ live, livePath, source: srcPath });
  const restored = new CipherDb(livePath);
  assert.equal(restored.getSetting(ONLINE_SETTING_KEY), '0', 'Online is off after restore');
  assert.equal(restored.getSetting('app_lock_hash'), null);
  assert.equal(restored.listBots().length, 2);
  restored.close();
});

test('restore validation: rejects a non-SQLite file, a foreign database, a newer schema, and Cipher\'s own file', async () => {
  const dir = tmpDir();
  const text = path.join(dir, 'notes.db');
  fs.writeFileSync(text, 'just some text, not a database');
  assert.deepEqual(validateBackupFile(text), { ok: false, error: 'That file is not a Cipher backup (not an SQLite database).' });
  assert.equal(validateBackupFile(path.join(dir, 'missing.db')).ok, false);

  const foreign = path.join(dir, 'foreign.db');
  const f = new Database(foreign);
  f.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY, path TEXT)');
  f.pragma('user_version = 3');
  f.close();
  const fr = validateBackupFile(foreign);
  assert.equal(fr.ok, false);
  assert.match(fr.ok ? '' : fr.error, /Cipher's tables are missing/);

  const newer = path.join(dir, 'newer.db');
  seed(newer).close();
  const n = new Database(newer);
  n.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  n.close();
  const nr = validateBackupFile(newer);
  assert.equal(nr.ok, false);
  assert.match(nr.ok ? '' : nr.error, /newer version of Cipher/);

  // A rejected file never replaces anything, and no pre-restore copy is made.
  const livePath = path.join(dir, 'cipher.db');
  const live = seed(livePath);
  for (const bad of [text, foreign, newer, livePath]) await assert.rejects(restoreDatabase({ live, livePath, source: bad }));
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.includes('before-restore')), []);
  assert.equal(live.listBots().length, 2, 'live DB still open and unchanged');
  live.close();
});

test('an older-schema backup is accepted and migrated up on restore', async () => {
  const dir = tmpDir();
  const old = path.join(dir, 'old.db');
  const o = new Database(old);
  o.exec(`CREATE TABLE bots (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '',
      tools_enabled INTEGER NOT NULL DEFAULT 0, folder_path TEXT, created_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE chats (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls TEXT, tool_name TEXT, created_at TEXT NOT NULL DEFAULT 'x');
    INSERT INTO bots (name) VALUES ('Old timer');`);
  o.pragma('user_version = 1');
  o.close();
  assert.deepEqual(validateBackupFile(old), { ok: true, schemaVersion: 1, bots: 1, rooms: 0 });
  const livePath = path.join(dir, 'cipher.db');
  await restoreDatabase({ live: new CipherDb(livePath), livePath, source: old });
  const raw = new Database(livePath, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  raw.close();
  const db = new CipherDb(livePath);
  assert.deepEqual(db.listBots().map((b) => b.name), ['Old timer']);
  db.close();
});

test('main: restore is refused while any reply or routine runs, stops the scheduler, then relaunches', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /if \(activeTurns\.size \|\| activeRooms\.size\) throw new Error\('A reply or routine is still running\. Try again when it has finished\.'\);/);
  assert.match(main, /await restoreDatabase\(\{ live: db, livePath: dbPath\(\), source \}\);/);
  assert.match(main, /app\.relaunch\(\);\s*app\.exit\(0\);/);
  assert.match(main, /defaultPath: path\.join\(app\.getPath\('documents'\), backupFileName\(new Date\(\)\)\)/);
  assert.match(main, /await db\.backup\(r\.filePath\);/);
  // The renderer never sends a path for restore: main keeps the file the user picked in the Open dialog.
  assert.match(main, /handle\('data:restoreConfirm', async \(\) => \{/);
});

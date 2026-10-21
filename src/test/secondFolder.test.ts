import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { executeToolCall, MAX_FILE_BYTES, READ_FILE_TOOL } from '../main/readFileTool';
import { buildHistory } from '../main/chatEngine';
import type { ToolCall } from '../shared/types';

// v1.15: one optional second local folder per bot, separate from the read folder, read through the same sandbox.
interface ViewModule { plusMenuItems: (i: unknown) => { id: string; label: string; disabled: boolean; hint?: string }[] }
interface PolicyModule { POLICY_SECTIONS: readonly { heading: string; paragraphs: readonly string[] }[]; POLICY_CONTACT: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const view = require('../renderer/view.js') as ViewModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const policy = require('../renderer/policy.js') as PolicyModule;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-second-')));
const main = path.join(base, 'main');
const second = path.join(base, 'second');
fs.mkdirSync(main); fs.mkdirSync(path.join(second, 'sub'), { recursive: true });
fs.writeFileSync(path.join(main, 'a.txt'), 'from main');
fs.writeFileSync(path.join(second, 'b.txt'), 'from second');
fs.writeFileSync(path.join(second, 'sub', 'c.md'), '# c');
fs.writeFileSync(path.join(second, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(second, 'link-out'));
const call = (args: Record<string, unknown>): ToolCall => ({ function: { name: 'read_file', arguments: args } }) as ToolCall;
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-second-db-')), 'cipher.db');

test('second folder: read with folder "second"; the read folder stays the default', async () => {
  const r = await executeToolCall(call({ path: 'b.txt', folder: 'second' }), main, second);
  assert.equal(r.ok, true); assert.equal(r.content, 'from second'); assert.equal(r.path, 'second: b.txt');
  assert.equal((await executeToolCall(call({ path: 'sub/c.md', folder: 'second' }), main, second)).content, '# c');
  assert.equal((await executeToolCall(call({ path: 'a.txt' }), main, second)).content, 'from main');
  assert.equal((await executeToolCall(call({ path: 'a.txt', folder: 'main' }), main, second)).content, 'from main');
  // Separate: a file in one folder is not found through the other.
  assert.equal((await executeToolCall(call({ path: 'b.txt' }), main, second)).ok, false);
  assert.equal((await executeToolCall(call({ path: 'a.txt', folder: 'second' }), main, second)).ok, false);
  // No second folder attached: refused.
  const none = await executeToolCall(call({ path: 'b.txt', folder: 'second' }), main, null);
  assert.equal(none.ok, false); assert.match(none.content, /No second folder/);
});

test('second folder: same containment and size limits as the read folder', async () => {
  for (const p of ['../secret.txt', path.join(base, 'secret.txt'), 'link-out', '../main/a.txt', 'big.txt']) {
    const r = await executeToolCall(call({ path: p, folder: 'second' }), main, second);
    assert.equal(r.ok, false, p);
    assert.doesNotMatch(r.content, /TOP SECRET|from main/, p);
  }
  assert.deepEqual(READ_FILE_TOOL.function.parameters.properties.folder.enum, ['main', 'second', 'shared']);
  assert.deepEqual(READ_FILE_TOOL.function.parameters.required, ['path']);
});

test('second folder: stored locally per bot, separate from the read folder, and persists across reopen', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: true, folderPath: null });
  assert.equal(bot.secondFolderPath, null);
  db.setBotFolder(bot.id, main);
  const after = db.setBotSecondFolder(bot.id, second);
  assert.equal(after.folderPath, main); assert.equal(after.secondFolderPath, second);
  db.close();
  db = new CipherDb(file);
  assert.equal(db.getBot(bot.id)!.secondFolderPath, second);
  assert.equal(db.getBot(bot.id)!.folderPath, main);
  const removed = db.setBotSecondFolder(bot.id, null);
  assert.equal(removed.secondFolderPath, null); assert.equal(removed.folderPath, main, 'removing it leaves the read folder');
  db.close();
});

test('migration v5 -> v6 adds second_folder_path, keeps everything else, and is idempotent', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: 'Bo', systemPrompt: 'p', toolsEnabled: true, folderPath: main });
  db.close();
  // Make it a v5 database: no second_folder_path column.
  const raw = new Database(file);
  raw.exec('ALTER TABLE bots DROP COLUMN second_folder_path');
  raw.pragma('user_version = 5');
  raw.close();
  db = new CipherDb(file);
  const b = db.getBot(bot.id)!;
  assert.equal(b.folderPath, main); assert.equal(b.secondFolderPath, null); assert.equal(b.systemPrompt, 'p');
  db.close();
  db = new CipherDb(file); db.close();
  const check = new Database(file, { readonly: true });
  assert.equal(check.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 6);
  const cols = (check.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).map((c) => c.name);
  assert.equal(cols.filter((c) => c === 'second_folder_path').length, 1);
  check.close();
});

test('second folder: plus menu item next to Choose folder, gated by Read files; hint only when attached', () => {
  const items = (toolsEnabled: boolean, secondFolderPath: string | null) =>
    view.plusMenuItems({ kind: 'bot', toolsEnabled, folderPath: main, secondFolderPath, busy: false, routineTime: null });
  const ids = items(true, null).map((i) => i.id);
  assert.equal(ids.indexOf('second'), ids.indexOf('folder') + 1);
  const off = items(false, null).find((i) => i.id === 'second')!;
  assert.equal(off.disabled, true); assert.equal(off.label, 'Attach second folder…');
  const on = items(true, second).find((i) => i.id === 'second')!;
  assert.equal(on.disabled, false); assert.equal(on.label, 'Remove second folder'); assert.equal(on.hint, second);
});

test('second folder: the model is told about it only with Read files on and a folder attached', () => {
  const bot = { id: 1, name: 'x', systemPrompt: '', toolsEnabled: true, folderPath: main, secondFolderPath: second, memoryNote: "", muted: false, archived: false, replyLength: 'normal' as const, unread: false, createdAt: '', shape: 'hex', color: 'blue', drone: { shell: 'plain' as const, palette: 'cipher' as const, eye: 'ring' as const, fins: 'blade' as const, crystal: 'gem' as const, accessories: [] } };
  assert.match(buildHistory(bot, [])[0].content, /folder set to "second"/);
  assert.doesNotMatch(buildHistory({ ...bot, secondFolderPath: null }, [])[0].content, /second/);
  assert.equal(buildHistory({ ...bot, toolsEnabled: false }, []).length, 0);
});

test('policy names the second folder truthfully: on this computer (never uploaded), Read files only, no cloud drive, email or login', () => {
  const files = policy.POLICY_SECTIONS.find((s) => s.heading === 'Files')!.paragraphs.join('\n');
  assert.match(files, /Second folder/);
  assert.match(files, /on this computer and Cipher Bot never uploads or syncs it/);
  assert.match(files, /only when Read files is on/);
  assert.match(files, /not a cloud drive, and there is no email and no login/);
  assert.equal(policy.POLICY_CONTACT, 'Contact: [to be added]');
});

test('no network code added for the second folder', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  for (const f of ['main/readFileTool.ts', 'main/db.ts', 'renderer/view.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /fetch\(|https?:\/\/|net\.|require\('https?'\)/, f);
  }
});

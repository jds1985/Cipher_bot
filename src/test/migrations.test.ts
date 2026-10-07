import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb } from '../main/db';

const tmpDbFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-mig-')), 'cipher.db');

/** A database exactly as v1.4 left it (schema 3): bots with icons, several chats per bot, messages. */
function makeV3Db(file: string): void {
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '',
      tools_enabled INTEGER NOT NULL DEFAULT 0, folder_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), icon TEXT);
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE INDEX chats_bot ON chats(bot_id, updated_at);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')), content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT, tool_name TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO bots (id, name, icon) VALUES (1, 'Ada', 'diamond'), (2, 'Bo', 'octagon'), (3, 'Cy', 'hex');
    -- Ada: three chats; the most recent by activity (updated_at) is chat 2, not the highest id.
    INSERT INTO chats (id, bot_id, title, created_at, updated_at) VALUES
      (1, 1, 'oldest',      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      (2, 1, 'most recent', '2026-01-02T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
      (3, 1, 'middle',      '2026-01-03T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      -- Bo: two chats with the same updated_at: the higher id wins the tie.
      (4, 2, 'bo a', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z'),
      (5, 2, 'bo b', '2026-01-01T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
    -- Cy: no chat at all.
    INSERT INTO messages (chat_id, role, content) VALUES (1, 'user', 'a1'), (1, 'assistant', 'a1r'), (2, 'user', 'a2'),
      (3, 'user', 'a3'), (4, 'user', 'b4'), (5, 'user', 'b5'), (5, 'assistant', 'b5r');
  `);
  raw.pragma('user_version = 3');
  raw.close();
}

const counts = (file: string) => {
  const raw = new Database(file, { readonly: true });
  const n = (t: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const out = { bots: n('bots'), chats: n('chats'), messages: n('messages') };
  raw.close();
  return out;
};

test('one chat per bot: each bot\'s most recent chat becomes its chat; older chats are hidden, nothing is deleted', () => {
  const file = tmpDbFile();
  makeV3Db(file);
  const before = counts(file);
  const db = new CipherDb(file);
  assert.deepEqual(counts(file), before, 'no bots, chats or messages deleted');
  assert.equal(db.getBotChat(1).id, 2, 'Ada: latest activity wins');
  assert.equal(db.getBotChat(2).id, 5, 'Bo: tie on updated_at, higher id wins');
  // The older chats and their messages are still there, just hidden.
  const raw = new Database(file, { readonly: true });
  assert.deepEqual(raw.prepare('SELECT id, hidden FROM chats ORDER BY id').all(),
    [{ id: 1, hidden: 1 }, { id: 2, hidden: 0 }, { id: 3, hidden: 1 }, { id: 4, hidden: 1 }, { id: 5, hidden: 0 }]);
  raw.close();
  assert.deepEqual(db.listMessages(1).map((m) => m.content), ['a1', 'a1r']);
  assert.deepEqual(db.listMessages(2).map((m) => m.content), ['a2']);
  db.close();
});

test('one chat per bot: a bot with no chat gets one lazily on open, and the same one afterwards', () => {
  const file = tmpDbFile();
  makeV3Db(file);
  let db = new CipherDb(file);
  assert.equal(db.listChats(3).length, 0, 'opening the database does not create chats');
  const chat = db.getBotChat(3);
  assert.equal(chat.botId, 3);
  assert.equal(db.getBotChat(3).id, chat.id);
  db.addMessage({ chatId: chat.id, role: 'user', content: 'hello Cy' });
  db.close();
  db = new CipherDb(file);
  assert.equal(db.getBotChat(3).id, chat.id, 'the same chat after reopening');
  assert.equal(db.listChats(3).length, 1);
  assert.throws(() => db.getBotChat(999), /Cipher bot not found/);
  db.close();
});

test('the v4 migration is idempotent: reopening changes nothing and keeps a single visible chat per bot', () => {
  const file = tmpDbFile();
  makeV3Db(file);
  new CipherDb(file).close();
  const snapshot = () => {
    const raw = new Database(file, { readonly: true });
    const s = {
      chats: raw.prepare('SELECT id, bot_id, hidden, updated_at FROM chats ORDER BY id').all(),
      bots: raw.prepare('SELECT id, icon, shape, color FROM bots ORDER BY id').all(),
      version: raw.pragma('user_version', { simple: true }),
      tables: (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name),
    };
    raw.close();
    return s;
  };
  const first = snapshot();
  for (let i = 0; i < 3; i++) new CipherDb(file).close();
  assert.deepEqual(snapshot(), first);
  assert.equal(first.version, 5); // current schema (v5 since v1.9)
  assert.deepEqual(first.bots, [
    { id: 1, icon: 'diamond', shape: 'diamond', color: 'blue' },
    { id: 2, icon: 'octagon', shape: 'octagon', color: 'blue' },
    { id: 3, icon: 'hex', shape: 'hex', color: 'blue' },
  ]);
  for (const t of ['rooms', 'room_members', 'room_messages']) assert.ok(first.tables.includes(t), `${t} table exists`);
  // Chats talked to after the upgrade stay the bot's chat (hidden ones are never brought back).
  const db = new CipherDb(file);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  db.addMessage({ chatId: 2, role: 'user', content: 'still here' });
  db.close();
  const again = new CipherDb(file);
  assert.equal(again.getBotChat(1).id, 2);
  again.close();
});

test('rooms tables: rooms, ordered members and messages persist; creating a room validates its members', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  const [a, b, c] = ['Ada', 'Bo', 'Cy'].map((name) => db.createBot({ name, systemPrompt: '', toolsEnabled: false, folderPath: null }));
  const room = db.createRoom({ name: '  Planning   team ', botIds: [c.id, a.id, b.id, a.id] });
  assert.equal(room.name, 'Planning team');
  assert.deepEqual(room.memberIds, [c.id, a.id, b.id], 'member order kept, duplicates dropped');
  const unnamed = db.createRoom({ botIds: [a.id, b.id] });
  assert.equal(unnamed.name, '');
  db.addRoomMessage({ roomId: room.id, role: 'user', content: 'hi all', botId: a.id });
  db.addRoomMessage({ roomId: room.id, role: 'assistant', botId: c.id, content: 'hi from Cy' });
  db.close();

  db = new CipherDb(file);
  assert.deepEqual(db.listRooms().map((r) => [r.name, r.memberIds]), [['Planning team', [c.id, a.id, b.id]], ['', [a.id, b.id]]]);
  assert.deepEqual(db.listRoomMessages(room.id).map((m) => [m.role, m.botId, m.content]),
    [['user', null, 'hi all'], ['assistant', c.id, 'hi from Cy']], 'user messages never carry a bot id');
  assert.throws(() => db.createRoom({ botIds: [a.id] }), /at least two/);
  assert.throws(() => db.createRoom({ botIds: [a.id, a.id] }), /at least two/);
  assert.throws(() => db.createRoom({ botIds: 'nope' }), /at least two/);
  assert.throws(() => db.createRoom({ botIds: [a.id, 999] }), /Cipher bot not found/);
  assert.throws(() => db.createRoom({ botIds: [a.id, -1] }), /Invalid id/);
  assert.throws(() => db.createRoom({ botIds: [a.id, '2'] }), /Invalid id/);
  assert.throws(() => db.createRoom({ name: 'x'.repeat(81), botIds: [a.id, b.id] }), /80 characters/);
  assert.equal(db.listRooms().length, 2, 'failed creates add nothing');
  db.close();
});

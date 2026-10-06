import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';

function tmpDbFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-db-')), 'cipher.db');
}

test('creates bots, chats and messages and restores them after reopening', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: '  Helper ', systemPrompt: 'Be brief.', toolsEnabled: true, folderPath: '/tmp/x' });
  assert.equal(bot.name, 'Helper');
  assert.equal(bot.toolsEnabled, true);
  const chat = db.createChat(bot.id);
  assert.equal(chat.title, 'New chat');
  db.addMessage({ chatId: chat.id, role: 'user', content: 'What is in notes.txt?' });
  db.addMessage({
    chatId: chat.id, role: 'assistant', content: '',
    toolCalls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }],
  });
  db.addMessage({ chatId: chat.id, role: 'tool', content: 'hello', toolName: 'read_file' });
  db.addMessage({ chatId: chat.id, role: 'assistant', content: 'It says hello.' });
  db.close();

  db = new CipherDb(file);
  const bots = db.listBots();
  assert.equal(bots.length, 1);
  assert.deepEqual(bots[0], bot);
  const chats = db.listChats(bot.id);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].title, 'What is in notes.txt?');
  const msgs = db.listMessages(chat.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(msgs[1].toolCalls, [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }]);
  assert.equal(msgs[2].toolName, 'read_file');
  assert.equal(msgs[3].toolCalls, null);
  db.close();
});

test('validates bot input', () => {
  const db = new CipherDb(tmpDbFile());
  assert.throws(() => db.createBot({ name: '   ', systemPrompt: '', toolsEnabled: false, folderPath: null }), /name is required/);
  assert.throws(() => db.createBot({ name: 'x'.repeat(81), systemPrompt: '', toolsEnabled: false, folderPath: null }), /80 characters/);
  assert.throws(() => db.createChat(999), /Bot not found/);
  db.close();
});

test('updates tools toggle and folder; lists chats newest first', () => {
  const db = new CipherDb(tmpDbFile());
  const bot = db.createBot({ name: 'B', systemPrompt: '', toolsEnabled: false, folderPath: null });
  assert.equal(db.setBotTools(bot.id, true).toolsEnabled, true);
  assert.equal(db.setBotFolder(bot.id, '/data').folderPath, '/data');
  const c1 = db.createChat(bot.id);
  const c2 = db.createChat(bot.id);
  assert.deepEqual(db.listChats(bot.id).map((c) => c.id), [c2.id, c1.id]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // timestamps have ms resolution
  db.addMessage({ chatId: c1.id, role: 'user', content: 'bump' });
  assert.equal(db.listChats(bot.id)[0].id, c1.id);
  db.close();
});

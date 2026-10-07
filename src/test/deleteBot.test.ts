import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-del-')), 'c.db');

test('deleteBot removes bot, cascades chats/messages, and deletes undersized rooms', () => {
  const db = new CipherDb(tmp());
  const a = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Bo', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const c = db.createBot({ name: 'Cy', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(a.id);
  db.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });
  db.addMessage({ chatId: chat.id, role: 'assistant', content: 'hello' });
  // Room of 2: deleting A leaves 1 → room deleted
  const pair = db.createRoom({ name: 'Pair', botIds: [a.id, b.id] });
  // Room of 3: deleting A leaves 2 → room kept without A
  const trio = db.createRoom({ name: 'Trio', botIds: [a.id, b.id, c.id] });
  db.addRoomMessage({ roomId: pair.id, role: 'user', content: 'pair hi' });
  db.addRoomMessage({ roomId: trio.id, role: 'user', content: 'trio hi' });

  const result = db.deleteBot(a.id);
  assert.ok(result.deletedRoomIds.includes(pair.id));
  assert.ok(!result.deletedRoomIds.includes(trio.id));
  assert.equal(db.getBot(a.id), null);
  assert.equal(db.listMessages(chat.id).length, 0, 'chat messages cascaded');
  assert.equal(db.getRoom(pair.id), null, 'undersized room deleted');
  const kept = db.getRoom(trio.id);
  assert.ok(kept);
  assert.deepEqual(kept!.memberIds.sort(), [b.id, c.id].sort());
  assert.equal(db.listBots().length, 2);
  db.close();
});

test('deleteBot on missing id throws; last bot in solo room path', () => {
  const db = new CipherDb(tmp());
  assert.throws(() => db.deleteBot(999), /Cipher bot not found/);
  const a = db.createBot({ name: 'Solo', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Other', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const room = db.createRoom({ name: 'R', botIds: [a.id, b.id] });
  db.deleteBot(a.id);
  assert.equal(db.getRoom(room.id), null);
  db.deleteBot(b.id);
  assert.equal(db.listBots().length, 0);
  db.close();
});

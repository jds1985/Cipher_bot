import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-clear-')), 'c.db');
const mk = (db: CipherDb, name: string) => db.createBot({ name, systemPrompt: `${name} job`, toolsEnabled: false, folderPath: null });

test('clearBotChat deletes only that bot\'s 1:1 chat messages; the bot, other chats, rooms and room messages stay', () => {
  const db = new CipherDb(tmp());
  const a = mk(db, 'A');
  const b = mk(db, 'B');
  const chatA = db.getBotChat(a.id);
  const chatB = db.getBotChat(b.id);
  db.addMessage({ chatId: chatA.id, role: 'user', content: 'hello A' });
  db.addMessage({ chatId: chatA.id, role: 'assistant', content: 'hi from A' });
  db.addMessage({ chatId: chatB.id, role: 'user', content: 'hello B' });
  const room = db.createRoom({ name: 'Team', botIds: [a.id, b.id] });
  db.addRoomMessage({ roomId: room.id, role: 'user', content: 'room hello' });
  db.addRoomMessage({ roomId: room.id, role: 'assistant', botId: a.id, content: 'A in room' });
  const botBefore = db.getBot(a.id);

  const cleared = db.clearBotChat(a.id);

  assert.equal(cleared.id, chatA.id, 'same chat row (one chat per bot)');
  assert.equal(cleared.title, 'New chat', 'title reset');
  assert.equal(db.listMessages(chatA.id).length, 0, 'A\'s messages gone');
  assert.equal(db.getBotChat(a.id).id, chatA.id);
  assert.deepEqual(db.getBot(a.id), botBefore, 'bot unchanged');
  assert.deepEqual(db.listMessages(chatB.id).map((m) => m.content), ['hello B'], 'other bot untouched');
  assert.deepEqual(db.getRoom(room.id)?.memberIds, [a.id, b.id], 'room membership untouched');
  assert.deepEqual(db.listRoomMessages(room.id).map((m) => m.content), ['room hello', 'A in room'], 'room messages untouched');
  // The chat works again afterwards and gets a fresh title from the next message.
  db.addMessage({ chatId: chatA.id, role: 'user', content: 'fresh start' });
  assert.equal(db.getBotChat(a.id).title, 'fresh start');
  db.close();
});

test('clearBotChat on a bot with no chat yet, and on a missing bot', () => {
  const db = new CipherDb(tmp());
  const a = mk(db, 'A');
  const chat = db.clearBotChat(a.id);
  assert.equal(db.listMessages(chat.id).length, 0);
  assert.equal(db.listChats(a.id).length, 1);
  assert.throws(() => db.clearBotChat(999), /Cipher bot not found/);
  db.close();
});

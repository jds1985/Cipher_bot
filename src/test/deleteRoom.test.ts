import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';
import { assertBotDeletable, assertRoomDeletable, isBotReplying } from '../main/deleteGuard';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-delroom-')), 'c.db');
const mk = (db: CipherDb, name: string) => db.createBot({ name, systemPrompt: '', toolsEnabled: false, folderPath: null });

function seed() {
  const db = new CipherDb(tmp());
  const [a, b, c] = ['Ada', 'Bo', 'Cy'].map((n) => mk(db, n));
  const team = db.createRoom({ name: 'Team', botIds: [a.id, b.id, c.id] });
  const pair = db.createRoom({ name: 'Pair', botIds: [a.id, b.id] });
  db.addRoomMessage({ roomId: team.id, role: 'user', content: 'team hello' });
  db.addRoomMessage({ roomId: team.id, role: 'assistant', botId: a.id, content: 'Ada in team' });
  db.addRoomMessage({ roomId: pair.id, role: 'user', content: 'pair hello' });
  const chatA = db.getBotChat(a.id);
  db.addMessage({ chatId: chatA.id, role: 'user', content: 'Ada 1:1' });
  db.setRoutine(a.id, { prompt: 'Daily', time: '08:00', enabled: true });
  return { db, a, b, c, team, pair, chatA };
}

test('deleteRoom removes only that room and its messages; bots, their chats, routines and other rooms stay', () => {
  const { db, a, b, c, team, pair, chatA } = seed();
  const botsBefore = db.listBots();
  db.deleteRoom(team.id);
  assert.equal(db.getRoom(team.id), null);
  assert.equal(db.listRoomMessages(team.id).length, 0, 'its messages are gone');
  assert.deepEqual(db.listBots(), botsBefore, 'bots untouched');
  assert.deepEqual(db.getRoom(pair.id)?.memberIds, [a.id, b.id], 'other room untouched');
  assert.deepEqual(db.listRoomMessages(pair.id).map((m) => m.content), ['pair hello']);
  assert.deepEqual(db.listMessages(chatA.id).map((m) => m.content), ['Ada 1:1'], '1:1 chat untouched');
  assert.equal(db.getRoutine(a.id)?.prompt, 'Daily', 'routine untouched');
  assert.ok(db.getBot(c.id));
  assert.throws(() => db.deleteRoom(team.id), /Room not found/);
  db.close();
});

test('deleteBot still cascades: its chats and messages, room membership, rooms under 2 members, and its routine', () => {
  const { db, a, b, c, team, pair, chatA } = seed();
  const result = db.deleteBot(a.id);
  assert.deepEqual(result.deletedRoomIds, [pair.id], 'the 2-member room goes');
  assert.equal(db.getBot(a.id), null);
  assert.equal(db.listMessages(chatA.id).length, 0);
  assert.equal(db.getRoutine(a.id), null, 'routine cascaded');
  assert.deepEqual(db.getRoom(team.id)?.memberIds, [b.id, c.id], 'removed from the bigger room');
  assert.deepEqual(db.listRoomMessages(team.id).map((m) => [m.botId, m.content]), [[null, 'team hello'], [null, 'Ada in team']],
    'room history kept; the deleted bot\'s replies lose their bot id (ON DELETE SET NULL)');
  db.close();
});

test('delete is refused while the bot or room is replying (never stopped to make way)', () => {
  const { db, a, b, c, team, chatA } = seed();
  const chatC = db.getBotChat(c.id);
  // Nothing running: allowed.
  assert.equal(isBotReplying(db, a.id, [], []), false);
  assert.doesNotThrow(() => assertBotDeletable(db, a.id, [], []));
  assert.doesNotThrow(() => assertRoomDeletable(team.id, []));
  // Its 1:1 chat is replying (desktop, phone or routine).
  assert.throws(() => assertBotDeletable(db, a.id, [chatA.id], []), /still replying/);
  // Another bot's chat replying doesn't block it.
  assert.doesNotThrow(() => assertBotDeletable(db, a.id, [chatC.id], []));
  // A room it's in is mid-round.
  assert.throws(() => assertBotDeletable(db, b.id, [], [team.id]), /still replying/);
  // The room itself is mid-round.
  assert.throws(() => assertRoomDeletable(team.id, [team.id]), /room is still replying/);
  assert.doesNotThrow(() => assertRoomDeletable(team.id, [team.id + 99]));
  db.close();
});

test('main wires delete through the guards and a native right-click menu with Delete…', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /assertBotDeletable\(db, botId, activeTurns\.keys\(\), activeRooms\.keys\(\)\);\s*return db\.deleteBot\(botId\);/);
  assert.match(main, /assertRoomDeletable\(roomId, activeRooms\.keys\(\)\);\s*db\.deleteRoom\(roomId\);/);
  assert.match(main, /\bhandle\('menu:item'/);
  assert.match(main, /label: kind === 'room' \? 'Delete room…' : 'Delete Cipher bot…'/);
  // The renderer confirms before calling delete.
  const js = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer.ts'), 'utf8');
  assert.match(js, /openConfirm\(\s*`Delete room "\$\{name\}"\?`/);
  assert.match(js, /if \(\(await api\.showItemMenu\(kind\)\) !== 'delete'\) return;\s*if \(kind === 'bot'\) void requestDeleteBot\(id\);\s*else requestDeleteRoom\(id\);/);
});

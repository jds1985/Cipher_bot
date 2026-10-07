import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb } from '../main/db';
import { formToProfile, toNewBot, validateBotProfile } from '../main/createBot';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-edit-')), 'c.db');

test('updateBot changes name, job, shape and color; keeps tools, folder, chat and messages', () => {
  const db = new CipherDb(tmp());
  const bot = db.createBot({ name: 'Old', systemPrompt: 'Old job', toolsEnabled: true, folderPath: '/tmp/f', shape: 'hex', color: 'blue' });
  const chat = db.getBotChat(bot.id);
  db.addMessage({ chatId: chat.id, role: 'user', content: 'hi' });
  const updated = db.updateBot(bot.id, formToProfile({ name: '  New name ', job: '  New job  ', shape: 'chip', color: 'coral' }));
  assert.equal(updated.name, 'New name');
  assert.equal(updated.systemPrompt, 'New job');
  assert.equal(updated.shape, 'chip');
  assert.equal(updated.color, 'coral');
  assert.equal(updated.toolsEnabled, true);
  assert.equal(updated.folderPath, '/tmp/f');
  assert.equal(updated.createdAt, bot.createdAt);
  assert.deepEqual(db.getBot(bot.id), updated, 'stored');
  assert.equal(db.getBotChat(bot.id).id, chat.id, 'same chat');
  assert.equal(db.listMessages(chat.id).length, 1, 'messages kept');
  db.close();
});

test('edit uses the same validation as create (shared validator)', () => {
  const db = new CipherDb(tmp());
  const bot = db.createBot(toNewBot({ name: 'Keep', job: 'j' }));
  const bad: { form: Parameters<typeof formToProfile>[0]; err: RegExp }[] = [
    { form: { name: '   ', job: 'x' }, err: /give your Cipher bot a name/ },
    { form: { name: 'x'.repeat(81), job: 'x' }, err: /80 characters or fewer/ },
    { form: { name: 'ok', job: 'x'.repeat(20001) }, err: /job description is too long/ },
  ];
  for (const { form, err } of bad) {
    assert.throws(() => db.createBot(toNewBot(form)), err, 'create');
    assert.throws(() => db.updateBot(bot.id, formToProfile(form)), err, 'edit');
    assert.throws(() => validateBotProfile(formToProfile(form)), err, 'validator');
  }
  assert.deepEqual(db.getBot(bot.id), bot, 'a rejected edit changes nothing');
  // Unknown shape/color become the defaults on both paths, even when sent straight to the DB.
  const created = db.createBot({ name: 'c', systemPrompt: '', toolsEnabled: false, folderPath: null, shape: '../x', color: 'red;' });
  const edited = db.updateBot(bot.id, { name: 'e', systemPrompt: '', shape: '<svg>', color: '#fff' });
  for (const b of [created, edited]) {
    assert.equal(b.shape, 'hex');
    assert.equal(b.color, 'blue');
  }
  assert.throws(() => db.updateBot(999, formToProfile({ name: 'x', job: '' })), /Cipher bot not found/);
  db.close();
});

test('a bad stored shape/color still reads back as the default after an edit elsewhere', () => {
  const file = tmp();
  let db = new CipherDb(file);
  const bot = db.createBot(toNewBot({ name: 'A', job: '', shape: 'chip', color: 'green' }));
  db.close();
  const raw = new Database(file);
  raw.prepare("UPDATE bots SET shape = 'nope', color = 'url(x)' WHERE id = ?").run(bot.id);
  raw.close();
  db = new CipherDb(file);
  const read = db.getBot(bot.id)!;
  assert.equal(read.shape, 'hex');
  assert.equal(read.color, 'blue');
  db.close();
});

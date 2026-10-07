import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { CipherDb } from '../main/db';
import { runChatTurn } from '../main/chatEngine';
import type { ChatEvent } from '../shared/types';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-routine-')), 'c.db');
const mk = (db: CipherDb, name: string, toolsEnabled = false, folderPath: string | null = null) =>
  db.createBot({ name, systemPrompt: `${name} job`, toolsEnabled, folderPath });

test('migration v4 → v5: adds the routines table and messages.routine; keeps existing data; idempotent', () => {
  const file = tmp();
  const db0 = new CipherDb(file);
  const bot = mk(db0, 'Ada');
  const chat = db0.getBotChat(bot.id);
  db0.addMessage({ chatId: chat.id, role: 'user', content: 'before v5' });
  db0.close();
  // Turn it back into a v4 database (as v1.8 left it).
  let raw = new Database(file);
  raw.exec('DROP TABLE routines; ALTER TABLE messages DROP COLUMN routine;');
  raw.pragma('user_version = 4');
  raw.close();

  const db = new CipherDb(file);
  raw = new Database(file, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 5);
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  assert.ok(tables.includes('routines'));
  const cols = (raw.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('routine'));
  raw.close();
  assert.deepEqual(db.listMessages(chat.id).map((m) => [m.content, m.routine]), [['before v5', false]], 'old messages kept, not routine');
  assert.equal(db.getRoutine(bot.id), null);
  db.setRoutine(bot.id, { prompt: 'Daily', time: '07:15', enabled: true });
  db.close();
  for (let i = 0; i < 2; i++) new CipherDb(file).close();
  const again = new CipherDb(file);
  assert.equal(again.getRoutine(bot.id)?.prompt, 'Daily', 'reopening keeps routines');
  again.close();
});

test('setRoutine: one per bot, validated, replace keeps the last-run date; markRoutineRun records it', () => {
  const db = new CipherDb(tmp());
  const a = mk(db, 'Ada');
  const r = db.setRoutine(a.id, { prompt: '  Plan my day ', time: '08:30', enabled: true });
  assert.deepEqual(r, { botId: a.id, prompt: 'Plan my day', time: '08:30', enabled: true, lastRunDate: null });
  db.markRoutineRun(a.id, '2026-10-07');
  const r2 = db.setRoutine(a.id, { prompt: 'New', time: '18:00', enabled: false });
  assert.deepEqual(r2, { botId: a.id, prompt: 'New', time: '18:00', enabled: false, lastRunDate: '2026-10-07' });
  assert.equal(db.listRoutines().length, 1);
  assert.throws(() => db.setRoutine(a.id, { prompt: '', time: '08:00', enabled: true }), /write the message/);
  assert.throws(() => db.setRoutine(a.id, { prompt: 'x', time: '8am', enabled: true }), /HH:MM/);
  assert.throws(() => db.setRoutine(999, { prompt: 'x', time: '08:00', enabled: true }), /Cipher bot not found/);
  assert.deepEqual(db.getRoutine(a.id), r2, 'rejected saves change nothing');
  db.close();
});

test('deleting a bot deletes its routine; clearing its chat keeps the routine', () => {
  const db = new CipherDb(tmp());
  const a = mk(db, 'Ada');
  const b = mk(db, 'Bo');
  db.setRoutine(a.id, { prompt: 'A daily', time: '08:00', enabled: true });
  db.setRoutine(b.id, { prompt: 'B daily', time: '09:00', enabled: true });
  db.addMessage({ chatId: db.getBotChat(b.id).id, role: 'user', content: 'hi', routine: true });
  db.clearBotChat(b.id);
  assert.equal(db.getRoutine(b.id)?.prompt, 'B daily', 'clear chat keeps the routine');
  db.deleteBot(a.id);
  assert.equal(db.getRoutine(a.id), null, 'routine cascaded with its bot');
  assert.deepEqual(db.listRoutines().map((r) => r.botId), [b.id]);
  db.close();
});

// A tiny fake local model (loopback only) that records requests.
const requests: { tools?: unknown; messages: { role: string; content: string }[] }[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'Here is your plan.' }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
  });
});
const ready = new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
after(() => server.close());

test('a routine turn: message marked as routine, tools off even when the bot has file reading on, reply saved', async () => {
  await ready;
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = new CipherDb(tmp());
  const bot = mk(db, 'Reader', true, fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-folder-')));
  const chat = db.getBotChat(bot.id);
  const events: ChatEvent[] = [];
  await runChatTurn({ db, model: 'tiny', host, emit: (e) => events.push(e), forceToolsOff: true, fromRoutine: true }, chat.id, 'Plan my day', new AbortController().signal);
  const req = requests.at(-1)!;
  assert.equal(req.tools, undefined, 'no tools offered to routine turns');
  assert.doesNotMatch(req.messages[0].content, /read_file/, 'no tool hint in the system prompt');
  assert.deepEqual(db.listMessages(chat.id).map((m) => [m.role, m.content, m.routine]),
    [['user', 'Plan my day', true], ['assistant', 'Here is your plan.', false]]);
  assert.equal(events.at(-1)?.type, 'done');
  // A normal turn is not marked.
  await runChatTurn({ db, model: 'tiny', host, emit: () => {} }, chat.id, 'Thanks', new AbortController().signal);
  assert.equal(db.listMessages(chat.id).find((m) => m.content === 'Thanks')?.routine, false);
  db.close();
});

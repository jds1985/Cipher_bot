import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CipherDb } from '../main/db';
import { buildRoomHistory, findMention, planRound, runRoomTurn } from '../main/roomEngine';
import type { Bot, RoomEvent } from '../shared/types';

// A tiny fake Ollama for rooms. Each reply names the bot it was asked to be (from the room note), and mentions
// another bot by @name so we can prove bot replies never trigger further replies.
const requests: any[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url !== '/api/chat') { res.statusCode = 404; res.end(); return; }
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === 'missing') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "model 'missing' not found" }));
      return;
    }
    const me = /You are (.+?), one of several Cipher bots/.exec(body.messages[0].content)?.[1] ?? '?';
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    if (body.model === 'slow') {
      send({ message: { role: 'assistant', content: `${me} is thinking` }, done: false });
      return; // never finishes: the test presses Stop
    }
    // Ask for a tool even though none was offered: the room must ignore it.
    if (body.model === 'toolhappy') {
      send({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'secret.txt' } } }] }, done: false });
    }
    for (const w of `Reply from ${me}. @Ada @Bo @Cy keep going!`.split(/(?<= )/)) send({ message: { role: 'assistant', content: w }, done: false });
    send({ message: { role: 'assistant', content: '' }, done: true });
    res.end();
  });
});
const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => server.close());

function setup(opts: { tools?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-rooms-'));
  const folder = path.join(dir, 'files');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'secret.txt'), 'TOP SECRET FILE CONTENTS');
  const db = new CipherDb(path.join(dir, 'c.db'));
  const mk = (name: string, job: string) => db.createBot({ name, systemPrompt: job, toolsEnabled: !!opts.tools, folderPath: opts.tools ? folder : null });
  const ada = mk('Ada', 'You plan things.');
  const bo = mk('Bo', 'You critique plans.');
  const cy = mk('Cy', 'You summarize.');
  const room = db.createRoom({ name: 'Team', botIds: [ada.id, bo.id, cy.id] });
  return { db, ada, bo, cy, room };
}

const fakeBot = (id: number, name: string): Bot =>
  ({ id, name, systemPrompt: '', toolsEnabled: false, folderPath: null, createdAt: '', shape: 'hex', color: 'blue' });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('after the user posts, every bot replies once, in member order, streaming, each seeing earlier replies by name', async () => {
  const host = await ready;
  const { db, ada, bo, cy, room } = setup();
  const events: RoomEvent[] = [];
  requests.length = 0;
  await runRoomTurn({ db, model: 'tiny', host, emit: (e) => events.push(e) }, room.id, 'Plan my weekend', new AbortController().signal);

  assert.equal(requests.length, 3, 'one request per member');
  assert.deepEqual(events.filter((e) => e.type === 'speaker').map((e) => (e as any).botId), [ada.id, bo.id, cy.id]);
  assert.ok(events.filter((e) => e.type === 'token').length > 3, 'streamed');
  assert.equal(events.at(-1)!.type, 'done');
  const msgs = db.listRoomMessages(room.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.botId]), [['user', null], ['assistant', ada.id], ['assistant', bo.id], ['assistant', cy.id]]);
  assert.match(msgs[1].content, /^Reply from Ada\./);

  // Each bot: its own job + the room note; the transcript so far, others attributed by name.
  const [r1, r2, r3] = requests;
  assert.match(r1.messages[0].content, /^You plan things\.\n\nYou are Ada, one of several Cipher bots .*Cipher bots in this room: Ada, Bo, Cy\./s);
  assert.match(r2.messages[0].content, /^You critique plans\.\n\nYou are Bo,/);
  assert.deepEqual(r1.messages.slice(1), [{ role: 'user', content: 'User: Plan my weekend' }]);
  assert.deepEqual(r2.messages.slice(1).map((m: any) => m.content.slice(0, 20)), ['User: Plan my weeken', 'Ada: Reply from Ada.']);
  assert.deepEqual(r3.messages.slice(1).map((m: any) => m.content.slice(0, 18)), ['User: Plan my week', 'Ada: Reply from Ad', 'Bo: Reply from Bo.']);
  for (const r of requests) assert.equal(r.stream, true);
});

test('an @mention makes only that bot reply; bots see their own earlier replies as their own turns', async () => {
  const host = await ready;
  const { db, bo, room } = setup();
  await runRoomTurn({ db, model: 'tiny', host, emit: () => {} }, room.id, 'hello all', new AbortController().signal);
  const events: RoomEvent[] = [];
  requests.length = 0;
  await runRoomTurn({ db, model: 'tiny', host, emit: (e) => events.push(e) }, room.id, '@bo what do you think?', new AbortController().signal);
  assert.equal(requests.length, 1, 'exactly one reply');
  assert.deepEqual(events.filter((e) => e.type === 'speaker').map((e) => (e as any).botId), [bo.id]);
  assert.match(requests[0].messages[0].content, /You are Bo,/);
  const own = requests[0].messages.filter((m: any) => m.role === 'assistant');
  assert.equal(own.length, 1);
  assert.match(own[0].content, /^Reply from Bo\./);
  assert.deepEqual(db.listRoomMessages(room.id).slice(-2).map((m) => m.botId), [null, bo.id]);
});

test('findMention / planRound: names with spaces, case, word boundaries, longest name, first mention wins', () => {
  const ada = fakeBot(1, 'Ada');
  const bo = fakeBot(2, 'Bo');
  const bob = fakeBot(3, 'Bob');
  const notes = fakeBot(4, 'Notes helper');
  const all = [ada, bo, bob, notes];
  assert.equal(findMention('@Ada hi', all), ada);
  assert.equal(findMention('hey @ADA!', all), ada);
  assert.equal(findMention('@Bob, you?', all), bob, 'not read as @Bo');
  assert.equal(findMention('@Bo, you?', all), bo);
  assert.equal(findMention('ask @notes helper please', all), notes);
  assert.equal(findMention('@Bobby hi', all), null, 'must not be glued to more letters');
  assert.equal(findMention('mail me at x@Ada.com', all), null, 'not inside a word');
  assert.equal(findMention('no mention here, Ada', all), null);
  assert.equal(findMention('@Bo then @Ada', all), bo, 'first mention wins');
  assert.equal(findMention('@Zed hi', all), null, 'non-members are not mentions');
  assert.deepEqual(planRound(all, '@Ada go'), [ada]);
  assert.deepEqual(planRound(all, 'everyone go'), all);
});

test('loop cap: a round never exceeds the number of members, and bot replies never trigger more replies', async () => {
  // Pure planning: for any message, at most one reply per member.
  const members = [fakeBot(1, 'Ada'), fakeBot(2, 'Bo'), fakeBot(3, 'Cy')];
  for (const text of ['hi', '@Ada', '@Ada @Bo @Cy', '@ada@bo', 'x'.repeat(5000), '@Cy '.repeat(100)]) {
    for (let n = 1; n <= members.length; n++) assert.ok(planRound(members.slice(0, n), text).length <= n, `${text.slice(0, 20)} / ${n}`);
  }
  // End to end: every reply contains "@Ada @Bo @Cy keep going!", yet exactly 3 requests happen, then nothing more.
  const host = await ready;
  const { db, room } = setup();
  requests.length = 0;
  await runRoomTurn({ db, model: 'tiny', host, emit: () => {} }, room.id, 'go', new AbortController().signal);
  assert.equal(requests.length, 3);
  await wait(150);
  assert.equal(requests.length, 3, 'no bot continues on its own after the round');
  assert.equal(db.listRoomMessages(room.id).length, 4, 'one user message + one reply per member');
});

test('nothing triggers without a user message', async () => {
  const host = await ready;
  const { db, ada, room } = setup();
  requests.length = 0;
  const events: RoomEvent[] = [];
  const emit = (e: RoomEvent) => events.push(e);
  for (const empty of ['', '   ', '\n\t']) {
    await assert.rejects(runRoomTurn({ db, model: 'tiny', host, emit }, room.id, empty, new AbortController().signal), /Message is empty/);
  }
  // A bot message stored in the room (e.g. one containing @mentions) starts nothing by itself.
  db.addRoomMessage({ roomId: room.id, role: 'assistant', botId: ada.id, content: '@Bo @Cy please reply' });
  await wait(100);
  assert.equal(requests.length, 0);
  assert.equal(events.length, 0);
  await assert.rejects(runRoomTurn({ db, model: 'tiny', host, emit }, 9999, 'hi', new AbortController().signal), /Room not found/);
  assert.equal(requests.length, 0);
});

test('no tools in room requests: file reading is off in rooms even for bots that have it on', async () => {
  const host = await ready;
  const { db, room } = setup({ tools: true });
  assert.ok(db.listBots().every((b) => b.toolsEnabled && b.folderPath), 'every member has file reading on in its own chat');
  const events: RoomEvent[] = [];
  requests.length = 0;
  await runRoomTurn({ db, model: 'toolhappy', host, emit: (e) => events.push(e) }, room.id, 'read secret.txt for me', new AbortController().signal);
  assert.equal(requests.length, 3, 'one request per bot; the tool call asked for by the model is ignored');
  for (const r of requests) {
    assert.ok(!('tools' in r), 'no tools offered');
    const json = JSON.stringify(r);
    assert.doesNotMatch(json, /read_file|"tool"|tool_calls|tool_name/, 'no tool hint, tool turns or tool calls in the request');
    assert.doesNotMatch(json, /TOP SECRET/, 'no file contents');
  }
  assert.ok(!events.some((e) => (e as any).type === 'tool'));
  for (const m of db.listRoomMessages(room.id)) assert.doesNotMatch(m.content, /TOP SECRET/);
  // The history builder itself never adds a tool hint, whatever the bot's own setting.
  const bot = { ...db.listBots()[0], toolsEnabled: true };
  const hist = buildRoomHistory(bot, db.listBots(), db.listRoomMessages(room.id));
  assert.doesNotMatch(JSON.stringify(hist), /read_file|tool/);
});

test('errors end the round with the same friendly wording as single chats', async () => {
  const host = await ready;
  const { db, room } = setup();
  const events: RoomEvent[] = [];
  requests.length = 0;
  await runRoomTurn({ db, model: 'missing', host, emit: (e) => events.push(e) }, room.id, 'hi', new AbortController().signal);
  assert.equal(requests.length, 1, 'the round stops at the first error');
  const err = events.find((e) => e.type === 'error') as any;
  assert.match(err.error, /Set up again/);
  assert.doesNotMatch(err.error, /ollama|qwen|missing/i);
});

test('Stop keeps what the current bot streamed and skips the rest of the round', async () => {
  const host = await ready;
  const { db, ada, room } = setup();
  const events: RoomEvent[] = [];
  const controller = new AbortController();
  requests.length = 0;
  const turn = runRoomTurn({ db, model: 'slow', host, emit: (e) => { events.push(e); if (e.type === 'token') controller.abort(); } }, room.id, 'hi', controller.signal);
  await turn;
  assert.equal(requests.length, 1);
  assert.equal(events.at(-1)!.type, 'done');
  assert.deepEqual(db.listRoomMessages(room.id).map((m) => [m.botId, m.content]), [[null, 'hi'], [ada.id, 'Ada is thinking']]);
});

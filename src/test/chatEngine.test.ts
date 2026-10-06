import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CipherDb } from '../main/db';
import { runChatTurn } from '../main/chatEngine';
import { getStatus } from '../main/ollama';
import type { ChatEvent } from '../shared/types';

// A tiny fake Ollama: streams NDJSON like the real /api/chat.
const requests: any[] = [];
let tagsModels = [{ name: 'tiny:latest', model: 'tiny:latest' }];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: tagsModels }));
      return;
    }
    if (req.url !== '/api/chat') { res.statusCode = 404; res.end(); return; }
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === 'garbage') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Par' }, done: false }) + '\n');
      res.end('this is not json\n');
      return;
    }
    if (body.model === 'missing') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "model 'missing' not found" }));
      return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    const last = body.messages[body.messages.length - 1];
    if (body.tools && last.role === 'user') {
      // Ask for the file, split across a chunk boundary to test line buffering.
      const line = JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] }, done: false }) + '\n';
      res.write(line.slice(0, 20));
      setTimeout(() => {
        res.write(line.slice(20));
        send({ message: { role: 'assistant', content: '' }, done: true });
        res.end();
      }, 10);
      return;
    }
    const reply = last.role === 'tool' ? `File says: ${last.content.trim()}` : 'Hi there!';
    for (const word of reply.split(/(?<= )/)) send({ message: { role: 'assistant', content: word }, done: false });
    send({ message: { role: 'assistant', content: '' }, done: true });
    res.end();
  });
});
const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => server.close());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-engine-'));
  const folder = path.join(dir, 'files');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'buy milk\n');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  return { db: new CipherDb(path.join(dir, 'c.db')), folder };
}

test('streams a plain reply and stores it (tools off)', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'Plain', systemPrompt: 'Be nice.', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  requests.length = 0;
  await runChatTurn({ db, model: 'tiny', host, emit: (e) => events.push(e) }, chat.id, 'hello', new AbortController().signal);
  const tokens = events.filter((e) => e.type === 'token').map((e) => (e as any).text);
  assert.ok(tokens.length > 1, 'streamed in several chunks');
  assert.equal(tokens.join(''), 'Hi there!');
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(requests[0].tools, undefined, 'no tools sent when tools are off');
  assert.deepEqual(requests[0].messages[0], { role: 'system', content: 'Be nice.' });
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].keep_alive, '30m', 'keeps the model loaded between messages');
  assert.deepEqual(db.listMessages(chat.id).map((m) => [m.role, m.content]), [['user', 'hello'], ['assistant', 'Hi there!']]);
});

test('runs read_file when the model asks, feeds the result back and continues', async () => {
  const host = await ready;
  const { db, folder } = setup();
  const bot = db.createBot({ name: 'Files', systemPrompt: '', toolsEnabled: true, folderPath: folder });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  requests.length = 0;
  await runChatTurn({ db, model: 'tiny', host, emit: (e) => events.push(e) }, chat.id, 'what is in notes.txt?', new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, 'read_file');
  const toolMsg = requests[1].messages.at(-1);
  assert.deepEqual(toolMsg, { role: 'tool', content: 'buy milk\n', tool_name: 'read_file' });
  const toolEvent = events.find((e) => e.type === 'tool') as any;
  assert.equal(toolEvent.ok, true);
  assert.equal(toolEvent.path, 'notes.txt');
  const msgs = db.listMessages(chat.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[1].toolCalls![0].function.name, 'read_file');
  assert.equal(msgs[3].content, 'File says: buy milk');
  assert.equal(events.at(-1)!.type, 'done');
});

test('reports a missing model in plain words that point to "Set up again"', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'X', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  await runChatTurn({ db, model: 'missing', host, emit: (e) => events.push(e) }, chat.id, 'hi', new AbortController().signal);
  const err = events.find((e) => e.type === 'error') as any;
  assert.match(err.error, /Set up again/);
  assert.doesNotMatch(err.error, /ollama|qwen|missing/i);
});

test('getStatus: running + present, model missing, and not running', async () => {
  const host = await ready;
  tagsModels = [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }, { name: 'tiny:latest', model: 'tiny:latest' }];
  assert.equal((await getStatus('qwen2.5:7b', host)).modelPresent, true);
  assert.equal((await getStatus('tiny', host)).modelPresent, true);
  const missing = await getStatus('llama3.1:8b', host);
  assert.equal(missing.running, true);
  assert.equal(missing.modelPresent, false);
  assert.equal(missing.action, 'setup');
  assert.match(missing.problem!, /Set up again/);
  const down = await getStatus('qwen2.5:7b', 'http://127.0.0.1:9');
  assert.equal(down.running, false);
  assert.equal(down.action, 'get-engine');
  assert.equal(down.problem, "Cipher's model engine isn't running. Install it from the setup page, then reopen Cipher.");
});

test('a malformed stream line ends the turn with a friendly error', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'G', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  await runChatTurn({ db, model: 'garbage', host, emit: (e) => events.push(e) }, chat.id, 'hi', new AbortController().signal);
  const err = events.find((e) => e.type === 'error') as any;
  assert.match(err.error, /garbled reply\. Please try again/);
  assert.doesNotMatch(err.error, /Unexpected token|is not valid JSON/);
  assert.equal(requests.at(-1).keep_alive, '30m');
});

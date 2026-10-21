import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CipherDb } from '../main/db';
import { buildHistory, runChatTurn } from '../main/chatEngine';
import { getStatus, streamChat } from '../main/backend';
import type { ChatEvent } from '../shared/types';
import { CHAT_PATH, NO_TOOLS_MODEL, TEST_MODEL, endpointFor, sseChunk, sseDone } from './fakeCipher';

// A tiny fake cipher-serve: streams OpenAI-style SSE like the real /v1/chat/completions.
// The last user message picks the mode: "garbage" (bad data), "fail" (HTTP 500), otherwise a normal reply.
const requests: any[] = [];
const auths: (string | undefined)[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    auths.push(req.headers.authorization);
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', model: 'cipher-test', n_ctx: 1024 }));
      return;
    }
    if (req.url !== CHAT_PATH) { res.statusCode = 404; res.end(); return; }
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages[body.messages.length - 1];
    res.setHeader('Content-Type', 'text/event-stream');
    if (last.content === 'garbage') { res.write(sseChunk({ content: 'Par' })); res.end('data: this is not json\n\n'); return; }
    if (last.content === 'fail') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'boom' } })); return; }
    if (body.tools?.some((t: any) => t.function?.name === 'read_file') && last.role === 'user') {
      // Ask for the file, split across a chunk boundary to test SSE buffering.
      const evt = sseChunk({ tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] });
      res.write(evt.slice(0, 20));
      setTimeout(() => { res.write(evt.slice(20)); res.end(sseDone('tool_calls')); }, 10);
      return;
    }
    const reply = last.role === 'tool' ? `File says: ${last.content.trim()}` : 'Hi there!';
    for (const word of reply.split(/(?<= )/)) res.write(sseChunk({ content: word }));
    res.end(sseDone());
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
const deps = (host: string, model = TEST_MODEL) => ({ model, endpoint: () => endpointFor(host) });

test('streams a plain reply and stores it (tools off); sends the bearer token, sampling and reply cap', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'Plain', systemPrompt: 'Be nice.', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  requests.length = 0;
  auths.length = 0;
  await runChatTurn({ db, ...deps(host), emit: (e) => events.push(e) }, chat.id, 'hello', new AbortController().signal);
  const tokens = events.filter((e) => e.type === 'token').map((e) => (e as any).text);
  assert.ok(tokens.length > 1, 'streamed in several chunks');
  assert.equal(tokens.join(''), 'Hi there!');
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(requests[0].tools, undefined, 'no tools at all: files off, and the v1.23 switches for the rest are off by default');
  assert.deepEqual(requests[0].messages[0], { role: 'system', content: 'You are Cipher, a helpful AI assistant.\n\nYour name is Plain.\n\nBe nice.' });
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].max_tokens, 300);
  assert.equal(requests[0].temperature, 0.7);
  assert.equal(requests[0].top_p, 0.9);
  assert.equal(requests[0].repetition_penalty, 1.2);
  assert.equal(auths[0], 'Bearer test-token');
  assert.deepEqual(db.listMessages(chat.id).map((m) => [m.role, m.content]), [['user', 'hello'], ['assistant', 'Hi there!']]);
});

test('runs read_file when a tool-capable model asks, feeds the result back and continues', async () => {
  const host = await ready;
  const { db, folder } = setup();
  const bot = db.createBot({ name: 'Files', systemPrompt: '', toolsEnabled: true, folderPath: folder });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  requests.length = 0;
  await runChatTurn({ db, ...deps(host), emit: (e) => events.push(e) }, chat.id, 'what is in notes.txt?', new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, 'read_file');
  const toolMsg = requests[1].messages.at(-1);
  assert.deepEqual(toolMsg, { role: 'tool', content: 'buy milk\n', name: 'read_file' });
  const toolEvent = events.find((e) => e.type === 'tool') as any;
  assert.equal(toolEvent.ok, true);
  assert.equal(toolEvent.path, 'notes.txt');
  const msgs = db.listMessages(chat.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[1].toolCalls![0].function.name, 'read_file');
  assert.equal(msgs[3].content, 'File says: buy milk');
  assert.equal(events.at(-1)!.type, 'done');
});

test('the 135M profile (toolCalling false): no tools and no tool hints are sent, even with every switch on', async () => {
  const host = await ready;
  const { db, folder } = setup();
  const bot = db.createBot({ name: 'Files', systemPrompt: 'Help.', toolsEnabled: true, folderPath: folder });
  db.setToolSwitches(bot.id, { files: true, search: true, calculator: true, checklist: true, write: true });
  const chat = db.createChat(bot.id);
  requests.length = 0;
  const events: ChatEvent[] = [];
  await runChatTurn({ db, ...deps(host, NO_TOOLS_MODEL), emit: (e) => events.push(e) }, chat.id, 'what is in notes.txt?', new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined);
  assert.doesNotMatch(requests[0].messages[0].content, /read_file|web_search|write_file|checklist_add/);
  assert.equal(events.filter((e) => e.type === 'tool').length, 0);
});

test('server errors and a server that is not up yet are plain, model-free wording', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'X', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  await runChatTurn({ db, ...deps(host), emit: (e) => events.push(e) }, chat.id, 'fail', new AbortController().signal);
  const err = events.find((e) => e.type === 'error') as any;
  assert.match(err.error, /Please try again/);
  assert.doesNotMatch(err.error, /ollama|qwen|boom|500/i);
  const ev2: ChatEvent[] = [];
  await runChatTurn({ db, model: TEST_MODEL, endpoint: () => null, emit: (e) => ev2.push(e) }, chat.id, 'hi', new AbortController().signal);
  assert.match((ev2.find((e) => e.type === 'error') as any).error, /still starting/);
});

test('getStatus: healthy, and not running', async () => {
  const host = await ready;
  const ok = await getStatus(endpointFor(host));
  assert.deepEqual(ok, { running: true, model: 'cipher-test', nCtx: 1024, problem: null });
  const down = await getStatus(endpointFor('http://127.0.0.1:9'));
  assert.equal(down.running, false);
  assert.match(down.problem!, /stopped unexpectedly/);
  assert.equal((await getStatus(null)).running, false);
});

test('a malformed stream event ends the turn with a friendly error', async () => {
  const host = await ready;
  const { db } = setup();
  const bot = db.createBot({ name: 'G', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.createChat(bot.id);
  const events: ChatEvent[] = [];
  await runChatTurn({ db, ...deps(host), emit: (e) => events.push(e) }, chat.id, 'garbage', new AbortController().signal);
  const err = events.find((e) => e.type === 'error') as any;
  assert.match(err.error, /garbled reply\. Please try again/);
  assert.doesNotMatch(err.error, /Unexpected token|is not valid JSON/);
});

test('streamChat merges OpenAI tool_call argument fragments by index and returns usage stats', async () => {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'calc', arguments: '{"expr' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"2+2"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 5 }, cipher: { ttft_ms: 20, gen_tok_s: 250, dropped_messages: 2 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const r = await streamChat({ endpoint: endpointFor(), messages: [{ role: 'user', content: 'x' }], onToken: () => {}, fetchImpl: async () => new Response(body) });
  assert.deepEqual(r.toolCalls, [{ function: { name: 'calc', arguments: { expression: '2+2' } } }]);
  assert.equal(r.finishReason, 'tool_calls');
  assert.deepEqual(r.stats, { promptTokens: 12, completionTokens: 5, ttftMs: 20, genTokS: 250, droppedMessages: 2 });
});

test('buildHistory: short system prompt (model line + name + job), token budget keeps the newest turns', () => {
  const bot = { id: 1, name: 'Ada', systemPrompt: 'Plan trips.', toolsEnabled: false, folderPath: null, replyLength: 'normal' } as any;
  const long = 'word '.repeat(400);
  const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i} ${long}` })) as any;
  const h = buildHistory(bot, msgs, NO_TOOLS_MODEL);
  assert.equal(h[0].role, 'system');
  assert.ok(h[0].content.length < 120, 'short system prompt');
  assert.ok(h.length < 13, 'old turns dropped');
  assert.match(h.at(-1)!.content, /^11 /, 'newest kept');
  const est = h.reduce((n, m) => n + Math.ceil(Buffer.byteLength(m.content) / 3) + 3, 0);
  assert.ok(est <= 1024 - 300 - 16, `fits 1024 − 300 reply − margin (est ${est})`);
});

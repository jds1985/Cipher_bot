import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BAD_STREAM_MESSAGE, configuredModel, DEFAULT_MODEL, KEEP_ALIVE, OFFERED_MODELS, parseStreamLine,
  PullProgressTracker, pullModel, streamChat, warmUp,
} from '../main/ollama';

// Fake Ollama for /api/pull, /api/chat (bad line) and warm-up requests.
const bodies: { url: string; body: any }[] = [];
let releaseSlowPull: (() => void) | null = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    bodies.push({ url: req.url!, body });
    const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    if (req.url === '/api/pull') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      if (body.model === 'offline') {
        send({ status: 'pulling manifest' });
        send({ error: 'pull model manifest: dial tcp: lookup registry.ollama.ai: no such host' });
        res.end();
        return;
      }
      if (body.model === 'slow') {
        send({ status: 'pulling manifest' });
        send({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 10 });
        releaseSlowPull = () => res.end();
        return;
      }
      send({ status: 'pulling manifest' });
      send({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000 });
      send({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 500 });
      // second layer, split across writes
      const l = JSON.stringify({ status: 'pulling bbb', digest: 'sha256:bbb', total: 1000, completed: 250 }) + '\n';
      res.write(l.slice(0, 15));
      setTimeout(() => {
        res.write(l.slice(15));
        send({ status: 'pulling aaa', digest: 'sha256:aaa', total: 1000, completed: 1000 });
        send({ status: 'pulling bbb', digest: 'sha256:bbb', total: 1000, completed: 1000 });
        send({ status: 'verifying sha256 digest' });
        send({ status: 'writing manifest' });
        send({ status: 'success' });
        res.end();
      }, 10);
      return;
    }
    if (req.url === '/api/chat') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      if (body.stream === false) { res.end(JSON.stringify({ done: true })); return; }
      send({ message: { role: 'assistant', content: 'Hel' }, done: false });
      res.write('{"message": {"content": "lo"  <<garbage>>\n');
      send({ message: { role: 'assistant', content: '' }, done: true });
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
});
const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => server.close());

test('offers exactly qwen2.5:3b and qwen2.5:7b', () => {
  assert.deepEqual(OFFERED_MODELS.map((m) => m.name), ['qwen2.5:3b', 'qwen2.5:7b']);
});

test('configuredModel: CIPHER_MODEL env overrides the saved choice, which overrides the default', () => {
  const prev = process.env.CIPHER_MODEL;
  try {
    delete process.env.CIPHER_MODEL;
    assert.equal(configuredModel(null), DEFAULT_MODEL);
    assert.equal(configuredModel('qwen2.5:3b'), 'qwen2.5:3b');
    process.env.CIPHER_MODEL = 'llama3.1:8b';
    assert.equal(configuredModel('qwen2.5:3b'), 'llama3.1:8b');
  } finally {
    if (prev === undefined) delete process.env.CIPHER_MODEL; else process.env.CIPHER_MODEL = prev;
  }
});

test('parseStreamLine turns malformed JSON into a friendly message', () => {
  assert.deepEqual(parseStreamLine('{"a":1}'), { a: 1 });
  assert.throws(() => parseStreamLine('{"message": oops'), (e: Error) => e.message === BAD_STREAM_MESSAGE);
  assert.doesNotMatch(BAD_STREAM_MESSAGE, /Unexpected token|JSON/);
});

test('streamChat reports a bad stream line with the friendly message, not a raw parse error', async () => {
  const host = await ready;
  const tokens: string[] = [];
  await assert.rejects(
    streamChat({ host, model: 'tiny', messages: [{ role: 'user', content: 'hi' }], onToken: (t) => tokens.push(t) }),
    (e: Error) => e.message === BAD_STREAM_MESSAGE,
  );
  assert.deepEqual(tokens, ['Hel']);
});

test('PullProgressTracker aggregates layers into overall progress', () => {
  const t = new PullProgressTracker();
  let p = t.apply(JSON.stringify({ status: 'pulling manifest' }));
  assert.equal(p.percent, null);
  assert.equal(p.status, 'pulling manifest');
  p = t.apply(JSON.stringify({ status: 'pulling a', digest: 'a', total: 300, completed: 150 }));
  assert.equal(p.percent, 50);
  p = t.apply(JSON.stringify({ status: 'pulling b', digest: 'b', total: 100 }));
  assert.deepEqual([p.completed, p.total, p.percent], [150, 400, 37.5]);
  p = t.apply(JSON.stringify({ status: 'pulling b', digest: 'b', total: 100, completed: 100 }));
  assert.equal(p.percent, 62.5);
  p = t.apply(JSON.stringify({ status: 'pulling a', digest: 'a', total: 300, completed: 9999 })); // clamps
  assert.equal(p.percent, 100);
  assert.equal(p.done, false);
  p = t.apply('');
  assert.equal(p.done, false);
  p = t.apply(JSON.stringify({ status: 'success' }));
  assert.equal(p.done, true);
  assert.equal(p.percent, 100);
});

test('PullProgressTracker: Ollama error lines and malformed lines become friendly errors', () => {
  const t = new PullProgressTracker();
  assert.throws(() => t.apply(JSON.stringify({ error: 'pull model manifest: dial tcp: lookup registry.ollama.ai: no such host' })), /check your internet connection/i);
  assert.throws(() => t.apply(JSON.stringify({ error: 'file does not exist' })), /^Error: Download failed: file does not exist$/);
  assert.throws(() => t.apply('not json'), (e: Error) => e.message === BAD_STREAM_MESSAGE);
});

test('pullModel streams progress from POST /api/pull with stream:true and finishes', async () => {
  const host = await ready;
  const seen: (number | null)[] = [];
  const final = await pullModel({ host, model: 'qwen2.5:3b', onProgress: (p) => seen.push(p.percent) });
  const req = bodies.filter((b) => b.url === '/api/pull').at(-1)!;
  assert.deepEqual(req.body, { model: 'qwen2.5:3b', stream: true });
  assert.equal(final.done, true);
  assert.equal(final.percent, 100);
  assert.deepEqual(seen, [null, 0, 50, 37.5, 62.5, 100, 100, 100, 100]);
});

test('pullModel surfaces an Ollama error line', async () => {
  const host = await ready;
  await assert.rejects(pullModel({ host, model: 'offline', onProgress: () => {} }), /internet connection/);
});

test('pullModel can be cancelled', async () => {
  const host = await ready;
  const ac = new AbortController();
  const p = pullModel({ host, model: 'slow', signal: ac.signal, onProgress: (pr) => { if (pr.percent === 1) ac.abort(); } });
  await assert.rejects(p);
  assert.equal(ac.signal.aborted, true);
  releaseSlowPull?.();
});

test('pullModel fails clearly when Ollama is not running', async () => {
  await assert.rejects(pullModel({ host: 'http://127.0.0.1:9', model: 'qwen2.5:3b', onProgress: () => {} }), /Could not reach Ollama/);
});

test('warmUp sends an empty chat with keep_alive to load the model', async () => {
  const host = await ready;
  assert.equal(await warmUp('qwen2.5:3b', host), true);
  const req = bodies.filter((b) => b.url === '/api/chat').at(-1)!;
  assert.deepEqual(req.body, { model: 'qwen2.5:3b', messages: [], stream: false, keep_alive: KEEP_ALIVE });
  assert.equal(await warmUp('qwen2.5:3b', 'http://127.0.0.1:9'), false);
});

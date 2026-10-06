import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SetupManager } from '../main/setup';
import { DEFAULT_MODEL, ENGINE_MISSING_MESSAGE, MODEL_MISSING_MESSAGE } from '../main/ollama';
import type { SetupState } from '../shared/types';

// Fake local engine: /api/tags lists `installed`; /api/pull streams progress (or fails while `failPulls` > 0).
let installed: string[] = [];
let failPulls = 0;
const calls: { url: string; body: any }[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url!, body });
    const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: installed.map((n) => ({ name: n, model: n })) }));
    } else if (req.url === '/api/pull') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      send({ status: 'pulling manifest' });
      if (failPulls > 0) {
        failPulls--;
        send({ error: 'max retries exceeded: dial tcp: lookup registry.ollama.ai: no such host' });
        res.end();
        return;
      }
      send({ status: 'pulling x', digest: 'sha256:x', total: 4000, completed: 1000 });
      send({ status: 'pulling x', digest: 'sha256:x', total: 4000, completed: 4000 });
      send({ status: 'success' });
      installed.push(body.model);
      res.end();
    } else if (req.url === '/api/chat') {
      res.end(JSON.stringify({ done: true })); // warm-up
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
});
const ready = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
after(() => server.close());

function manager(host: string) {
  const states: SetupState[] = [];
  const m = new SetupManager({ model: DEFAULT_MODEL, host, throttleMs: 0, onChange: (s) => states.push(s) });
  return { m, states };
}
const settle = () => new Promise((r) => setTimeout(r, 30)); // let the background warm-up request land

test('starts in "checking" and goes straight to ready when the model is already on disk (then warms it up)', async () => {
  const host = await ready;
  installed = ['qwen2.5:7b'];
  calls.length = 0;
  const { m, states } = manager(host);
  assert.equal(m.state.phase, 'checking');
  const s = await m.run(true);
  await settle();
  assert.equal(s.phase, 'ready');
  assert.deepEqual(states.map((x) => x.phase), ['ready']);
  assert.equal(calls.filter((c) => c.url === '/api/pull').length, 0, 'nothing downloaded');
  const warm = calls.find((c) => c.url === '/api/chat');
  assert.deepEqual(warm?.body, { model: 'qwen2.5:7b', messages: [], stream: false, keep_alive: '30m' });
});

test('first launch with the model missing downloads qwen2.5:7b through /api/pull with progress, then is ready', async () => {
  const host = await ready;
  installed = ['qwen2.5:3b', 'qwen2.5:0.5b']; // other models on disk don't count
  calls.length = 0;
  const { m, states } = manager(host);
  const s = await m.run(true);
  assert.equal(s.phase, 'ready');
  const pull = calls.find((c) => c.url === '/api/pull');
  assert.deepEqual(pull?.body, { model: 'qwen2.5:7b', stream: true });
  const phases = states.map((x) => x.phase);
  assert.equal(phases[0], 'downloading');
  assert.equal(phases.at(-1), 'ready');
  assert.ok(states.some((x) => x.phase === 'downloading' && x.percent === 25 && x.total === 4000), 'reports progress');
});

test('engine not running: plain message, no download attempted', async () => {
  const { m } = manager('http://127.0.0.1:9');
  const s = await m.run(true);
  assert.equal(s.phase, 'engine-missing');
  assert.equal(s.message, ENGINE_MISSING_MESSAGE);
});

test('check-only (after a chat error) reports model-missing instead of downloading; "Set up again" downloads', async () => {
  const host = await ready;
  installed = [];
  calls.length = 0;
  const { m } = manager(host);
  const checked = await m.run(false);
  assert.equal(checked.phase, 'model-missing');
  assert.equal(checked.message, MODEL_MISSING_MESSAGE);
  assert.equal(calls.filter((c) => c.url === '/api/pull').length, 0);
  assert.equal((await m.run(true)).phase, 'ready');
  assert.equal(calls.filter((c) => c.url === '/api/pull').length, 1);
});

test('a failed download shows a plain error and "Try again" (run again) recovers', async () => {
  const host = await ready;
  installed = [];
  failPulls = 1;
  const { m } = manager(host);
  const failed = await m.run(true);
  assert.equal(failed.phase, 'error');
  assert.match(failed.message!, /internet connection.*Try again/);
  assert.doesNotMatch(failed.message!, /ollama|registry|qwen|dial tcp/i);
  assert.equal((await m.run(true)).phase, 'ready');
});

test('concurrent runs share one download; a download request during a check runs right after it', async () => {
  const host = await ready;
  installed = [];
  calls.length = 0;
  const { m } = manager(host);
  const [a, b] = await Promise.all([m.run(true), m.run(true)]);
  assert.equal(a.phase, 'ready');
  assert.equal(b.phase, 'ready');
  assert.equal(calls.filter((c) => c.url === '/api/pull').length, 1);

  installed = [];
  calls.length = 0;
  const { m: m2 } = manager(host);
  const check = m2.run(false);
  const dl = m2.run(true);
  assert.equal((await check).phase, 'model-missing');
  assert.equal((await dl).phase, 'ready');
  assert.equal(calls.filter((c) => c.url === '/api/pull').length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';
import { PhoneServer, PAIR_TTL_MS, PHONE_LINK_PORT, buildPhoneUrls, primaryPhoneUrl } from '../main/phoneServer';
import {
  assertOutboundAllowed, isEngineDownloadUrl, isPhoneLinkSafeUrl, parseOnlineSetting, onlineSettingValue, ONLINE_SETTING_KEY,
} from '../main/networkGuard';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-phone-')), 'c.db');
const phoneStatic = () => {
  // After build, tests run from dist/test → ../phone is dist/phone
  const built = path.join(__dirname, '..', 'phone');
  if (fs.existsSync(path.join(built, 'index.html'))) return built;
  return path.join(__dirname, '..', '..', 'src', 'phone');
};

let nextPort = 27900;
const allocPort = () => nextPort++;

async function httpJson(
  base: string,
  pathname: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

test('Online setting defaults off and persists', () => {
  const db = new CipherDb(tmpDb());
  assert.equal(parseOnlineSetting(db.getSetting(ONLINE_SETTING_KEY)), false, 'default off when unset');
  assert.equal(parseOnlineSetting(null), false);
  assert.equal(parseOnlineSetting('0'), false);
  assert.equal(parseOnlineSetting('1'), true);
  db.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(true));
  assert.equal(parseOnlineSetting(db.getSetting(ONLINE_SETTING_KEY)), true);
  db.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(false));
  assert.equal(parseOnlineSetting(db.getSetting(ONLINE_SETTING_KEY)), false);
  db.close();
});

test('Online off blocks non-loopback outbound; loopback always allowed; phone-link must not open internet', () => {
  assert.doesNotThrow(() => assertOutboundAllowed(false, 'http://127.0.0.1:11434/api/tags'));
  assert.doesNotThrow(() => assertOutboundAllowed(false, 'http://localhost:17865/'));
  assert.throws(() => assertOutboundAllowed(false, 'https://example.com/'), /Online is off/);
  // "Get the engine" is the one user-clicked exception when Online is off.
  assert.equal(isEngineDownloadUrl('https://ollama.com/download'), true);
  assert.doesNotThrow(() => assertOutboundAllowed(false, 'https://ollama.com/download'));
  assert.doesNotThrow(() => assertOutboundAllowed(true, 'https://ollama.com/download'));
  // Other ollama.com pages stay blocked while Online is off.
  assert.throws(() => assertOutboundAllowed(false, 'https://ollama.com/blog'), /Online is off/);
  assert.equal(isPhoneLinkSafeUrl('http://127.0.0.1:17865/api/bots'), true);
  assert.equal(isPhoneLinkSafeUrl('https://evil.example/pull'), false);
  // Module boundary: phone link never treats a public host as safe for app-initiated fetches.
  assert.equal(isPhoneLinkSafeUrl('https://api.openai.com/v1'), false);
  assert.equal(isPhoneLinkSafeUrl('https://ollama.com/download'), false);
});

test('buildPhoneUrls includes loopback and LAN-style addresses', () => {
  const urls = buildPhoneUrls(PHONE_LINK_PORT, ['192.168.1.10']);
  assert.ok(urls.some((u) => u.includes('192.168.1.10')));
  assert.ok(urls.some((u) => u.includes('127.0.0.1')));
  assert.ok(PAIR_TTL_MS >= 10 * 60 * 1000 && PAIR_TTL_MS <= 15 * 60 * 1000);
});

test('primaryPhoneUrl prefers LAN over loopback; QR payload is URL-only', () => {
  const urls = buildPhoneUrls(17865, ['10.0.0.5']);
  const primary = primaryPhoneUrl(urls);
  assert.equal(primary, 'http://10.0.0.5:17865/');
  assert.ok(!primary!.includes('pair'));
  assert.ok(!/[A-Z0-9]{6}/.test(new URL(primary!).pathname));
  assert.equal(primaryPhoneUrl(['http://127.0.0.1:17865/']), 'http://127.0.0.1:17865/');
  assert.equal(primaryPhoneUrl([]), null);
});

test('pairing: bad code rejected; expired code rejected; valid session required for APIs', async () => {
  const db = new CipherDb(tmpDb());
  db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  const port = allocPort();
  const server = new PhoneServer({
    db, staticDir: phoneStatic(), model: 'fake', port,
    sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {},
  });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  try {
    const st = server.status();
    assert.equal(st.running, true);
    assert.ok(st.pairingCode && st.pairingCode.length === 6);

    const unauth = await httpJson(base, '/api/bots');
    assert.equal(unauth.status, 401, 'request without session token fails');

    const bad = await httpJson(base, '/api/pair', { method: 'POST', body: { code: 'XXXXXX' } });
    assert.equal(bad.status, 403);

    server.setPairingForTest('EXPIRE', Date.now() - 1000);
    const expired = await httpJson(base, '/api/pair', { method: 'POST', body: { code: 'EXPIRE' } });
    assert.equal(expired.status, 403, 'expired pairing code fails');
    assert.match(String(expired.body.error), /expired/i);

    server.refreshPairingCode();
    const goodCode = server.status().pairingCode!;
    const paired = await httpJson(base, '/api/pair', { method: 'POST', body: { code: goodCode } });
    assert.equal(paired.status, 200);
    const token = String(paired.body.token);
    assert.ok(token.length >= 32);

    // Code is one-time / consumed
    const reuse = await httpJson(base, '/api/pair', { method: 'POST', body: { code: goodCode } });
    assert.equal(reuse.status, 403);

    const bots = await httpJson(base, '/api/bots', { token });
    assert.equal(bots.status, 200, 'request with valid session token succeeds');
    assert.equal((bots.body.bots as { name: string }[])[0].name, 'Ada');

    assert.equal((await httpJson(base, '/api/bots')).status, 401);
    assert.equal((await httpJson(base, '/api/bots', { token: 'ab'.repeat(24) })).status, 401);

    const pull = await httpJson(base, '/api/ollama/pull', { method: 'POST', token, body: {} });
    assert.equal(pull.status, 404, 'phone path does not call model pull');
  } finally {
    server.stop();
    db.close();
  }
});

test('phone send + stop through API', async () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Bo', systemPrompt: 'Hi', toolsEnabled: true, folderPath: null });
  let aborted = false;
  const port = allocPort();
  const server = new PhoneServer({
    db, staticDir: phoneStatic(), model: 'fake', port,
    sendChat: async (chatId, text, emit, signal) => {
      emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'user', content: text }) });
      for (const w of ['Hello ', 'world ', 'slow ']) {
        if (signal.aborted) { aborted = true; emit({ chatId, type: 'done' }); return; }
        emit({ chatId, type: 'token', text: w });
        await new Promise((r) => setTimeout(r, 40));
      }
      emit({ chatId, type: 'message', message: db.addMessage({ chatId, role: 'assistant', content: 'Hello world slow' }) });
      emit({ chatId, type: 'done' });
    },
    stopChat: (chatId) => { /* abort handled via signal from phoneServer.chatAbort */ void chatId; },
    sendRoom: async () => {},
    stopRoom: () => {},
  });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  try {
    const code = server.status().pairingCode!;
    const token = String((await httpJson(base, '/api/pair', { method: 'POST', body: { code } })).body.token);
    const send = await httpJson(base, `/api/bots/${bot.id}/send`, { method: 'POST', token, body: { text: 'hi' } });
    assert.equal(send.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    const stop = await httpJson(base, `/api/bots/${bot.id}/stop`, { method: 'POST', token });
    assert.equal(stop.status, 200);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(aborted, true, 'stop works through the phone API');

    const chat = await httpJson(base, `/api/bots/${bot.id}/chat`, { token });
    assert.equal(chat.status, 200);
  } finally {
    server.stop();
    db.close();
  }
});

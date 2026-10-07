import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb } from '../main/db';
import {
  AppLock, AttemptThrottle, FIRST_WAIT_MS, LOCK_FILE_NAME, LOCKED_MESSAGE, LockStore, SCRYPT_PARAMS, UNLOCKED_CHANNELS,
  hashPassphrase, lockGuard, lockOnHide, parseLockRecord, validateNewPassphrase, verifyPassphrase,
} from '../main/lock';
import { PhoneServer, PHONE_LOCKED_MESSAGE, PHONE_LOCKED_STATUS } from '../main/phoneServer';

const PASS = 'correct horse battery';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-lock-'));
const root = path.join(__dirname, '..', '..');
const src = (rel: string) => fs.readFileSync(path.join(root, 'src', rel), 'utf8');

test('hashing: scrypt with a random salt each time; right passphrase verifies, wrong does not; no plaintext stored', async () => {
  const a = await hashPassphrase(PASS);
  const b = await hashPassphrase(PASS);
  assert.notEqual(a.salt, b.salt, 'salt is random');
  assert.notEqual(a.hash, b.hash, 'so the same passphrase hashes differently');
  assert.ok(Buffer.from(a.salt, 'base64').length >= 16, 'salt is at least 16 bytes');
  assert.deepEqual({ N: a.N, r: a.r, p: a.p, keylen: a.keylen }, { ...SCRYPT_PARAMS });
  assert.equal(a.N, 2 ** 15);
  assert.equal(await verifyPassphrase(PASS, a), true);
  assert.equal(await verifyPassphrase(PASS, b), true);
  assert.equal(await verifyPassphrase('correct horse batterz', a), false);
  assert.equal(await verifyPassphrase('', a), false);
  assert.equal(await verifyPassphrase(undefined, a), false);
  const stored = JSON.stringify(a);
  assert.ok(!stored.includes(PASS), 'the record never contains the passphrase');
  assert.ok(!stored.includes(Buffer.from(PASS).toString('base64')), 'nor its base64');
  assert.ok(!stored.includes(Buffer.from(PASS).toString('hex')), 'nor its hex');
  assert.deepEqual(parseLockRecord(stored), a);
});

test('verification compares hashes with crypto.timingSafeEqual, and a wrong-length hash never matches', async () => {
  const lock = src('main/lock.ts');
  assert.match(lock, /actual\.length === expected\.length && timingSafeEqual\(actual, expected\)/);
  assert.doesNotMatch(lock, /\.hash ===|=== rec\.hash|console\./, 'no plain string comparison of hashes, no logging');
  const rec = await hashPassphrase(PASS);
  // A truncated hash never matches (scrypt output is derived at full length), and such a file is rejected outright.
  const short = { ...rec, hash: Buffer.from(rec.hash, 'base64').subarray(0, 16).toString('base64'), keylen: 16 };
  assert.equal(await verifyPassphrase(PASS, short), false);
  assert.equal(parseLockRecord(JSON.stringify(short)), null);
});

test('new passphrase: at least 8 characters and entered twice the same', () => {
  assert.throws(() => validateNewPassphrase('short', 'short'), /at least 8/);
  assert.throws(() => validateNewPassphrase('long enough', 'long enougH'), /don't match/);
  assert.throws(() => validateNewPassphrase(42, 42), /at least 8/);
  assert.equal(validateNewPassphrase('long enough', 'long enough'), 'long enough');
});

test('lock file: lock.json in the user data folder, mode 0600, only {params, salt, hash}; never in cipher.db', async () => {
  const dir = tmpDir();
  const db = new CipherDb(path.join(dir, 'cipher.db'));
  const lock = new AppLock(new LockStore(dir));
  assert.deepEqual(lock.state(), { enabled: false, locked: false }, 'off by default');
  await lock.enable(PASS, PASS);
  const file = path.join(dir, LOCK_FILE_NAME);
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(PASS));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['N', 'hash', 'kdf', 'keylen', 'p', 'r', 'salt', 'v']);
  db.close();
  const dbBytes = fs.readFileSync(path.join(dir, 'cipher.db')).toString('latin1');
  const rec = JSON.parse(text) as { salt: string; hash: string };
  assert.ok(!dbBytes.includes(rec.salt) && !dbBytes.includes(rec.hash) && !dbBytes.includes('scrypt'), 'nothing of the lock in the DB');
});

test('app lock: starts locked when on; unlock needs the right passphrase; change and turn off need the current one', async () => {
  const dir = tmpDir();
  const first = new AppLock(new LockStore(dir));
  await first.enable(PASS, PASS);
  assert.equal(first.isLocked(), false, 'turning it on keeps this session unlocked');
  await assert.rejects(first.enable(PASS, PASS), /already on/);

  const lock = new AppLock(new LockStore(dir)); // next launch
  assert.deepEqual(lock.state(), { enabled: true, locked: true });
  const wrong = await lock.unlock('not the passphrase');
  assert.equal(wrong.ok, false);
  assert.equal(lock.isLocked(), true);
  assert.deepEqual(await lock.unlock(PASS), { ok: true });
  assert.equal(lock.isLocked(), false);
  assert.equal(lock.lock(), true, 'locks again (window closed to the tray)');
  assert.deepEqual(await lock.unlock(PASS), { ok: true });

  const badChange = await lock.change('nope nope', 'new passphrase', 'new passphrase');
  assert.equal(badChange.ok, false);
  assert.match(badChange.ok ? '' : badChange.error, /Wrong current passphrase/);
  assert.deepEqual(await lock.change(PASS, 'new passphrase', 'new passphrase'), { ok: true });
  lock.lock();
  assert.equal((await lock.unlock(PASS)).ok, false, 'old passphrase no longer works');
  assert.equal((await lock.unlock('new passphrase')).ok, true);

  assert.equal((await lock.disable(PASS)).ok, false, 'turning off needs the current passphrase');
  assert.equal(lock.isEnabled(), true);
  assert.deepEqual(await lock.disable('new passphrase'), { ok: true });
  assert.deepEqual(lock.state(), { enabled: false, locked: false });
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE_NAME)), false);
  assert.equal(lock.lock(), false, 'with the lock off, nothing locks');
});

test('a damaged lock file fails closed: still locked, no passphrase opens it', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, LOCK_FILE_NAME), '{"v":1,"kdf":"plain"}');
  const lock = new AppLock(new LockStore(dir));
  assert.deepEqual(lock.state(), { enabled: true, locked: true });
  assert.equal((await lock.unlock('anything at all')).ok, false);
  assert.equal(lock.isLocked(), true);
});

test('attempt throttling: after 5 wrong tries wait 30 s (even the right passphrase is refused), then it doubles', async () => {
  const t = new AttemptThrottle();
  for (let i = 0; i < 4; i++) assert.equal(t.fail(1000), 0);
  assert.equal(t.fail(1000), FIRST_WAIT_MS);
  assert.equal(FIRST_WAIT_MS, 30_000);
  assert.equal(t.waitMs(1000 + 10_000), 20_000);
  assert.equal(t.waitMs(1000 + 30_000), 0);
  for (let i = 0; i < 4; i++) t.fail(40_000);
  assert.equal(t.fail(40_000), 60_000, 'second round waits longer');
  t.succeed();
  assert.equal(t.waitMs(40_000), 0);

  let now = 1_000_000;
  const dir = tmpDir();
  await new AppLock(new LockStore(dir)).enable(PASS, PASS);
  const lock = new AppLock(new LockStore(dir), () => now);
  for (let i = 0; i < 4; i++) assert.equal((await lock.unlock('wrong one')).ok, false);
  const fifth = await lock.unlock('wrong one');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.ok ? 0 : fifth.waitMs, 30_000);
  assert.match(fifth.ok ? '' : fifth.error, /Try again in 30 s/);
  const during = await lock.unlock(PASS);
  assert.equal(during.ok, false, 'refused during the wait without checking');
  assert.equal(lock.isLocked(), true);
  now += 30_000;
  assert.deepEqual(await lock.unlock(PASS), { ok: true });
});

test('IPC gating: while locked every data handler refuses; only lock, setup and online:get answer', () => {
  let locked = true;
  const data = lockGuard('messages:list', () => locked, () => ['secret message']);
  assert.throws(() => data(), new RegExp(LOCKED_MESSAGE));
  locked = false;
  assert.deepEqual(data(), ['secret message']);
  locked = true;
  assert.equal(lockGuard('lock:unlock', () => locked, () => 'ok')(), 'ok');

  const main = src('main/main.ts');
  // Every handler is registered through the guard; no raw ipcMain.handle outside it.
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 1);
  assert.match(main, /ipcMain\.handle\(channel, lockGuard\(channel, isLocked, fn\)\)/);
  const channels = [...main.matchAll(/\bhandle\('([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
  for (const ch of ['bots:list', 'bots:create', 'bots:update', 'bots:delete', 'rooms:list', 'rooms:create', 'rooms:delete',
    'roomMessages:list', 'chats:openForBot', 'messages:list', 'chat:send', 'chat:export', 'room:send', 'routines:get',
    'routines:set', 'dialog:pickFolder', 'dialog:pickAttachFile', 'clipboard:writeText', 'phone:get', 'phone:start',
    'phone:refreshCode', 'online:set', 'data:backup', 'data:restorePick', 'data:restoreConfirm', 'lock:enable',
    'lock:change', 'lock:disable', 'menu:item']) {
    assert.ok(channels.includes(ch), `${ch} registered through handle()`);
    assert.ok(!UNLOCKED_CHANNELS.has(ch), `${ch} refuses while locked`);
  }
  for (const ch of UNLOCKED_CHANNELS) assert.match(ch, /^(lock:(state|unlock)|setup:|engine:openDownloadPage|online:get)/);
  // Chat/room/phone-status pushes are not sent to the window while locked.
  assert.match(main, /function broadcastChat\(ev: ChatEvent\): void \{\s*if \(isLocked\(\)\) return;/);
  assert.match(main, /function broadcastRoom\(ev: RoomEvent\): void \{\s*if \(isLocked\(\)\) return;/);
  assert.match(main, /function broadcastPhone\(\): void \{\s*if \(isLocked\(\)\) return;/);
});

test('closing to the tray locks at the moment it hides (before win.hide); every hide path and every show path is covered', () => {
  const main = src('main/main.ts');
  // close → hideToTray: lock first (lockOnHide → lockApp: closes phone streams, swaps the page), then hide.
  assert.match(main, /e\.preventDefault\(\);\s*hideToTray\(win\);/);
  assert.match(main, /function hideToTray\(win: BrowserWindow\): void \{\s*lockOnHide\(appLock, \(\) => void lockApp\(win\)\);\s*win\.hide\(\);\s*\}/);
  // Any other hide (e.g. the window manager) locks too.
  assert.match(main, /win\.on\('hide', \(\) => \{ if \(!quitting\) lockOnHide\(appLock, \(\) => void lockApp\(win\)\); \}\);/);
  // Hiding never aborts a reply or a routine: it keeps running in main and is saved (pushes are just withheld).
  const lockApp = /async function lockApp[\s\S]*?\n\}\n/.exec(main)![0];
  const hide = /function hideToTray[\s\S]*?\n\}\n/.exec(main)![0];
  for (const b of [lockApp, hide]) assert.doesNotMatch(b, /abort|activeTurns|activeRooms|routines|phone\.stop|phone\?\.stop/);
  // Show paths (tray Show/click, second launch, macOS activate, a routine notice) all go through showWindow.
  assert.match(main, /tray\.on\('click', \(\) => void showWindow\(\)\);/);
  assert.match(main, /app\.on\('activate', \(\) => void showWindow\(\)\);/);
  assert.match(main, /async function openBotChatInWindow\(botId: number\): Promise<void> \{[\s\S]*?await showWindow\(\);/);
});

test('re-showing a hidden window shows the lock screen (safety net: locks if somehow unlocked while hidden); tray Show goes through it', () => {
  const main = src('main/main.ts');
  assert.match(main, /if \(!win\.isVisible\(\) && appLock\.isEnabled\(\) && !appLock\.isLocked\(\)\) await lockApp\(win\);/);
  assert.match(main, /async function lockApp\(win: BrowserWindow\): Promise<void> \{\s*appLock\.lock\(\);\s*openBotId = null;\s*phone\?\.closeStreams\(\);/);
  // a fresh document each time (a hash-only change would keep the old page and its chat data in memory)
  assert.match(main, /loadFile\([^)]*index\.html'\), \{ query: \{ lock: String\(\+\+lockLoads\) \}, hash: 'nosplash' \}\)/);
  assert.match(main, /label: 'Show Cipher', click: \(\) => void showWindow\(\)/);
  assert.match(main, /app\.on\('second-instance', \(\) => \{\s*if \(app\.isReady\(\)\) void showWindow\(\);/);
  // The renderer starts on the lock screen (in the HTML, not hidden) and loads data only after the check.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<div id="lock-screen" class="lock-screen" role="dialog"[^>]*>/);
  assert.doesNotMatch(/<div id="lock-screen"[^>]*>/.exec(html)![0], /hidden/);
  assert.match(html, /There is no recovery/);
  const r = src('renderer/renderer.ts');
  assert.match(r, /if \(state\.lock\.locked\) showLockScreen\(\); \/\/ nothing else loads until the passphrase is right\s*else \{ hideLockScreen\(\); await loadAppData\(\); \}/);
  assert.doesNotMatch(r, /localStorage|sessionStorage|console\./);
});

test('the passphrase only goes to main over IPC, never to the phone or a URL', () => {
  const preload = src('preload/preload.ts');
  assert.match(preload, /unlock: \(passphrase\) => ipcRenderer\.invoke\('lock:unlock', passphrase\)/);
  for (const f of ['main/phoneServer.ts', 'phone/app.js', 'phone/index.html']) assert.doesNotMatch(src(f), /passphrase|lock:unlock|appLock/i, f);
  assert.doesNotMatch(src('main/main.ts'), /console\.|passphrase[^)]*\)\s*\)?\s*;?\s*\/\/\s*log/i);
});

async function req(base: string, pathname: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, text };
}

test('phone link refuses everything while locked (pairing, status, chats, sends, events); sessions resume after unlock', async () => {
  const dir = tmpDir();
  const db = new CipherDb(path.join(dir, 'c.db'));
  const bot = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.addMessage({ chatId: db.getBotChat(bot.id).id, role: 'user', content: 'very private words' });
  let locked = false;
  const sent: string[] = [];
  const port = 28950;
  const builtPhone = path.join(__dirname, '..', 'phone');
  const server = new PhoneServer({
    db, staticDir: fs.existsSync(path.join(builtPhone, 'index.html')) ? builtPhone : path.join(root, 'src', 'phone'), model: 'fake', port,
    sendChat: async (_c, text) => { sent.push(text); }, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {},
    isLocked: () => locked,
  });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  try {
    const code = server.status().pairingCode!;
    const pair = await req(base, '/api/pair', { method: 'POST', body: { code } });
    const token = (JSON.parse(pair.text) as { token: string }).token;
    assert.equal((await req(base, '/api/bots', { token })).status, 200);

    // An open event stream is ended when Cipher locks.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/bots/${bot.id}/events?token=${token}`, { signal: ac.signal });
    assert.equal(stream.status, 200);
    locked = true;
    server.closeStreams();
    const reader = stream.body!.getReader();
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    assert.equal(done, true, 'stream closed on lock');

    server.refreshPairingCode();
    const fresh = server.status().pairingCode!;
    const cases: [string, string, unknown?][] = [
      ['GET', '/api/status'], ['POST', '/api/pair', { code: fresh }], ['GET', '/api/bots'], ['GET', '/api/rooms'],
      ['GET', `/api/bots/${bot.id}/chat`], ['POST', `/api/bots/${bot.id}/send`, { text: 'hi' }], ['GET', `/api/bots/${bot.id}/events`],
      ['POST', `/api/bots/${bot.id}/stop`],
    ];
    for (const [method, p, body] of cases) {
      const r = await req(base, p, { method, token, body });
      assert.equal(r.status, PHONE_LOCKED_STATUS, `${method} ${p}`);
      assert.equal((JSON.parse(r.text) as { error: string }).error, PHONE_LOCKED_MESSAGE);
      assert.ok(!r.text.includes('very private') && !r.text.includes('Ada'), 'no chat data');
    }
    assert.equal(PHONE_LOCKED_MESSAGE, 'Cipher is locked on the desktop.');
    assert.equal(sent.length, 0, 'nothing sent while locked');
    assert.equal(server.status().pairingCode, fresh, 'the code was not consumed while locked');
    // The static page still loads (no data in it) so the phone can show the locked message.
    assert.equal((await req(base, '/')).status, 200);

    locked = false;
    assert.equal((await req(base, '/api/bots', { token })).status, 200, 'paired session works again after unlock');
    ac.abort();
  } finally {
    server.stop();
    db.close();
  }
});

async function phoneWithLock(lock: AppLock, port: number) {
  const dir = tmpDir();
  const db = new CipherDb(path.join(dir, 'c.db'));
  const bot = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.addMessage({ chatId: db.getBotChat(bot.id).id, role: 'user', content: 'very private words' });
  const builtPhone = path.join(__dirname, '..', 'phone');
  const server = new PhoneServer({
    db, staticDir: fs.existsSync(path.join(builtPhone, 'index.html')) ? builtPhone : path.join(root, 'src', 'phone'), model: 'fake', port,
    sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {},
    isLocked: () => lock.isLocked(), // as in main
  });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  const code = server.status().pairingCode!;
  const token = (JSON.parse((await req(base, '/api/pair', { method: 'POST', body: { code } })).text) as { token: string }).token;
  const ac = new AbortController();
  const stream = await fetch(`${base}/api/bots/${bot.id}/events?token=${token}`, { signal: ac.signal });
  assert.equal(stream.status, 200);
  const close = () => { ac.abort(); server.stop(); db.close(); };
  return { server, base, token, bot, stream, close };
}

test('hide to the tray with the lock on: locked at once; the very next phone request (pairing too) gets 423 and the stream closes; data IPC refuses', async () => {
  const dir = tmpDir();
  await new AppLock(new LockStore(dir)).enable(PASS, PASS);
  const lock = new AppLock(new LockStore(dir));
  assert.deepEqual(await lock.unlock(PASS), { ok: true });
  const p = await phoneWithLock(lock, 28951);
  try {
    assert.equal((await req(p.base, '/api/bots', { token: p.token })).status, 200, 'unlocked and shown: phone works');
    const steps: string[] = [];
    // What hideToTray does: lockOnHide(appLock, () => lockApp(win)) — lockApp closes the phone streams.
    assert.equal(lockOnHide(lock, () => { steps.push(lock.isLocked() ? 'locked-then-cleanup' : 'cleanup-before-lock'); p.server.closeStreams(); }), true);
    steps.push('win.hide');
    assert.deepEqual(steps, ['locked-then-cleanup', 'win.hide'], 'locks before the window hides');
    assert.equal(lock.isLocked(), true);
    const bots = await req(p.base, '/api/bots', { token: p.token });
    assert.equal(bots.status, PHONE_LOCKED_STATUS, 'phone request right after the hide');
    assert.ok(!bots.text.includes('Ada'));
    p.server.refreshPairingCode();
    assert.equal((await req(p.base, '/api/pair', { method: 'POST', body: { code: p.server.status().pairingCode } })).status, PHONE_LOCKED_STATUS);
    assert.equal((await req(p.base, `/api/bots/${p.bot.id}/send`, { method: 'POST', token: p.token, body: { text: 'hi' } })).status, PHONE_LOCKED_STATUS);
    const reader = p.stream.body!.getReader();
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    assert.equal(done, true, 'open stream closed at hide');
    const listBots = lockGuard('bots:list', () => lock.isLocked(), () => ['Ada']);
    assert.throws(() => listBots(), new RegExp(LOCKED_MESSAGE.replace('.', '\\.')), 'data IPC refuses while hidden');
    assert.equal(lockOnHide(lock, () => assert.fail('already locked: nothing to do')), false, 'a second hide event is a no-op');
    // Show again → still locked (lock screen); unlock → phone works again with the same session.
    assert.equal(lock.isLocked(), true);
    assert.deepEqual(await lock.unlock(PASS), { ok: true });
    assert.equal((await req(p.base, '/api/bots', { token: p.token })).status, 200, 'after unlock: 200 again');
  } finally {
    p.close();
  }
});

test('hide to the tray with the lock off: nothing locks and the phone keeps working (stream stays open)', async () => {
  const lock = new AppLock(new LockStore(tmpDir())); // no lock.json
  const p = await phoneWithLock(lock, 28952);
  try {
    assert.equal(lockOnHide(lock, () => assert.fail('must not run with the lock off')), false);
    assert.equal(lock.isLocked(), false);
    assert.equal((await req(p.base, '/api/bots', { token: p.token })).status, 200);
    assert.equal((await req(p.base, `/api/bots/${p.bot.id}/chat`, { token: p.token })).status, 200);
    const reader = p.stream.body!.getReader();
    const first = await Promise.race([reader.read().then((r) => (r.done ? 'closed' : 'data')), new Promise((r) => setTimeout(() => r('open'), 300))]);
    assert.notEqual(first, 'closed', 'stream not closed');
    assert.equal(lockGuard('bots:list', () => lock.isLocked(), () => 'ok')(), 'ok');
  } finally {
    p.close();
  }
});

test('phone UI shows "Cipher is locked on the desktop" on a 423', () => {
  const app = src('phone/app.js');
  assert.match(app, /if \(res\.status === 423\) \{ closeEvents\(\); setBusy\(false\); show\('locked'\);/);
  assert.match(src('phone/index.html'), /<section id="locked-view" class="panel" hidden>\s*<h1>Cipher is locked on the desktop<\/h1>/);
});

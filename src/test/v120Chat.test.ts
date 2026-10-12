import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, QUOTE_MAX, SCHEMA_VERSION } from '../main/db';
import { buildHistory, userContentForModel } from '../main/chatEngine';
import { attachImageFromPath, MAX_IMAGE_BYTES, readImageInFolder, sniffImage } from '../main/imageAttach';
import { buildDebugLog, recordLogLine, recentLogLines, clearLogLines, redact, stripQuoted, type DebugFacts } from '../main/debugLog';
import { assertUpdateUrlAllowed, RELEASE_DOWNLOAD_HOSTS, UPDATE_API_URL } from '../main/networkGuard';
import { CHECK_INTERVAL_MS, checkForUpdate, downloadUpdate, isCheckDue, isNewer, parseVersion, pickDeb, type UpdateInfo } from '../main/updateCheck';
import { RoutineNotifier } from '../main/routineNotice';
import { plusMenuItems, SHORTCUTS, STARTER_JOBS } from '../renderer/view';
import { parseBlocks } from '../renderer/markdownParse';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';
import { UNLOCKED_CHANNELS } from '../main/lock';

// v1.20: quote, pin, mute, dropped images, starter jobs, shortcuts, debug log, update check.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const renderer = read('src/renderer/renderer.ts');
const html = read('src/renderer/index.html');
const phone = read('src/main/phoneServer.ts');
const phoneApp = fs.readdirSync(path.join(root, 'src/phone')).map((f) => read(`src/phone/${f}`)).join('\n');
const policy = POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v120-')));
let n = 0;
const tmpDb = () => path.join(base, `t${++n}.db`);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const fn = (name: string) => { const m = new RegExp(`(?:async )?function ${name}[\\s\\S]*?\\n\\}`).exec(main); assert.ok(m, name); return m[0]; };

test('version 1.21.0+, schema 10+, WHATS_NEW five lines or fewer, names unchanged', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.22.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher');
  assert.ok(SCHEMA_VERSION >= 10);
  assert.ok(WHATS_NEW.length <= 5 && WHATS_NEW.length > 0);
  assert.doesNotMatch(WHATS_NEW.join(' ') + policy + html, /grok/i);
});

test('CSP unchanged and strict; markdown still shows no images; images come only from data: URLs', () => {
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  const blocks = JSON.stringify(parseBlocks('![x](https://example.com/a.png) and <img src="https://e.com/b.png">'));
  assert.doesNotMatch(blocks, /"image"|"img"/);
  assert.match(renderer, /\/\^data:image\\\/\(png\|jpeg\|gif\|webp\);base64,\/\.test\(url\)/);
  assert.doesNotMatch(renderer, /\.src = [^;]*https?:/);
});

test('1. quote: snapshot of a message in the same chat, capped, user only, shown in the bubble and given to the model', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Q', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const a = db.addMessage({ chatId: chat.id, role: 'assistant', content: 'The answer is 42.' });
  const u = db.addMessage({ chatId: chat.id, role: 'user', content: 'Why?', quote: 'x'.repeat(QUOTE_MAX + 50) });
  assert.equal(u.quote!.length, QUOTE_MAX);
  assert.equal(db.addMessage({ chatId: chat.id, role: 'assistant', content: 'a', quote: 'nope' }).quote, null, 'only user messages carry quotes');
  const other = db.getBotChat(db.createBot({ name: 'R', systemPrompt: '', toolsEnabled: false, folderPath: null }).id);
  assert.equal(db.getMessage(other.id, a.id), null, 'cannot quote across chats');
  assert.equal(db.getMessage(chat.id, a.id)!.content, 'The answer is 42.');
  const hist = buildHistory(bot, [{ ...u, quote: 'The answer is 42.' }]);
  assert.match(hist.at(-1)!.content as string, /^Quoting an earlier message:\n> The answer is 42\.\n\nWhy\?$/);
  assert.equal(userContentForModel({ content: 'hi', quote: null, image: 'pics/cat.png' }), '[The user attached an image: cat.png]\n\nhi');
  db.close();
  const extras = fn('sendExtras');
  assert.match(extras, /db\.getMessage\(chatId, asId\(x\.quoteId\)\)/);
  assert.match(extras, /readImageInFolder\(bot\?\.folderPath \?\? null, x\.image\)/);
  assert.match(renderer, /node\('blockquote', 'msg-quote'/);
  assert.match(renderer, /assets\/cipher-quote\.svg/);
});

test('2. pin: per chat, listed in order, strip at the top; 3. mute: stored per bot and room', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'P', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const m1 = db.addMessage({ chatId: chat.id, role: 'user', content: 'one' });
  const m2 = db.addMessage({ chatId: chat.id, role: 'assistant', content: 'two' });
  assert.deepEqual(db.setPinned(chat.id, m2.id, true).map((m) => m.id), [m2.id]);
  assert.deepEqual(db.setPinned(chat.id, m1.id, true).map((m) => m.id), [m1.id, m2.id]);
  assert.equal(db.listMessages(chat.id)[1].pinned, true);
  assert.deepEqual(db.setPinned(chat.id, m2.id, false).map((m) => m.id), [m1.id]);
  assert.throws(() => db.setPinned(chat.id + 99, m1.id, true), /not found/);
  assert.equal(db.getBot(bot.id)!.muted, false);
  db.setMuted('bot', bot.id, true);
  assert.equal(db.getBot(bot.id)!.muted, true);
  const b2 = db.createBot({ name: 'P2', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const room = db.createRoom({ name: 'R', botIds: [bot.id, b2.id] });
  assert.equal(room.muted, false);
  db.setMuted('room', room.id, true);
  assert.equal(db.getRoom(room.id)!.muted, true);
  assert.equal(db.isMuted('room', room.id), true);
  db.close();
  assert.match(html, /<div id="pinned-strip" class="pinned-strip" hidden><\/div>\s*<div id="messages">/);
  assert.match(main, /handle\('messages:pin', \(_e, chatIdRaw: unknown, idRaw: unknown, on: unknown\) => db\.setPinned\(asId\(chatIdRaw\), asId\(idRaw\), on === true\)\);/);
  assert.deepEqual(plusMenuItems({ kind: 'room', muted: true }).map((i) => [i.id, i.checked]), [['export', undefined], ['markdown', undefined], ['mute', true], ['archive', undefined]]);
});

test('3. mute: a muted bot gets no tray notice; others still do', () => {
  let shown = 0;
  const muted = new Set([2]);
  const notifier = new RoutineNotifier({
    isSupported: () => true,
    create: () => ({ on: () => undefined, show: () => { shown++; } }),
    windowState: () => null, openBotId: () => null, botName: () => 'B', openBotChat: () => undefined,
    isMuted: (id) => muted.has(id),
  });
  assert.equal(notifier.notify(2, 'finished'), false);
  assert.equal(notifier.notify(1, 'finished'), true);
  assert.equal(shown, 1);
  assert.match(main, /isMuted: \(botId\) => db\.isMuted\('bot', botId\)/);
});

test('migration v9 → v10: quote, pin, image and mute columns added, data kept, idempotent', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: 'Old', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.addMessage({ chatId: db.getBotChat(bot.id).id, role: 'user', content: 'kept' });
  db.close();
  const raw = new Database(file);
  raw.exec('ALTER TABLE messages DROP COLUMN quote_text; ALTER TABLE messages DROP COLUMN pinned; ALTER TABLE messages DROP COLUMN image_path; ALTER TABLE bots DROP COLUMN muted; ALTER TABLE rooms DROP COLUMN muted');
  raw.pragma('user_version = 9');
  raw.close();
  db = new CipherDb(file);
  const [m] = db.listMessages(db.getBotChat(bot.id).id);
  assert.deepEqual([m.content, m.quote, m.pinned, m.image], ['kept', null, false, null]);
  assert.equal(db.getBot(bot.id)!.muted, false);
  db.close();
  new CipherDb(file).close();
  const chk = new Database(file);
  assert.equal(chk.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  chk.close();
});

test('4. dropped images: inside the folder only, real image bytes, size limit, no SVG; shown as data: from bytes', async () => {
  const folder = fs.mkdtempSync(path.join(base, 'imgs-'));
  fs.mkdirSync(path.join(folder, 'pics'));
  fs.writeFileSync(path.join(folder, 'pics', 'cat.png'), PNG);
  fs.writeFileSync(path.join(folder, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(folder, 'x.svg'), '<svg onload="alert(1)"/>');
  fs.writeFileSync(path.join(folder, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
  const outside = path.join(base, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(folder, 'link.png'));
  const ok = await attachImageFromPath({ folderPath: folder }, path.join(folder, 'pics', 'cat.png'));
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.relPath, path.join('pics', 'cat.png'));
    assert.equal(ok.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  }
  for (const [p, re] of [[outside, /outside|folder/i], [path.join(folder, 'link.png'), /outside|folder/i], [path.join(folder, 'fake.png'), /not a PNG/],
    [path.join(folder, 'x.svg'), /Only PNG/], [path.join(folder, 'big.png'), /5 MB/], [path.join(folder, '..', 'outside.png'), /outside|folder/i]] as const) {
    const r = await attachImageFromPath({ folderPath: folder }, p);
    assert.equal(r.ok, false, p);
    if (!r.ok) assert.match(r.error, re, p);
  }
  assert.deepEqual(await attachImageFromPath({ folderPath: null }, outside), { ok: false, error: 'Choose a folder for this Cipher bot before attaching a file.', needFolder: true });
  await assert.rejects(readImageInFolder(folder, 'https://example.com/a.png'));
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg')), null);
  // image:get re-reads from the folder each time; both channels are behind the lock guard.
  assert.match(main, /handle\('image:get'[\s\S]*?readImageInFolder\(bot\.folderPath, m\.image\)[\s\S]*?toDataUrl/);
  for (const ch of ['image:get', 'image:dropped', 'messages:pin', 'mute:set', 'update:download', 'update:get', 'debug:export']) assert.equal(UNLOCKED_CHANNELS.has(ch), false, ch);
});

test('5. starter jobs: Writer, Researcher, Files, Blank, local presets with Liz\'s icons; 6. shortcut list', () => {
  assert.deepEqual(STARTER_JOBS.map((j) => j.label), ['Writer', 'Researcher', 'Files', 'Blank']);
  for (const j of STARTER_JOBS) assert.ok(fs.existsSync(path.join(root, 'src/renderer', j.icon)), j.icon);
  assert.equal(STARTER_JOBS[3].job, '');
  assert.match(html, /id="starter-jobs"/);
  assert.ok(SHORTCUTS.some((s) => s.keys === 'Enter') && SHORTCUTS.some((s) => s.keys === 'Shift+Enter'));
  assert.match(html, /<h3>Keyboard shortcuts<\/h3>\s*<dl id="shortcut-list"/);
  for (const icon of ['pin', 'mute', 'quote']) assert.ok(fs.existsSync(path.join(root, `src/renderer/assets/cipher-${icon}.svg`)));
  const css = read('src/renderer/styles.css');
  assert.match(css, /\.msg-act img \{ width: 20px; height: 20px;/);
});

test('7. debug log: no chats unless ticked, redacted paths and queries, never lock data, pairing codes or memory notes', () => {
  const home = '/home/alice';
  assert.equal(redact('failed to read /home/alice/Docs/secret-plans.txt', home), 'failed to read <path:…/secret-plans.txt>');
  assert.equal(redact('GET https://html.duckduckgo.com/html/?q=private+words#x'), 'GET https://html.duckduckgo.com/html/?<redacted>');
  assert.match(redact('code=123456 token: abc'), /code=<redacted> token=<redacted>/);
  assert.equal(stripQuoted('search failed for "ostrich velvet"'), 'search failed for <text>');
  clearLogLines();
  recordLogLine('error', ['boom at /home/alice/x/y.txt', new Error('bad "my words"')]);
  const facts: DebugFacts = { appVersion: '1.20.0', electron: '44', chrome: '1', node: '22', platform: 'linux', arch: 'x64', osRelease: '6', schemaVersion: 10,
    model: 'm', online: false, locked: false, lockEnabled: true, phoneRunning: false, setupPhase: 'ready', counts: { bots: 1 }, prefs: { showTimes: true }, lastUpdateCheck: null };
  const plain = buildDebugLog(facts, recentLogLines());
  assert.match(plain, /Chat content: not included\./);
  assert.doesNotMatch(plain, /my words|\/x\/y\.txt/);
  const withChats = buildDebugLog(facts, recentLogLines(), [{ title: 'Ada: Chat', messages: [{ role: 'user', content: 'hello there', createdAt: 't' }] }]);
  assert.match(withChats, /user: hello there/);
  // What main collects: only when the box is ticked are chats read; never the lock file, passphrase, pairing code, memory or history.
  const exp = /handle\('debug:export'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(exp, /includeChats === true\s*\?/);
  assert.doesNotMatch(exp, /lock\.json|LockStore|passphrase|hash|pairingCode|memoryNote|listSearchHistory|folderPath\b(?!\))|LAST_SEARCH/);
  assert.match(exp, /phone\.status\(\)\.running/);
  assert.match(exp, /appLock\.state\(\)\.enabled/);
});

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.21', draft: false, prerelease: false,
  assets: [{ name: 'cipher_1.21.0_amd64.deb', size: 6, browser_download_url: 'https://github.com/jds1985/Cipher_bot/releases/download/v1.21/cipher_1.21.0_amd64.deb', digest: null }],
  ...over,
});

test('8. update URLs: only the one API URL, the repo\'s release .deb, and GitHub\'s release download host; Online required', () => {
  assert.equal(UPDATE_API_URL, 'https://api.github.com/repos/jds1985/Cipher_bot/releases/latest');
  assert.throws(() => assertUpdateUrlAllowed(false, UPDATE_API_URL, 'api'), /Online is off/);
  assertUpdateUrlAllowed(true, UPDATE_API_URL, 'api');
  for (const bad of ['https://api.github.com/repos/other/x/releases/latest', 'http://api.github.com/repos/jds1985/Cipher_bot/releases/latest', `${UPDATE_API_URL}?x=1`]) {
    assert.throws(() => assertUpdateUrlAllowed(true, bad, 'api'), /./, bad);
  }
  const deb = 'https://github.com/jds1985/Cipher_bot/releases/download/v1.21/cipher_1.21.0_amd64.deb';
  assertUpdateUrlAllowed(true, deb, 'release');
  assert.throws(() => assertUpdateUrlAllowed(true, 'https://github.com/evil/Cipher_bot/releases/download/v1/cipher_1.0.0_amd64.deb', 'release'));
  assert.throws(() => assertUpdateUrlAllowed(true, 'https://github.com/jds1985/Cipher_bot/releases/download/v1/evil.sh', 'release'));
  assert.deepEqual([...RELEASE_DOWNLOAD_HOSTS], ['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  assertUpdateUrlAllowed(true, 'https://release-assets.githubusercontent.com/abc?sig=1', 'asset');
  assertUpdateUrlAllowed(true, 'https://objects.githubusercontent.com/abc', 'asset');
  for (const bad of ['https://evil.com/x.deb', 'https://githubusercontent.com.evil.com/x', 'http://objects.githubusercontent.com/x', 'https://objects.githubusercontent.com:8443/x']) {
    assert.throws(() => assertUpdateUrlAllowed(true, bad, 'asset'), /./, bad);
  }
  assert.throws(() => assertUpdateUrlAllowed(false, 'https://objects.githubusercontent.com/abc', 'asset'), /Online is off/);
});

test('8. update check: versions, once per 24 h, picks only this repo\'s .deb with its digest', () => {
  assert.deepEqual(parseVersion('v1.19'), [1, 19, 0]);
  assert.equal(isNewer('1.21.0', '1.20.0'), true);
  assert.equal(isNewer('1.20.0', '1.20.0'), false);
  assert.equal(isNewer('1.9.0', '1.20.0'), false);
  const now = Date.parse('2026-10-12T18:00:00Z');
  assert.equal(isCheckDue(null, now), true);
  assert.equal(isCheckDue(new Date(now - CHECK_INTERVAL_MS + 60_000).toISOString(), now), false);
  assert.equal(isCheckDue(new Date(now - CHECK_INTERVAL_MS).toISOString(), now), true);
  assert.equal(isCheckDue(new Date(now + 86_400_000).toISOString(), now), true, 'clock went back');
  assert.equal(pickDeb(release())!.url, 'https://github.com/jds1985/Cipher_bot/releases/download/v1.21/cipher_1.21.0_amd64.deb');
  const sha = 'a'.repeat(64);
  assert.equal(pickDeb(release({ assets: [{ ...release().assets[0], digest: `sha256:${sha}` }] }))!.sha256, sha);
  assert.equal(pickDeb(release({ assets: [{ ...release().assets[0], browser_download_url: 'https://evil.com/cipher_1.21.0_amd64.deb' }] })), null);
  assert.equal(pickDeb(release({ assets: [{ ...release().assets[0], name: 'cipher_1.21.0_amd64.AppImage' }] })), null);
  assert.equal(pickDeb(release({ prerelease: true })), null);
  assert.equal(pickDeb(release({ draft: true })), null);
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as unknown as typeof fetch };
}

test('8. checkForUpdate: nothing goes out with Online off; GET only to the API, manual redirects, no cookies', async () => {
  const f = fakeFetch(() => new Response(JSON.stringify(release()), { status: 200 }));
  await assert.rejects(checkForUpdate('1.20.0', { isOnline: () => false, fetchImpl: f.fetchImpl }), /Online is off/);
  assert.equal(f.calls.length, 0);
  const info = await checkForUpdate('1.20.0', { isOnline: () => true, fetchImpl: f.fetchImpl });
  assert.equal(info!.version, '1.21.0');
  assert.equal(f.calls[0].url, UPDATE_API_URL);
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(await checkForUpdate('1.21.0', { isOnline: () => true, fetchImpl: f.fetchImpl }), null, 'not newer');
  let online = true;
  const g = fakeFetch(() => { online = false; return new Response('{}', { status: 200 }); });
  await assert.rejects(checkForUpdate('1.20.0', { isOnline: () => online, fetchImpl: g.fetchImpl }), /Online is off/);
  await assert.rejects(checkForUpdate('1.20.0', { isOnline: () => true, fetchImpl: fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://evil.com' } })).fetchImpl }), /302/);
});

const debInfo = (body: Buffer, sha: string | null): UpdateInfo => ({
  version: '1.21.0', tag: 'v1.21', name: 'cipher_1.21.0_amd64.deb', size: body.length, sha256: sha, pageUrl: '',
  url: 'https://github.com/jds1985/Cipher_bot/releases/download/v1.21/cipher_1.21.0_amd64.deb',
});

test('8. download: GitHub hosts only (redirects re-checked), size and digest verified, saved without overwrite, no install', async () => {
  const body = Buffer.from('DEBDATA-1234');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const dir = fs.mkdtempSync(path.join(base, 'dl-'));
  const route = (url: string) => url.startsWith('https://github.com/')
    ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/x?sig=1' } })
    : new Response(body, { status: 200 });
  const f = fakeFetch(route);
  const saved = await downloadUpdate(debInfo(body, sha), dir, { isOnline: () => true, fetchImpl: f.fetchImpl });
  assert.equal(path.basename(saved), 'cipher_1.21.0_amd64.deb');
  assert.deepEqual(fs.readFileSync(saved), body);
  assert.deepEqual(f.calls.map((c) => new URL(c.url).hostname), ['github.com', 'release-assets.githubusercontent.com']);
  assert.ok(f.calls.every((c) => c.init.redirect === 'manual'));
  const again = await downloadUpdate(debInfo(body, sha), dir, { isOnline: () => true, fetchImpl: fakeFetch(route).fetchImpl });
  assert.equal(path.basename(again), 'cipher_1.21.0_amd64 (1).deb', 'never overwrites');
  // Redirect to another host: refused before any request goes there.
  const evil = fakeFetch((url) => url.startsWith('https://github.com/') ? new Response(null, { status: 302, headers: { location: 'https://evil.example/x.deb' } }) : new Response(body));
  await assert.rejects(downloadUpdate(debInfo(body, sha), dir, { isOnline: () => true, fetchImpl: evil.fetchImpl }), /evil\.example; refused/);
  assert.equal(evil.calls.length, 1);
  await assert.rejects(downloadUpdate(debInfo(body, 'b'.repeat(64)), dir, { isOnline: () => true, fetchImpl: fakeFetch(route).fetchImpl }), /checksum/);
  await assert.rejects(downloadUpdate({ ...debInfo(body, null), size: body.length + 5 }, dir, { isOnline: () => true, fetchImpl: fakeFetch(route).fetchImpl }), /incomplete/);
  await assert.rejects(downloadUpdate({ ...debInfo(body, null), size: 3 }, dir, { isOnline: () => true, fetchImpl: fakeFetch(route).fetchImpl }), /larger than expected/);
  await assert.rejects(downloadUpdate({ ...debInfo(body, null), url: 'https://evil.com/cipher_1.21.0_amd64.deb' }, dir, { isOnline: () => true, fetchImpl: fakeFetch(route).fetchImpl }), /not a Cipher Bot release/);
  await assert.rejects(downloadUpdate(debInfo(body, sha), dir, { isOnline: () => false, fetchImpl: fakeFetch(route).fetchImpl }), /Online is off/);
  // Online off partway: stopped, partial file removed.
  let online = true;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(4)); online = false; },
  });
  await assert.rejects(downloadUpdate({ ...debInfo(Buffer.alloc(40), null) }, dir, { isOnline: () => online, fetchImpl: fakeFetch((u) => u.startsWith('https://github.com/') ? new Response(stream, { status: 200 }) : new Response('')).fetchImpl }), /Online was turned off/);
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.part')), []);
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.doesNotMatch(read('src/main/updateCheck.ts'), /child_process|\bspawn\b|(?<!\.)\bexec\(|openPath|\bdpkg\b|\bapt(-get)?\b/);
});

test('8. main: timer acts only with Online on and when due; Online re-checked before sending; Online off/lock aborts; confirm first; phone cannot', () => {
  const check = fn('maybeCheckForUpdate');
  assert.match(check, /if \(!isOnline\(\) \|\| updateController \|\| !isCheckDue\(db\.getSetting\(UPDATE_LAST_CHECK_KEY\), Date\.now\(\)\)\) return;/);
  assert.match(check, /if \(!isOnline\(\)\) return;\s*db\.setSetting\(UPDATE_LAST_CHECK_KEY/);
  assert.match(check, /checkForUpdate\(app\.getVersion\(\), \{ isOnline, signal: controller\.signal \}\)/);
  assert.match(fn('killSearch'), /killUpdate\(\);/);
  assert.match(main, /if \(!value\) killSearch\(\);/);
  const dl = /handle\('update:download'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(dl, /dialog\.showMessageBox[\s\S]*?if \(r\.response !== 1 \|\| !isOnline\(\)\) return updateState\(\);[\s\S]*?downloadUpdate\(info, app\.getPath\('downloads'\)/);
  assert.doesNotMatch(dl, /openPath|spawn|exec/);
  assert.match(phone, /\/\^\\\/api\\\/\(online\|settings\|update\|debug\)\(\\\/\|\$\)\/i/);
  assert.doesNotMatch(phone + phoneApp, /update:|checkForUpdate|downloadUpdate/);
  assert.match(policy, /Only while Online is on, Cipher Bot checks for a newer release at most once a day: it sends one request to GitHub \(api\.github\.com\)/);
  assert.match(policy, /never installs it/);
});

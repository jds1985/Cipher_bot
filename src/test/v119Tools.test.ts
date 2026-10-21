import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { calculate, runCalculator, CALCULATOR_TOOL } from '../main/calculator';
import { assertPageUrl, fetchPageText, formatPageBlock, guardedLookup, isBlockedAddress, PAGE_BLOCK_START, PAGE_MAX_BYTES } from '../main/pageFetch';
import { SearchConsent } from '../main/searchConsent';
import { parseBlocks, parseInline } from '../renderer/markdownParse';
import { CipherDb, MEMORY_NOTE_MAX, SCHEMA_VERSION } from '../main/db';
import { buildHistory, memoryBlock } from '../main/chatEngine';
import { PhoneServer } from '../main/phoneServer';
import { restoreDatabase } from '../main/backup';
import { ONLINE_SETTING_KEY, onlineSettingValue, parseOnlineSetting } from '../main/networkGuard';
import { plusMenuItems } from '../renderer/view';
import { UNLOCKED_CHANNELS } from '../main/lock';
import { TEST_MODEL } from './fakeCipher';

// v1.19: page as text, search history, markdown, memory notes, phone confirm, multi-delete, calculator, backup.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const renderer = read('src/renderer/renderer.ts');
const md = read('src/renderer/markdown.ts') + read('src/renderer/markdownParse.ts');
const html = read('src/renderer/index.html');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v119-')));
let n = 0;
const tmpDb = () => path.join(base, `t${++n}.db`);

// ---------- 7. calculator ----------
test('7. calculator: precedence, power, functions, errors; own parser (no eval, no Function, no network)', () => {
  assert.equal(calculate('1 + 2 * 3'), 7);
  assert.equal(calculate('(1 + 2) * 3'), 9);
  assert.equal(calculate('2 ^ 3 ^ 2'), 512);
  assert.equal(calculate('-2 ^ 2'), -4);
  assert.equal(calculate('10 % 4 + 7 / 2'), 5.5);
  assert.equal(calculate('sqrt(16) + abs(-3) + max(1, 9, 4) + min(2, 5)'), 18);
  assert.ok(Math.abs(calculate('2 * pi') - 2 * Math.PI) < 1e-12);
  assert.equal(calculate('1.5e3 / 3'), 500);
  assert.equal(calculate('6 × 7 ÷ 2'), 21);
  for (const bad of ['', '1 +', '2 / 0', 'process.exit(1)', 'constructor', 'alert(1)', '__proto__', '1;2', '"a"', '[1]', 'x'.repeat(201), '(((1)']) {
    assert.throws(() => calculate(bad), Error, bad);
  }
  assert.throws(() => calculate({}), /text/);
  assert.equal(runCalculator({ expression: '0.1 + 0.2' }).content, '0.1 + 0.2 = 0.3');
  assert.equal(runCalculator('{"expression":"3*4"}').content, '3*4 = 12');
  assert.match(runCalculator({ expression: '1/0' }).content, /^Error: Division by zero/);
  const src = read('src/main/calculator.ts');
  assert.doesNotMatch(src, /\beval\s*\(|new Function|Function\(|require\(|import\(|fetch|http/);
  assert.equal(CALCULATOR_TOOL.function.name, 'calculator');
  const engine = read('src/main/chatEngine.ts');
  // v1.23: offered only while allowed (its switch on; never for routines, reminders only if switched on).
  assert.match(engine, /\.\.\.\(allowed\('calculator'\) \? \[CALCULATOR_TOOL\] : \[\]\)/);
  assert.match(engine, /case 'calculator': return t\.calculator && \(!deps\.fromRoutine \|\| deps\.reminder === true\);/);
});

// ---------- 1. page as text ----------
test('1. address checks: loopback, private, link-local, CGNAT, multicast and IPv6 local are refused', () => {
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '2003::1']) assert.equal(isBlockedAddress(ip), false, ip);
  for (const u of ['file:///etc/passwd', 'ftp://x.test/', 'javascript:alert(1)', 'https://u:p@x.test/', 'nope', 'http://127.0.0.1/', 'http://[::1]:8080/',
    'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://printer.local/', 'http://0x7f000001/', 'http://2130706433/']) assert.throws(() => assertPageUrl(u), Error, u);
  assert.equal(assertPageUrl('https://example.com/a').hostname, 'example.com');
});

test('1. guardedLookup refuses a host that resolves to a private address (checked on the address used to connect)', async () => {
  const fakeDns = (map: Record<string, string[]>) => ((host: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, (map[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as never;
  const look = guardedLookup(fakeDns({ 'evil.test': ['93.184.216.34', '10.0.0.5'], 'ok.test': ['93.184.216.34'], 'meta.test': ['169.254.169.254'] }));
  const run = (h: string) => new Promise<string>((res) => look(h, {}, (err, a) => res(err ? `ERR ${(err as NodeJS.ErrnoException).code}` : String(a))));
  assert.equal(await run('ok.test'), '93.184.216.34');
  assert.equal(await run('evil.test'), 'ERR EBLOCKED', 'any private answer refuses (no DNS-rebinding pick)');
  assert.equal(await run('meta.test'), 'ERR EBLOCKED');
  assert.equal(await run('none.test'), 'ERR ENOTFOUND');
});

test('1. a real request to a loopback server is refused before connecting', async () => {
  let hits = 0;
  const srv = http.createServer((_q, r) => { hits++; r.end('<p>local secret</p>'); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    for (const host of ['127.0.0.1', 'localhost']) {
      const url = `http://${host}:${port}/`;
      const c = new SearchConsent();
      const t = c.issue(1, url);
      await assert.rejects(fetchPageText(url, { isOnline: () => true, consumeConsent: (u) => c.consume(t, 1, u) }), /private network|refused/);
    }
    assert.equal(hits, 0);
  } finally { srv.close(); }
});

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
/** Fake network that, like Node, resolves the host through opts.lookup first. */
function fakeNet(pages: Record<string, Res>, dnsMap: Record<string, string>, log: string[]) {
  const baseDns = ((h: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, dnsMap[h] ? [{ address: dnsMap[h], family: 4 }] : [])) as never;
  return {
    lookup: baseDns,
    request: (u: URL, opts: http.RequestOptions) => new Promise<Res>((resolve, reject) => {
      (opts.lookup as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)(u.hostname, {}, (err) => {
        if (err) return reject(err);
        log.push(u.toString());
        resolve(pages[u.toString()] ?? { status: 404, headers: {}, body: Buffer.from('') });
      });
    }),
  };
}
const htmlRes = (s: string): Res => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(s) });

test('1. fetchPageText: one-time token for the exact URL, Online checked at send time, redirects re-checked, text only, size cap', async () => {
  const page = '<html><head><title>Hi &amp; bye</title><script src="https://x.test/a.js"></script></head><body><h1>Head</h1><script>alert(1)</script><img src="https://x.test/i.png"><p>Body <a href="https://x.test/">link</a></p></body></html>';
  const log: string[] = [];
  const netw = fakeNet({
    'https://pub.test/a': htmlRes(page),
    'https://pub.test/r-private': { status: 302, headers: { location: 'http://intranet.test/admin' }, body: Buffer.from('') },
    'https://pub.test/r-file': { status: 301, headers: { location: 'file:///etc/passwd' }, body: Buffer.from('') },
    'https://pub.test/r-ok': { status: 302, headers: { location: '/a' }, body: Buffer.from('') },
    'https://pub.test/loop': { status: 302, headers: { location: '/loop' }, body: Buffer.from('') },
    'https://pub.test/pdf': { status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF') },
    'https://pub.test/big': { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(PAGE_MAX_BYTES + 1, 97) },
  }, { 'pub.test': '93.184.216.34', 'intranet.test': '192.168.0.10' }, log);
  const c = new SearchConsent();
  const go = (url: string, tok = c.issue(5, url), online = () => true) => fetchPageText(url, { isOnline: online, consumeConsent: (u) => c.consume(tok, 5, u), ...netw });
  const r = await go('https://pub.test/a');
  assert.equal(r.title, 'Hi & bye');
  assert.match(r.text, /Head\nBody link/);
  assert.doesNotMatch(r.text, /alert|script|x\.test|<img|<a /);
  const block = formatPageBlock(r);
  assert.ok(block.startsWith(`${PAGE_BLOCK_START}https://pub.test/a ---\nTitle: Hi & bye`));
  // Token: single-use, exact URL, and required.
  const tok = c.issue(5, 'https://pub.test/a');
  await go('https://pub.test/a', tok);
  await assert.rejects(go('https://pub.test/a', tok), /not confirmed/);
  await assert.rejects(go('https://pub.test/a', c.issue(5, 'https://pub.test/b')), /not confirmed/);
  await assert.rejects(go('https://pub.test/a', c.issue(6, 'https://pub.test/a')), /not confirmed/, 'other chat');
  // Online off: nothing is requested.
  const before = log.length;
  await assert.rejects(go('https://pub.test/a', c.issue(5, 'https://pub.test/a'), () => false), /Online is off/);
  assert.equal(log.length, before);
  // Redirects: re-checked every hop.
  await assert.rejects(go('https://pub.test/r-private'), /private network/);
  assert.ok(!log.some((u) => u.includes('intranet')));
  await assert.rejects(go('https://pub.test/r-file'), /Only web pages/);
  assert.match((await go('https://pub.test/r-ok')).text, /Body link/);
  await assert.rejects(go('https://pub.test/loop'), /Too many redirects/);
  await assert.rejects(go('https://pub.test/pdf'), /only HTML and plain text/);
  await assert.rejects(go('https://pub.test/big'), /larger than 1 MB/);
});

test('1. main: page:open only for stored result links, asks first (URL shown), token after confirm, Online off aborts it', () => {
  const h = /handle\('page:open'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  const order = ['assertLinkOpenAllowed(isOnline(), url)', 'db.isStoredResultUrl(url)', 'dialog.showMessageBox', 'if (!isOnline() || isLocked())', 'pageConsent.issue(chatId, target)', 'activeSearches.add(controller)', 'fetchPageText(target'];
  let at = -1;
  for (const s of order) { const i = h.indexOf(s); assert.ok(i > at, s); at = i; }
  assert.match(h, /detail: `\$\{target\}/);
  assert.match(h, /the site sees your IP address/);
  assert.match(h, /consumeConsent: \(u\) => pageConsent\.consume\(token, chatId, u\)/);
  assert.match(/function killSearch\(\): void \{[\s\S]*?\n\}/.exec(main)![0], /pageConsent\.revokeAll\(\);/);
  assert.equal(UNLOCKED_CHANNELS.has('page:open'), false);
  // Only main fetches: the renderer still cannot connect, CSP unchanged.
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(renderer + md, /\bfetch\(|XMLHttpRequest|WebSocket/);
  const mainDir = path.join(root, 'src/main');
  for (const f of fs.readdirSync(mainDir)) {
    const src = fs.readFileSync(path.join(mainDir, f), 'utf8');
    if (/\b(https?)\.request\(/.test(src)) assert.equal(f, 'pageFetch.ts', f);
  }
});

// ---------- 3. markdown ----------
test('3. markdown: bold, italic, code, lists, code blocks, links; raw HTML stays text; no images; links go to main', () => {
  assert.deepEqual(parseInline('a **b** *c* `d` [e](https://e.test/x) https://f.test/y.'), [
    { k: 'text', s: 'a ' }, { k: 'bold', s: 'b' }, { k: 'text', s: ' ' }, { k: 'em', s: 'c' }, { k: 'text', s: ' ' }, { k: 'code', s: 'd' },
    { k: 'text', s: ' ' }, { k: 'link', s: 'e', url: 'https://e.test/x' }, { k: 'text', s: ' ' }, { k: 'link', s: 'https://f.test/y', url: 'https://f.test/y' }, { k: 'text', s: '.' },
  ]);
  assert.deepEqual(parseInline('<script>alert(1)</script><img src=x onerror=y>'), [{ k: 'text', s: '<script>alert(1)</script><img src=x onerror=y>' }]);
  assert.deepEqual(parseInline('[x](javascript:alert(1))').filter((s) => s.k === 'link'), []);
  assert.ok(parseInline('![pic](https://x.test/a.png)').every((s) => s.k === 'text' || s.k === 'link'), 'an image is at most a link, never loaded');
  assert.deepEqual(parseBlocks('Hi\n\n- one\n- two\n1. a\n2. b\n```js\nconst x = 1;\n<b>\n```\n# Title'), [
    { k: 'p', lines: ['Hi'] }, { k: 'ul', items: ['one', 'two'] }, { k: 'ol', items: ['a', 'b'] },
    { k: 'code', lang: 'js', text: 'const x = 1;\n<b>' }, { k: 'h', level: 1, text: 'Title' },
  ]);
  // DOM building: textContent only; the only <img> is the fixed copy icon; links are buttons calling onLink.
  assert.doesNotMatch(md, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|\.style\b|href\s*=|window\.open|location/);
  assert.equal((md.match(/createElement\('img'\)/g) ?? []).length, 1);
  assert.match(md, /icon\.src = 'assets\/cipher-copy-code\.svg'/);
  assert.match(md, /b\.addEventListener\('click', \(e\) => \{ e\.preventDefault\(\); o\.onLink\(s\.url\); \}\)/);
  assert.match(renderer, /onLink: \(url: string\) => void api\.openLink\(url, true\)/);
  assert.match(renderer, /onCopy: \(text: string\) => void api\.copyText\(text\)/);
  const open = /handle\('link:open'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(open, /assertLinkOpenAllowed\(isOnline\(\), url\);\s*if \(!db\.isStoredResultUrl\(url\)\) throw[\s\S]*?if \(confirm === true\)[\s\S]*?showMessageBox[\s\S]*?if \(r\.response !== 1\) return;[\s\S]*?await shell\.openExternal\(url\);/);
  assert.match(main, /win\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\);/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  const css = read('src/renderer/styles.css');
  assert.match(css, /\.md \.md-code pre/);
  assert.match(css, /\.md-copy/);
});

// ---------- 4. memory notes, 2. search history, 6. multi-delete (cipher.db, really deleted) ----------
function fileHas(file: string, needle: string): boolean {
  for (const f of [file, `${file}-wal`]) if (fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(needle))) return true;
  return false;
}

test('4. memory note: stored in cipher.db (v9 migration), in the system prompt every chat, capped, and really deleted on clear', () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  assert.equal(SCHEMA_VERSION, 14);
  const bot = db.createBot({ name: 'Ada', systemPrompt: 'Be brief.', toolsEnabled: false, folderPath: null });
  assert.equal(bot.memoryNote, '');
  const withNote = db.setBotMemory(bot.id, '  I live in Zanzibar-Quokka-77.  ');
  assert.equal(withNote.memoryNote, 'I live in Zanzibar-Quokka-77.');
  const sys = buildHistory(withNote, [], TEST_MODEL)[0].content as string;
  assert.match(sys, /^You are Cipher, a helpful AI assistant\.\n\nYour name is Ada\.\n\nBe brief\.\n\nRemember: I live in Zanzibar-Quokka-77\.$/);
  assert.equal(memoryBlock(''), '');
  assert.throws(() => db.setBotMemory(bot.id, 'x'.repeat(MEMORY_NOTE_MAX + 1)), /longer/);
  assert.throws(() => db.setBotMemory(bot.id, 5), /text/);
  assert.ok(fileHas(file, 'Zanzibar-Quokka-77'));
  db.setBotMemory(bot.id, '');
  assert.equal(db.getBot(bot.id)!.memoryNote, '');
  assert.equal(fileHas(file, 'Zanzibar-Quokka-77'), false, 'gone from cipher.db and its WAL');
  db.close();
  assert.match(main, /handle\('bots:setMemory', \(_e, botId: unknown, note: unknown\) => db\.setBotMemory\(asId\(botId\), note\)\);/);
  assert.match(html, /id="bot-memory-wrap"[\s\S]*?assets\/cipher-memory\.svg[\s\S]*?id="bot-memory"/);
});

test('4. migration v8 → v9: memory_note and search_history added, data kept, idempotent', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: 'Old', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.close();
  const raw = new Database(file);
  raw.exec('ALTER TABLE bots DROP COLUMN memory_note; DROP TABLE search_history');
  raw.pragma('user_version = 8');
  raw.close();
  db = new CipherDb(file);
  assert.equal(db.getBot(bot.id)!.memoryNote, '');
  assert.deepEqual(db.listSearchHistory(), []);
  db.close();
  new CipherDb(file).close();
  const chk = new Database(file);
  assert.equal(chk.pragma('user_version', { simple: true }), 14);
  chk.close();
});

test('2. search history: recorded when a search is sent, newest first, capped, really deleted by Clear', () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  db.addSearchHistory('ostrich-velvet-31 recipes', '2026-10-12T10:00:00.000Z');
  db.addSearchHistory('second', '2026-10-12T11:00:00.000Z');
  assert.deepEqual(db.listSearchHistory().map((h) => h.query), ['second', 'ostrich-velvet-31 recipes']);
  for (let i = 0; i < 250; i++) db.addSearchHistory(`q${i}`, '2026-10-12T12:00:00.000Z');
  assert.equal(db.listSearchHistory().length, 200);
  db.addSearchHistory('ostrich-velvet-31 again', '2026-10-12T13:00:00.000Z');
  assert.ok(fileHas(file, 'ostrich-velvet-31 again'));
  db.clearSearchHistory();
  assert.deepEqual(db.listSearchHistory(), []);
  assert.equal(fileHas(file, 'ostrich-velvet-31'), false, 'gone from cipher.db and its WAL');
  db.close();
  assert.match(main, /db\.addSearchHistory\(query, at\)/);
  assert.match(main, /handle\('search:clearHistory', \(\) => \{ db\.clearSearchHistory\(\); return db\.listSearchHistory\(\); \}\);/);
  assert.match(html, /assets\/cipher-search-history\.svg[\s\S]*?<ol id="search-history"[\s\S]*?id="search-history-clear"/);
  assert.match(renderer, /el\.searchHistoryClear\.addEventListener\('click', \(\) => void api\.clearSearchHistory\(\)/);
});

test('6. multi-select delete: one confirm in main; only that chat\'s messages; really deleted', () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  const bot = db.createBot({ name: 'A', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const c1 = db.createChat(bot.id);
  const c2 = db.createChat(bot.id);
  const a = db.addMessage({ chatId: c1.id, role: 'user', content: 'keep me' });
  const b = db.addMessage({ chatId: c1.id, role: 'assistant', content: 'pelican-mango-55 secret' });
  const c = db.addMessage({ chatId: c1.id, role: 'user', content: 'also delete' });
  const other = db.addMessage({ chatId: c2.id, role: 'user', content: 'other chat' });
  assert.equal(db.deleteMessages(c1.id, [b.id, c.id, other.id, -1, 'x' as never]), 2);
  assert.deepEqual(db.listMessages(c1.id).map((m) => m.id), [a.id]);
  assert.equal(db.listMessages(c2.id).length, 1);
  assert.equal(db.deleteMessages(c1.id, 'nope' as never), 0);
  assert.equal(fileHas(file, 'pelican-mango-55'), false);
  db.close();
  const h = /handle\('messages:delete'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(h, /if \(activeTurns\.has\(chatId\)\) throw/);
  assert.match(h, /Delete \$\{ids\.length\} message[\s\S]*?showMessageBox[\s\S]*?if \(r\.response !== 1\) return \{ deleted: 0, canceled: true \};\s*const undoId = beginUndo\(\);\s*const deleted = db\.softDeleteMessages\(chatId, ids, undoId\);/);
  assert.deepEqual(plusMenuItems({ kind: 'bot', toolsEnabled: false, folderPath: null, busy: false, routineTime: null }).find((i) => i.id === 'select'),
    { id: 'select', label: 'Select messages…', disabled: false });
  assert.match(html, /<div id="select-bar" class="select-bar" hidden>/);
});

// ---------- 5. phone ----------
test('5. phone: Online can never be read or changed; only a paired, unlocked session can answer a card main put up', async () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  const bot = db.createBot({ name: 'P', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  let locked = false;
  const answers: [string, boolean][] = [];
  const port = 28950 + Math.floor(Math.random() * 40);
  const server = new PhoneServer({
    db, staticDir: path.join(root, 'src/phone'), model: 'fake', port, isLocked: () => locked,
    sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {},
    answerSearch: (id, ok) => answers.push([id, ok]),
    pendingSearches: (chatId) => (chatId === chat.id ? [{ id: 's1', query: 'cats' }] : []),
  });
  server.start();
  await server.whenListening();
  const baseUrl = `http://127.0.0.1:${port}`;
  const call = async (p: string, method = 'GET', body?: unknown, token?: string) => {
    const r = await fetch(baseUrl + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  try {
    const pair = await call('/api/pair', 'POST', { code: server.status().pairingCode });
    const token = pair.body.token as string;
    for (const [p, m] of [['/api/online', 'GET'], ['/api/online', 'POST'], ['/api/online/set', 'POST'], ['/api/settings/online', 'PUT']] as const) {
      assert.equal((await call(p, m, { on: true }, token)).status, 403, `${m} ${p}`);
      assert.equal((await call(p, m, { on: true })).status, 403);
    }
    assert.equal(parseOnlineSetting(db.getSetting(ONLINE_SETTING_KEY)), false);
    assert.equal((await call('/api/search/answer', 'POST', { id: 's1', ok: true })).status, 401, 'unpaired');
    assert.equal((await call('/api/search/answer', 'POST', { id: 's1', ok: true }, 'forged')).status, 401);
    const chatGet = await call(`/api/bots/${bot.id}/chat`, 'GET', undefined, token);
    assert.deepEqual(chatGet.body.searchAsks, [{ id: 's1', query: 'cats' }]);
    assert.equal((await call('/api/search/answer', 'POST', { id: 's1', ok: true }, token)).status, 200);
    assert.equal((await call('/api/search/answer', 'POST', { id: 's2', ok: 'yes' }, token)).status, 200);
    assert.deepEqual(answers, [['s1', true], ['s2', false]], 'only a literal true counts as Search');
    locked = true;
    assert.equal((await call('/api/search/answer', 'POST', { id: 's1', ok: true }, token)).status, 423);
    assert.equal(answers.length, 2);
  } finally {
    server.stop();
    db.close();
  }
  // main: the phone answers through the same function; only main's pending ask gets a token; lock/Online off close it.
  assert.match(main, /answerSearch: \(id, ok\) => answerSearchAsk\(id, ok\),/);
  assert.match(main, /phone\?\.pushSearchAsk\(\{ id, chatId, query \}\);/);
  assert.match(main, /function settleSearchAsk[\s\S]*?phone\?\.pushSearchClosed\(id, ask\.chatId\);/);
  const app = read('src/phone/app.js');
  assert.match(app, /if \(d\.type === 'search:ask'\) showSearchAsk\(d\.id, d\.query\);\s*else if \(d\.type === 'search:closed'\) closeSearchAsk\(d\.id\);/);
  assert.doesNotMatch(app, /\/api\/online|setOnline/);
});

// ---------- 8. backup ----------
test('8. backup includes memory notes, routines and search history; restore keeps them, forces Online off, never touches the lock', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'bk-'));
  const src = path.join(dir, 'src.db');
  const a = new CipherDb(src);
  const bot = a.createBot({ name: 'Mem', systemPrompt: '', toolsEnabled: false, folderPath: null });
  a.setBotMemory(bot.id, 'Remember the walrus.');
  a.setRoutine(bot.id, { prompt: 'Daily plan?', time: '08:30', enabled: true });
  a.addSearchHistory('walrus facts', '2026-10-12T10:00:00.000Z');
  a.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(true));
  const backupFile = path.join(dir, 'backup.db');
  await a.backup(backupFile);
  a.close();
  const livePath = path.join(dir, 'cipher.db');
  const lockFile = path.join(dir, 'lock.json');
  fs.writeFileSync(lockFile, '{"hash":"keep-me"}');
  const live = new CipherDb(livePath);
  live.setSetting(ONLINE_SETTING_KEY, onlineSettingValue(true));
  await restoreDatabase({ live, livePath, source: backupFile });
  const r = new CipherDb(livePath);
  const b = r.listBots().find((x) => x.name === 'Mem')!;
  assert.equal(b.memoryNote, 'Remember the walrus.');
  assert.equal(r.getRoutine(b.id)?.prompt, 'Daily plan?');
  assert.deepEqual(r.listSearchHistory().map((h) => h.query), ['walrus facts']);
  assert.equal(parseOnlineSetting(r.getSetting(ONLINE_SETTING_KEY)), false, 'Online forced off');
  r.close();
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '{"hash":"keep-me"}');
  assert.doesNotMatch(read('src/main/backup.ts'), /lock\.json'|writeFile|unlink/);
});

test('policy and what\'s new describe v1.19 truthfully', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { POLICY_SECTIONS } = require('../renderer/policy.js') as { POLICY_SECTIONS: readonly { heading: string; paragraphs: string[] }[] };
  const all = POLICY_SECTIONS.map((s) => s.paragraphs.join('\n')).join('\n');
  assert.match(all, /so the site sees your computer's IP address/);
  assert.match(all, /never this computer or your local network, checked again on every redirect/);
  assert.match(all, /nothing on the page runs, and its images, styles and links are never loaded/);
  assert.match(all, /Clear search history deletes them for good/);
  assert.match(all, /Emptying the note deletes it from the database file/);
  assert.match(all, /never runs code and has no network access/);
  assert.match(all, /The phone can never turn Online on or off/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WHATS_NEW } = require('../renderer/whatsNew.js') as { WHATS_NEW: readonly string[] };
  assert.ok(WHATS_NEW.length <= 5);
  const pkg = JSON.parse(read('package.json')) as { name: string; productName: string; version: string; build: { productName: string } };
  assert.equal(pkg.version, '1.25.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher');
  assert.equal(pkg.build.productName, 'Cipher');
  assert.doesNotMatch(read('src/renderer/index.html') + renderer + read('src/renderer/policy.ts'), /\bGrok\b/);
});

test('IPv6 6to4 (2002::/16) is refused, including one wrapping a private IPv4', () => {
  for (const ip of ['2002::1', '2002:c0a8:0101::1', '2002:7f00:1::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) assert.equal(isBlockedAddress(ip), true, ip);
  assert.throws(() => assertPageUrl('http://[2002:c0a8:101::1]/'), /private network/);
});

test('IPv6 Teredo (2001::/32) is refused in every spelling; neighbours in 2001::/16 are not', () => {
  for (const ip of ['2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0000:abcd::1']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['2001:1::1', '2001:4860::8888']) assert.equal(isBlockedAddress(ip), false, ip);
  assert.throws(() => assertPageUrl('http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'), /private network/);
});

test('Settings: Last search and history reload on every open and whenever a search is sent (no stale time)', () => {
  const open = /function openSettings\(\): void \{[\s\S]*?\n\}/.exec(renderer)![0];
  assert.match(open, /refreshSearchInfo\(\);/);
  const refresh = /function refreshSearchInfo\(\): void \{[\s\S]*?\n\}/.exec(renderer)![0];
  assert.match(refresh, /api\.lastSearch\(\)\.then\(\(t\) => \{ state\.lastSearch = t; if \(state\.settingsOpen\) renderSettings\(\); \}\)/);
  assert.match(refresh, /api\.searchHistory\(\)\.then\(renderSearchHistory\)/);
  assert.match(renderer, /api\.onSearchSent\(\(\) => refreshSearchInfo\(\)\);/);
  // Main announces each search right when it is sent (the same moment it stores the time), with the time only.
  assert.match(main, /db\.setSetting\(LAST_SEARCH_KEY, at\);\s*db\.addSearchHistory\(query, at\);\s*sendToWindow\('search:sent', \{ at \}\);/);
  assert.match(read('src/preload/preload.ts'), /ipcRenderer\.on\('search:sent', listener\)/);
  // The setting and the newest history row are written with the same timestamp, so they always agree.
  const db = new CipherDb(tmpDb());
  const at = '2026-10-12T16:20:00.000Z';
  db.setSetting('last_search_at', at);
  db.addSearchHistory('q', at);
  assert.equal(db.listSearchHistory()[0].searchedAt, db.getSetting('last_search_at'));
  db.close();
});

test('v1.19 icons are drawn at about 18-20px (CSS only; the artwork fills ~78% of its box)', () => {
  const css = read('src/renderer/styles.css');
  const px = (re: RegExp) => Number(re.exec(css)![1]);
  const box = px(/\.memory-title \.memory-icon, \.history-title \.history-icon \{ width: (\d+)px; height: \1px;/);
  const copy = px(/\.md-copy img \{ width: (\d+)px; height: \1px; \}/);
  for (const b of [box, copy]) { const drawn = b * 200 / 256; assert.ok(drawn >= 18 && drawn <= 20.5, `${b}px box draws ${drawn.toFixed(1)}px`); }
  for (const f of ['cipher-search-history', 'cipher-memory', 'cipher-copy-code']) assert.match(read(`src/renderer/assets/${f}.svg`), /viewBox="0 0 256 256"[\s\S]*M128 28 214 78v100l-86 50-86-50V78z/);
});

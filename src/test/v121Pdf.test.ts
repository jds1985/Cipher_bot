import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { isUrlBlocked, normalizeSite } from '../main/blockedSites';
import { MAX_PDF_BYTES, MAX_PDF_PAGES, PDF_OPTIONS, pdfBytesToText, readPdfInFolder } from '../main/pdfText';
import { executeToolCall } from '../main/readFileTool';
import { attachFromPath } from '../main/attachFile';
import { buildHistory, replyOptions, REPLY_LENGTH_HINT } from '../main/chatEngine';
import { streamChat } from '../main/ollama';
import { fetchPageText } from '../main/pageFetch';
import { chatMarkdown } from '../main/chatMarkdown';
import { SearchConsent } from '../main/searchConsent';
import { UNLOCKED_CHANNELS } from '../main/lock';
import { plusMenuItems, TIPS } from '../renderer/view';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';
import type { Message } from '../shared/types';

// v1.21: PDF text, archive, always on top, reply length, copy as Markdown, image viewer, blocked sites, first-run tips.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const renderer = read('src/renderer/renderer.ts');
const html = read('src/renderer/index.html');
const phone = read('src/main/phoneServer.ts');
const policy = POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v121-')));
let n = 0;
const tmpDb = () => path.join(base, `t${++n}.db`);

/** A small valid PDF, one Helvetica text line per page; optional OpenAction JavaScript (must never run). */
function makePdf(pages: string[], js = false): Buffer {
  const objs: string[] = [];
  const kids = pages.map((_p, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push(`<< /Type /Catalog /Pages 2 0 R${js ? ' /OpenAction << /S /JavaScript /JS (globalThis.pwned = 1; app.alert\\(1\\)) >>' : ''} >>`);
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    const s = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('version 1.21.0, schema 11, WHATS_NEW five lines or fewer, CSP unchanged, names unchanged', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.21.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher');
  assert.equal(SCHEMA_VERSION, 11);
  assert.ok(WHATS_NEW.length >= 1 && WHATS_NEW.length <= 5);
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(WHATS_NEW.join(' ') + policy + html, /grok/i);
});

test('1. PDF dependency: pdfjs-dist pinned, no install scripts (it or its optional canvas), native canvas left out of the package', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['pdfjs-dist'], '6.4.299');
  for (const dep of ['pdfjs-dist', '@napi-rs/canvas']) {
    const p = path.join(root, 'node_modules', dep, 'package.json');
    if (!fs.existsSync(p)) continue;
    const scripts = (JSON.parse(fs.readFileSync(p, 'utf8')).scripts ?? {}) as Record<string, string>;
    for (const k of ['preinstall', 'install', 'postinstall']) assert.equal(scripts[k], undefined, `${dep} ${k}`);
  }
  assert.ok(pkg.build.files.includes('!node_modules/@napi-rs/**'));
  assert.ok(pkg.build.files.some((f: string) => f.includes('cmaps,standard_fonts')), 'fonts and CMaps not shipped (never fetched either)');
});

test('1. PDF options: no eval, no worker from a URL, no font/CMap/wasm URLs, no font faces, no XFA, no streaming', () => {
  assert.equal(PDF_OPTIONS.isEvalSupported, false);
  assert.equal(PDF_OPTIONS.disableFontFace, true);
  assert.equal(PDF_OPTIONS.useSystemFonts, false);
  assert.equal(PDF_OPTIONS.enableXfa, false);
  for (const k of ['standardFontDataUrl', 'cMapUrl', 'wasmUrl', 'iccUrl'] as const) assert.equal(PDF_OPTIONS[k], undefined, k);
  assert.equal(PDF_OPTIONS.disableStream && PDF_OPTIONS.disableRange && PDF_OPTIONS.disableAutoFetch, true);
  const src = read('src/main/pdfText.ts');
  assert.match(src, /pdfjsWorker = require\('pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs'\)/);
  assert.doesNotMatch(src, /workerSrc|workerPort|https?:\/\/|fetch\(|new Function|eval\(/);
});

test('1. PDF text: pages read in main, offline (no fetch), JavaScript never runs', async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error('no network'); }) as typeof fetch;
  try {
    const r = await pdfBytesToText(makePdf(['Hello kitchen plan', 'Budget 4200 euros'], true));
    assert.equal(r.pages, 2);
    assert.match(r.text, /\[Page 1\]\nHello kitchen plan\n\n\[Page 2\]\nBudget 4200 euros/);
    assert.equal(r.truncated, false);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetches, 0);
  assert.equal((globalThis as { pwned?: unknown }).pwned, undefined);
});

test('1. PDF caps: page cap with a note, size cap, not-a-PDF, empty text', async () => {
  const many = await pdfBytesToText(makePdf(Array.from({ length: MAX_PDF_PAGES + 5 }, (_v, i) => `Page text ${i + 1}`)));
  assert.equal(many.truncated, true);
  assert.match(many.text, new RegExp(`Page text ${MAX_PDF_PAGES}\\b`));
  assert.doesNotMatch(many.text, new RegExp(`Page text ${MAX_PDF_PAGES + 1}\\b`));
  assert.match(many.text, /Only the first 50 of 55 pages/);
  await assert.rejects(pdfBytesToText(Buffer.alloc(MAX_PDF_BYTES + 1)), /larger than 10 MB/);
  await assert.rejects(pdfBytesToText(Buffer.from('just text, not a pdf')), /not a PDF/);
  await assert.rejects(pdfBytesToText(makePdf([''])), /No text found/);
});

test('1. PDF folder rules: Attach, drop and read_file read it inside the folder only (.., symlinks, outside refused)', async () => {
  const folder = fs.mkdtempSync(path.join(base, 'pdfs-'));
  fs.mkdirSync(path.join(folder, 'docs'));
  fs.writeFileSync(path.join(folder, 'docs', 'plan.pdf'), makePdf(['Quarterly plan']));
  const outside = path.join(base, 'secret.pdf');
  fs.writeFileSync(outside, makePdf(['Secret outside']));
  fs.symlinkSync(outside, path.join(folder, 'link.pdf'));
  fs.writeFileSync(path.join(folder, 'big.pdf'), Buffer.alloc(MAX_PDF_BYTES + 10));
  const a = await attachFromPath({ folderPath: folder }, path.join(folder, 'docs', 'plan.pdf'));
  assert.equal(a.ok, true);
  if (a.ok) assert.match(a.block, /--- Attached file: docs\/plan\.pdf ---\n\[Page 1\]\nQuarterly plan/);
  const t = await executeToolCall({ function: { name: 'read_file', arguments: { path: 'docs/plan.pdf' } } }, folder);
  assert.equal(t.ok, true);
  assert.match(t.content, /Quarterly plan/);
  for (const p of [outside, path.join(folder, 'link.pdf'), path.join(folder, '..', 'secret.pdf'), '../secret.pdf']) {
    const r = await attachFromPath({ folderPath: folder }, p);
    assert.equal(r.ok, false, p);
  }
  assert.equal((await executeToolCall({ function: { name: 'read_file', arguments: { path: '../secret.pdf' } } }, folder)).ok, false);
  await assert.rejects(readPdfInFolder(folder, 'big.pdf'), /larger than 10 MB/);
  await assert.rejects(readPdfInFolder(null, 'docs/plan.pdf'), /Choose a folder/);
});

test('2. archive: not a delete; hidden from dock and phone; an archived bot\'s routine is paused; restore brings it back', () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  const a = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Bo', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.addMessage({ chatId: db.getBotChat(a.id).id, role: 'user', content: 'kept while archived' });
  db.setRoutine(a.id, { prompt: 'Daily note', time: '09:00', enabled: true });
  db.setRoutine(b.id, { prompt: 'Other', time: '10:00', enabled: true });
  const room = db.createRoom({ name: 'R', botIds: [a.id, b.id] });
  db.setArchived('bot', a.id, true);
  db.setArchived('room', room.id, true);
  assert.equal(db.getBot(a.id)!.archived, true);
  assert.equal(db.getRoom(room.id)!.archived, true);
  assert.equal(db.listMessages(db.getBotChat(a.id).id)[0].content, 'kept while archived');
  assert.deepEqual(db.listActiveRoutines().map((r) => r.botId), [b.id], 'paused while archived');
  assert.equal(db.getRoutine(a.id)!.enabled, true, 'the routine itself is kept as it was');
  db.setArchived('bot', a.id, false);
  assert.deepEqual(db.listActiveRoutines().map((r) => r.botId), [a.id, b.id]);
  assert.throws(() => db.setArchived('bot', 999, true), /not found/);
  db.close();
  assert.match(main, /listRoutines: \(\) => db\.listActiveRoutines\(\)/);
  assert.match(phone, /db\.listBots\(\)\.filter\(\(b\) => !b\.archived\)/);
  assert.match(phone, /db\.listRooms\(\)\.filter\(\(r\) => !r\.archived\)/);
  assert.match(phone, /return json\(res, 404, \{ error: 'This is archived on the desktop\.' \}\)/);
  for (const ch of ['archive:set', 'bots:setReplyLength', 'sites:add', 'sites:list', 'sites:remove', 'window:setAlwaysOnTop', 'chat:markdown', 'tips:done']) {
    assert.equal(UNLOCKED_CHANNELS.has(ch), false, ch);
  }
  assert.match(renderer, /const activeBots = \(\) => state\.bots\.filter\(\(b\) => !b\.archived\);/);
  assert.match(renderer, /el\.botList\.replaceChildren\(\.\.\.activeBots\(\)\.map/);
  assert.match(html, /assets\/cipher-archive\.svg/);
  assert.deepEqual(plusMenuItems({ kind: 'room' }).map((i) => i.id), ['export', 'mute', 'archive']);
});

test('migration v10 → v11: archived, reply_length and blocked_sites added, data kept, idempotent', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const bot = db.createBot({ name: 'Old', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.close();
  const raw = new Database(file);
  raw.exec('ALTER TABLE bots DROP COLUMN archived; ALTER TABLE bots DROP COLUMN reply_length; ALTER TABLE rooms DROP COLUMN archived; DROP TABLE blocked_sites');
  raw.pragma('user_version = 10');
  raw.close();
  db = new CipherDb(file);
  assert.deepEqual([db.getBot(bot.id)!.archived, db.getBot(bot.id)!.replyLength], [false, 'normal']);
  assert.deepEqual(db.listBlockedSites(), []);
  db.close();
  new CipherDb(file).close();
  const chk = new Database(file);
  assert.equal(chk.pragma('user_version', { simple: true }), 11);
  chk.close();
});

test('3. always on top: title-bar button and tray checkbox, saved locally, applied at start', () => {
  assert.match(main, /const ALWAYS_ON_TOP_KEY = 'always_on_top';/);
  assert.match(main, /\{ label: 'Always on top', type: 'checkbox', checked: isAlwaysOnTop\(\)/);
  assert.match(main, /if \(isAlwaysOnTop\(\)\) win\.setAlwaysOnTop\(true\);/);
  assert.match(html, /<button type="button" id="always-on-top" class="titlebar-btn" aria-pressed="false"[^>]*><img src="assets\/cipher-always-on-top\.svg"/);
});

test('4. reply length: stored per bot, in the system prompt, and num_predict sent to the local model', async () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Brief', systemPrompt: 'Help.', toolsEnabled: false, folderPath: null });
  assert.equal(bot.replyLength, 'normal');
  const short = db.setReplyLength(bot.id, 'short');
  assert.throws(() => db.setReplyLength(bot.id, 'huge'), /short, normal or long/);
  db.close();
  assert.match(buildHistory(short, [])[0].content as string, new RegExp(REPLY_LENGTH_HINT.short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(buildHistory({ ...short, replyLength: 'normal' }, [])[0].content as string, /Keep replies short|thorough/);
  assert.deepEqual(replyOptions('short'), { num_predict: 256 });
  assert.equal(replyOptions('normal'), undefined);
  assert.deepEqual(replyOptions('long'), { num_predict: 2048 });
  let body: { options?: unknown } = {};
  await streamChat({
    model: 'm', messages: [], onToken: () => undefined, options: replyOptions('short'), host: 'http://127.0.0.1:1',
    fetchImpl: (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('{"done":true}\n', { status: 200 }); }) as unknown as typeof fetch,
  });
  assert.deepEqual(body.options, { num_predict: 256 });
  assert.match(read('src/main/roomEngine.ts'), /options: replyOptions\(bot\.replyLength\)/);
});

test('5. copy chat as Markdown: your messages and replies, quotes, image names, result links; to the clipboard only', () => {
  const m = (o: Partial<Message>): Message => ({ id: 1, chatId: 1, role: 'user', content: '', toolCalls: null, toolName: null, createdAt: '', routine: false, search: null, quote: null, pinned: false, image: null, ...o });
  const md = chatMarkdown('Ada', [
    m({ content: 'Why?', quote: 'Because.' , image: 'pics/cat.png' }),
    m({ role: 'assistant', content: '**Yes.**' }),
    m({ role: 'tool', toolName: 'web_search', search: { query: 'cats', results: [{ title: 'Cats [wiki]', url: 'https://e.org/c', snippet: '' }] } }),
  ]);
  assert.equal(md, '# Chat with Ada\n\n**You:**\n> Because.\n\n*[Image: cat.png]*\n\nWhy?\n\n**Ada:**\n**Yes.**\n\n*Web search: cats*\n- [Cats wiki](https://e.org/c)\n');
  assert.match(main, /handle\('chat:markdown'[\s\S]*?clipboard\.writeText\(text\);/);
});

test('6. image viewer: the same data: image the bubble shows, never a file or web URL', () => {
  const fn = /function openImageViewer[\s\S]*?\n\}/.exec(renderer)![0];
  assert.match(fn, /const src = img\.getAttribute\('src'\) \?\? '';\s*if \(!\/\^data:image\\\/\(png\|jpeg\|gif\|webp\);base64,\/\.test\(src\)\) return;\s*el\.imageViewerImg\.src = src;/);
  assert.doesNotMatch(fn, /getImage|file:|https?:/);
  assert.match(html, /<img id="image-viewer-img" class="image-viewer-img" alt="" \/>/);
});

test('7. blocked sites: normalized, subdomains included, stored in cipher.db', () => {
  assert.equal(normalizeSite('https://www.Example.com/path?q=1'), 'example.com');
  assert.equal(normalizeSite('news.example.co.uk'), 'news.example.co.uk');
  for (const bad of ['', 'localhost', 'not a site', 5, 'javascript:alert(1)']) assert.equal(normalizeSite(bad), null, String(bad));
  assert.equal(isUrlBlocked('https://example.com/a', ['example.com']), true);
  assert.equal(isUrlBlocked('https://m.example.com/a', ['example.com']), true);
  assert.equal(isUrlBlocked('https://notexample.com/a', ['example.com']), false);
  assert.equal(isUrlBlocked('https://example.com.evil.net/', ['example.com']), false);
  const file = tmpDb();
  const db = new CipherDb(file);
  assert.deepEqual(db.addBlockedSite('www.Example.com'), ['example.com']);
  db.addBlockedSite('b.org');
  assert.throws(() => db.addBlockedSite('nope'), /like example\.com/);
  db.close();
  const again = new CipherDb(file);
  assert.deepEqual(again.listBlockedSites(), ['b.org', 'example.com']);
  assert.deepEqual(again.removeBlockedSite('b.org'), ['example.com']);
  again.close();
});

test('7. blocked sites: dropped from results, refused by Open as text (also after a redirect) and by link opening', async () => {
  assert.match(main, /const blocked = db\.listBlockedSites\(\);\s*return \(await webSearch\(query,[\s\S]*?\}\)\)\.filter\(\(r\) => !isUrlBlocked\(r\.url, blocked\)\);/);
  const page = /handle\('page:open'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(page, /if \(isUrlBlocked\(url, db\.listBlockedSites\(\)\)\) throw new Error\('That site is on your blocked-sites list\.'\);[\s\S]*?dialog\.showMessageBox/);
  assert.match(page, /isBlocked: \(u\) => isUrlBlocked\(u, db\.listBlockedSites\(\)\)/);
  const link = /handle\('link:open'[\s\S]*?\n {2}\}\);/.exec(main)![0];
  assert.match(link, /if \(isUrlBlocked\(url, db\.listBlockedSites\(\)\)\) throw new Error\('That site is on your blocked-sites list\.'\);[\s\S]*?shell\.openExternal\(url\)/);
  const c = new SearchConsent();
  const sites = ['blocked.example'];
  let requests = 0;
  const request = async (u: URL) => {
    requests++;
    if (u.hostname === 'ok.example') return { status: 302, headers: { location: 'https://www.blocked.example/x' }, body: Buffer.alloc(0) };
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('hi') };
  };
  const lookup = ((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, '93.184.216.34', 4)) as never;
  const go = (url: string) => fetchPageText(url, { isOnline: () => true, consumeConsent: (u) => c.consume(c.issue(1, url), 1, u), isBlocked: (u) => isUrlBlocked(u, sites), request, lookup });
  await assert.rejects(go('https://blocked.example/a'), /blocked-sites list/);
  assert.equal(requests, 0, 'nothing sent to a blocked site');
  await assert.rejects(go('https://ok.example/a'), /redirected to a site on your blocked-sites list/);
  assert.equal(requests, 1);
  assert.match(policy, /Blocked sites \(Settings\): search results from the sites you list are dropped/);
});

test('8. first-run tips: five cards in Liz\'s order, skippable, shown once (flag saved)', () => {
  assert.deepEqual(TIPS.map((t) => path.basename(t.icon)), ['cipher-tip-1-welcome.svg', 'cipher-tip-2-create-bot.svg', 'cipher-tip-3-folder.svg', 'cipher-tip-4-private.svg', 'cipher-tip-5-shortcuts.svg']);
  for (const t of TIPS) assert.ok(fs.existsSync(path.join(root, 'src/renderer', t.icon)), t.icon);
  assert.match(main, /handle\('tips:get', \(\) => db\.getSetting\(TIPS_SEEN_KEY\) !== '1'\);/);
  assert.match(main, /handle\('tips:done', \(\) => \{ db\.setSetting\(TIPS_SEEN_KEY, '1'\); \}\);/);
  assert.match(renderer, /el\.tipSkip\.addEventListener\('click', finishTips\);/);
  assert.match(html, /id="tip-skip" class="secondary">Skip tips</);
});

test('no new network code: the v1.21 modules make no requests', () => {
  for (const f of ['src/main/pdfText.ts', 'src/main/blockedSites.ts', 'src/main/chatMarkdown.ts']) {
    assert.doesNotMatch(read(f), /fetch\(|require\('https?'\)|from 'node:(http|https|net)'|WebSocket|openExternal/, f);
  }
});

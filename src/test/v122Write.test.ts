import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CipherDb, MEMORY_NOTE_MAX, SCHEMA_VERSION } from '../main/db';
import {
  MAX_WRITE_BYTES, WRITE_TOKEN_TTL_MS, WriteConsent, commitWrite, confirmAndWrite, contentHash, planWrite,
} from '../main/fileWrite';
import { CHECKLIST_ITEM_MAX, CHECKLIST_MAX_ITEMS, confirmChecklistAdd, consumeAndAdd } from '../main/checklist';
import { SearchConsent } from '../main/searchConsent';
import { runChatTurn, type ActionHooks } from '../main/chatEngine';
import { roomMarkdown } from '../main/chatMarkdown';
import { PhoneServer } from '../main/phoneServer';
import { UNLOCKED_CHANNELS } from '../main/lock';
import { ACCENTS, parseAccent, readUiPrefs } from '../main/uiPrefs';
import { findRanges, plusMenuItems, SHORTCUTS } from '../renderer/view';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';
import type { ChatEvent } from '../shared/types';

// v1.22: write a file (native confirm + one-time token), checklist, memory one-tap, accent, reduce motion, find,
// room Markdown, phone shows archived bots as hidden (403 on archive/restore).
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const engineSrc = read('src/main/chatEngine.ts');
const writeSrc = read('src/main/fileWrite.ts');
const renderer = read('src/renderer/renderer.ts');
const preload = read('src/preload/preload.ts');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const phoneJs = read('src/phone/app.js');
const policy = POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v122-')));
let n = 0;
const tmpDb = () => path.join(base, `t${++n}.db`);
function folder(): string {
  const d = path.join(base, `f${++n}`);
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'plan.md'), 'old plan\n');
  return d;
}
const files = (d: string) => fs.readdirSync(d).sort();

test('version 1.22.0, schema 12, WHATS_NEW five lines of 90 chars or fewer, CSP unchanged, names unchanged', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.23.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher');
  assert.equal(SCHEMA_VERSION, 13);
  assert.ok(WHATS_NEW.length >= 1 && WHATS_NEW.length <= 5);
  for (const l of WHATS_NEW) assert.ok(l.length <= 90, l);
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(WHATS_NEW.join(' ') + policy + html, /grok/i);
  assert.doesNotMatch(html, /\sstyle="/, 'no inline styles');
});

test('2. write plan: relative text paths only; absolute, "..", ~, NUL, binary types, oversize and missing folders refused', async () => {
  const d = folder();
  const refuse = async (p: unknown, c: unknown, re: RegExp) => assert.rejects(planWrite(d, p, c), re);
  await refuse('/etc/passwd.txt', 'x', /absolute/);
  await refuse('C:\\x.txt', 'x', /absolute/);
  await refuse('~/x.txt', 'x', /absolute/);
  await refuse('../out.txt', 'x', /"\.\."/);
  await refuse('docs/../../out.txt', 'x', /"\.\."/);
  await refuse('a\0.txt', 'x', /Invalid/);
  await refuse('run.sh', 'x', /Only text files/);
  await refuse('app.exe', 'x', /Only text files/);
  await refuse('notes.txt', 'a\0b', /Only text/);
  await refuse('notes.txt', 42, /must be text/);
  await refuse('notes.txt', 'x'.repeat(MAX_WRITE_BYTES + 1), /larger than/);
  await refuse('nope/notes.txt', 'x', /does not exist/);
  await assert.rejects(planWrite(null, 'a.txt', 'x'), /No folder/);
  const p = await planWrite(d, 'docs/new.md', 'hello');
  assert.equal(p.target, path.join(d, 'docs', 'new.md'));
  assert.equal(p.exists, false);
  assert.equal(p.alternative, null);
  assert.equal(p.hash, contentHash('hello'));
  const ex = await planWrite(d, './plan.md', 'new plan');
  assert.equal(ex.exists, true);
  assert.equal(ex.alternative, path.join(d, 'plan (2).md'));
  assert.deepEqual(files(d), ['docs', 'plan.md'], 'planning writes nothing');
});

test('2. symlinks: a linked file, a linked folder leading outside, and a symlinked root are handled after realpath', async () => {
  const d = folder();
  const outside = path.join(base, `outside${++n}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(d, 'link.txt'));
  fs.symlinkSync(outside, path.join(d, 'out'));
  await assert.rejects(planWrite(d, 'link.txt', 'x'), /symbolic link/);
  await assert.rejects(planWrite(d, 'out/new.txt', 'x'), /outside the shared folder/);
  fs.mkdirSync(path.join(d, 'sub.txt'));
  await assert.rejects(planWrite(d, 'sub.txt', 'x'), /not a regular file/);
  // A symlinked root is fine: everything is resolved against its real path.
  const alias = path.join(base, `alias${++n}`);
  fs.symlinkSync(d, alias);
  const p = await planWrite(alias, 'ok.txt', 'y');
  assert.equal(p.target, path.join(d, 'ok.txt'));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
});

test('2. write tokens: one-time, bound to chat + exact path + content hash + mode, short expiry', () => {
  let now = 1000;
  const c = new WriteConsent(() => now);
  const t = c.issue(1, '/f/a.txt', 'h', 'new');
  assert.equal(c.consume(t, 1, '/f/a.txt', 'h', 'new'), true);
  assert.equal(c.consume(t, 1, '/f/a.txt', 'h', 'new'), false, 'single use');
  for (const [chat, p, h, m] of [[2, '/f/a.txt', 'h', 'new'], [1, '/f/b.txt', 'h', 'new'], [1, '/f/a.txt', 'x', 'new'], [1, '/f/a.txt', 'h', 'replace']] as const) {
    const tok = c.issue(1, '/f/a.txt', 'h', 'new');
    assert.equal(c.consume(tok, chat, p, h, m), false);
    assert.equal(c.size, 0, 'a failed check still burns the token');
  }
  const late = c.issue(1, '/f/a.txt', 'h', 'new');
  now += WRITE_TOKEN_TTL_MS + 1;
  assert.equal(c.consume(late, 1, '/f/a.txt', 'h', 'new'), false, 'expired');
  assert.ok(WRITE_TOKEN_TTL_MS <= 60_000);
  assert.equal(c.consume(undefined, 1, '/f/a.txt', 'h', 'new'), false);
});

test('2. commitWrite refuses without the matching token; never overwrites in "new" mode; temp then rename', async () => {
  const d = folder();
  const c = new WriteConsent();
  const target = path.join(d, 'a.txt');
  await assert.rejects(commitWrite(c, 'forged', 1, d, target, 'x', 'new'), /did not confirm/);
  await assert.rejects(commitWrite(c, c.issue(1, target, contentHash('other'), 'new'), 1, d, target, 'x', 'new'), /did not confirm/);
  await assert.rejects(commitWrite(c, c.issue(2, target, contentHash('x'), 'new'), 1, d, target, 'x', 'new'), /did not confirm/);
  assert.equal(fs.existsSync(target), false);
  const r = await commitWrite(c, c.issue(1, target, contentHash('x'), 'new'), 1, d, target, 'x', 'new');
  assert.equal(r.relPath, 'a.txt');
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  // "new" never replaces: a file that appeared meanwhile is kept.
  const plan = path.join(d, 'plan.md');
  await assert.rejects(commitWrite(c, c.issue(1, plan, contentHash('y'), 'new'), 1, d, plan, 'y', 'new'), /appeared/);
  assert.equal(fs.readFileSync(plan, 'utf8'), 'old plan\n');
  await commitWrite(c, c.issue(1, plan, contentHash('y'), 'replace'), 1, d, plan, 'y', 'replace');
  assert.equal(fs.readFileSync(plan, 'utf8'), 'y');
  // A target swapped for a symlink after the confirm is refused.
  const s = path.join(d, 's.txt');
  fs.symlinkSync('/etc/hostname', s);
  await assert.rejects(commitWrite(c, c.issue(1, s, contentHash('z'), 'replace'), 1, d, s, 'z', 'replace'), /not a regular file/);
  // Outside the folder, even with a token for it.
  const out = path.join(base, 'escape.txt');
  await assert.rejects(commitWrite(c, c.issue(1, out, contentHash('z'), 'new'), 1, d, out, 'z', 'new'), /outside/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(files(d).filter((f) => f.includes('.cipher-write-')), [], 'no temp files left');
  assert.match(writeSrc, /fs\.open\(tmp, 'wx'/);
  assert.match(writeSrc, /fs\.rename\(tmp, target\)/);
});

test('2. confirmAndWrite: Cancel, lock, or no answer writes nothing; Write / Replace / Save as new name do what they say', async () => {
  const d = folder();
  const c = new WriteConsent();
  let asked: { message: string; detail: string; buttons: string[] } | null = null;
  const deps = (answer: number, locked = () => false) => ({ consent: c, isLocked: locked, ask: async (t: typeof asked) => { asked = t; return answer; } });
  let r = await confirmAndWrite(deps(0), 1, 'Ada', d, 'new.txt', 'hi');
  assert.equal(r.ok, false);
  assert.match(r.content, /cancelled/);
  assert.equal(fs.existsSync(path.join(d, 'new.txt')), false);
  assert.ok(asked!.detail.startsWith(path.join(d, 'new.txt')), 'dialog shows the full resolved path first');
  assert.deepEqual(asked!.buttons, ['Cancel', 'Write file']);
  r = await confirmAndWrite(deps(1), 1, 'Ada', d, 'new.txt', 'hi');
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(d, 'new.txt'), 'utf8'), 'hi');
  // Existing file: the dialog says so; Replace replaces; Save as new name picks "plan (2).md".
  r = await confirmAndWrite(deps(2), 1, 'Ada', d, 'plan.md', 'v2');
  assert.match(asked!.message, /REPLACE/);
  assert.match(asked!.detail, /already exists\. Replace file will OVERWRITE it/);
  assert.equal(fs.readFileSync(path.join(d, 'plan (2).md'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(d, 'plan.md'), 'utf8'), 'old plan\n');
  r = await confirmAndWrite(deps(1), 1, 'Ada', d, 'plan.md', 'v3');
  assert.match(r.content, /replacing/);
  assert.equal(fs.readFileSync(path.join(d, 'plan.md'), 'utf8'), 'v3');
  // Locked before: never asks, writes nothing. Locked while the dialog is open: writes nothing.
  asked = null;
  r = await confirmAndWrite(deps(1, () => true), 1, 'Ada', d, 'l.txt', 'x');
  assert.equal(asked, null);
  assert.match(r.content, /locked/);
  let lockedNow = false;
  r = await confirmAndWrite({ consent: c, isLocked: () => lockedNow, ask: async () => { lockedNow = true; return 1; } }, 1, 'Ada', d, 'l.txt', 'x');
  assert.match(r.content, /locked/);
  assert.equal(fs.existsSync(path.join(d, 'l.txt')), false);
  assert.equal(c.size, 0, 'no token left lying around');
  // Escapes are refused before any dialog.
  asked = null;
  r = await confirmAndWrite(deps(1), 1, 'Ada', d, '../x.txt', 'x');
  assert.equal(asked, null);
  assert.equal(r.ok, false);
});

test('2. no write path skips the confirm (source audit of every file write in main)', () => {
  // fileWrite.ts: the only writes are inside commitWrite, and commitWrite consumes the token before anything else.
  const commit = writeSrc.slice(writeSrc.indexOf('export async function commitWrite'), writeSrc.indexOf('/** Text for the native confirm dialog'));
  const rest = writeSrc.replace(commit, '');
  assert.doesNotMatch(rest, /fs\.(open|writeFile|appendFile|rename|link|copyFile|createWriteStream)\(/, 'no write outside commitWrite');
  const firstWrite = commit.search(/fs\.(open|writeFile|rename|link)\(/);
  const consume = commit.indexOf('consent.consume(token');
  assert.ok(consume > 0 && consume < firstWrite, 'token consumed before the first write');
  assert.match(commit, /if \(!consent\.consume\(token, chatId, target, hash, mode\)\) throw/);
  // confirmAndWrite issues a token only after ask() and the lock re-check.
  const flow = writeSrc.slice(writeSrc.indexOf('export async function confirmAndWrite'));
  assert.ok(flow.indexOf('await d.ask(') < flow.indexOf('d.consent.issue('), 'ask before issue');
  assert.ok(flow.lastIndexOf('d.isLocked()', flow.indexOf('d.consent.issue(')) > flow.indexOf('await d.ask('), 'lock re-checked after the answer');
  // Nobody else calls commitWrite or issues write tokens; the engine never touches the file system.
  const mainSrc = fs.readdirSync(path.join(root, 'src/main')).filter((f) => f.endsWith('.ts') && f !== 'fileWrite.ts')
    .map((f) => read(`src/main/${f}`)).join('\n');
  assert.doesNotMatch(mainSrc, /commitWrite\(|writeConsent\.issue\(/);
  assert.doesNotMatch(engineSrc, /from 'node:fs|require\('fs'\)/);
  // Every other file write in main is a known, user-chosen or app-internal path (see the PR's list).
  const writers = fs.readdirSync(path.join(root, 'src/main')).filter((f) => f.endsWith('.ts') &&
    /\bfs(\.promises)?\.(writeFile|writeFileSync|appendFile|createWriteStream|copyFileSync|renameSync|rename|link)\(|\.backup\(|open\([^)]*'wx?'/.test(read(`src/main/${f}`))).sort();
  assert.deepEqual(writers, ['backup.ts', 'db.ts', 'fileWrite.ts', 'lock.ts', 'main.ts', 'updateCheck.ts', 'windowBounds.ts']);
  // main's writes: only the native Save dialog's chosen path (export, debug log) and the backup.
  assert.equal((main.match(/fs\.writeFile\(r\.filePath/g) ?? []).length, 2);
  assert.doesNotMatch(main, /fs\.writeFile\((?!r\.filePath)/);
  // The renderer and preload have no way to write: no write channel, no token in, no path out.
  assert.doesNotMatch(preload, /write_file|file:write|writeFile|confirmWrite/i);
});

test('2. the confirm is a native dialog in main (Cancel default), only for desktop 1:1 turns; lock revokes tokens', () => {
  assert.match(main, /async function nativeAsk[\s\S]*?dialog\.showMessageBox[\s\S]*?defaultId: 0, cancelId: 0/);
  assert.match(main, /actions: toolsOff \? undefined : actionHooks/);
  assert.match(main, /fromRoutine: true \}/, 'routine turn passes no actions');
  assert.doesNotMatch(main.slice(main.indexOf('fromRoutine: true')).split('\n')[0], /actions/);
  assert.match(main, /phone\?\.closeStreams\(\);\s*writeConsent\.revokeAll\(\);[^\n]*\n\s*checklistConsent\.revokeAll\(\);/);
  assert.doesNotMatch(renderer, /api\.\w*[Ww]rite/, 'the window has no write call');
});

/** Scripted Ollama: round 1 asks for `calls`, round 2 answers plainly. Records the tools offered each round. */
function scripted(calls: unknown[], offered: string[][]): typeof fetch {
  let round = 0;
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    offered.push((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name));
    const msg = round++ === 0 && calls.length ? { role: 'assistant', content: '', tool_calls: calls } : { role: 'assistant', content: 'ok' };
    return new Response(`${JSON.stringify({ message: msg, done: false })}\n${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

test('2/7. engine: desktop offers write_file + checklist_add; routines and phone turns never get them or run them', async () => {
  const db = new CipherDb(tmpDb());
  const d = folder();
  const bot0 = db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: true, folderPath: d });
  const bot = db.setToolSwitches(bot0.id, { checklist: true, write: true }); // v1.23: off by default
  const chat = db.getBotChat(bot.id);
  const hits: string[] = [];
  const actions: ActionHooks = {
    writeFile: async (_c, _b, p) => { hits.push(`write:${String(p)}`); return { ok: false, path: String(p), content: 'The user cancelled: no file was written.' }; },
    addChecklist: async (_c, _b, t) => { hits.push(`check:${String(t)}`); return { ok: false, text: String(t), content: 'The user declined.' }; },
  };
  const calls = [{ function: { name: 'write_file', arguments: { path: 'x.txt', content: 'hi' } } }, { function: { name: 'checklist_add', arguments: { text: 'milk' } } }];
  const events: ChatEvent[] = [];
  let offered: string[][] = [];
  await runChatTurn({ db, model: 'm', emit: (e) => events.push(e), fetchImpl: scripted(calls, offered), actions }, chat.id, 'save it', new AbortController().signal);
  assert.ok(offered[0].includes('write_file') && offered[0].includes('checklist_add'));
  assert.deepEqual(hits, ['write:x.txt', 'check:milk'], 'tool calls go to main\'s hooks (which ask first)');
  for (const extra of [{ fromRoutine: true }, { forceToolsOff: true }]) {
    hits.length = 0; offered = [];
    await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(calls, offered), actions, ...extra }, chat.id, 'save it', new AbortController().signal);
    assert.ok(!offered.flat().includes('write_file') && !offered.flat().includes('checklist_add'), JSON.stringify(extra));
    assert.deepEqual(hits, [], `hooks never called for ${JSON.stringify(extra)}`);
  }
  // Without hooks (e.g. tests, or main never passing them) a call is refused and nothing is written.
  offered = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(calls, offered) }, chat.id, 'save it', new AbortController().signal);
  assert.ok(!offered.flat().includes('write_file'));
  assert.equal(fs.existsSync(path.join(d, 'x.txt')), false);
  db.close();
});

test('7. checklist: stored per bot in cipher.db; add/check/delete; caps; deleted with the bot', () => {
  const db = new CipherDb(tmpDb());
  const a = db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Bo', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  let list = db.addChecklistItem(a.id, '  buy   milk ');
  assert.deepEqual(list.map((i) => [i.text, i.done]), [['buy milk', false]]);
  list = db.setChecklistDone(a.id, list[0].id, true);
  assert.equal(list[0].done, true);
  assert.throws(() => db.setChecklistDone(b.id, list[0].id, false), /not found/, 'another bot cannot touch it');
  assert.throws(() => db.addChecklistItem(a.id, ''), /empty/);
  assert.throws(() => db.addChecklistItem(a.id, 'x'.repeat(CHECKLIST_ITEM_MAX + 1)), /up to/);
  for (let i = 1; i < CHECKLIST_MAX_ITEMS; i++) db.addChecklistItem(a.id, `i${i}`);
  assert.throws(() => db.addChecklistItem(a.id, 'one more'), /full/);
  assert.equal(db.deleteChecklistItem(a.id, list[0].id).length, CHECKLIST_MAX_ITEMS - 1);
  db.addChecklistItem(b.id, 'keep');
  db.deleteBot(a.id);
  assert.equal(db.listChecklist(a.id).length, 0);
  assert.equal(db.listChecklist(b.id).length, 1);
  db.close();
});

test('7. a bot adds a checklist item only through main\'s native confirm and a one-time token', async () => {
  const added: string[] = [];
  const consent = new SearchConsent();
  const d = (answer: number, locked = () => false) => ({ consent, isLocked: locked, ask: async () => answer, add: (_b: number, t: string) => { added.push(t); } });
  assert.equal((await confirmChecklistAdd(d(0), 1, 7, 'Ada', 'milk')).ok, false);
  assert.equal((await confirmChecklistAdd(d(1, () => true), 1, 7, 'Ada', 'milk')).ok, false, 'locked');
  assert.deepEqual(added, []);
  assert.equal((await confirmChecklistAdd(d(1), 1, 7, 'Ada', 'milk')).ok, true);
  assert.deepEqual(added, ['milk']);
  assert.throws(() => consumeAndAdd(d(1), 'forged', 1, 7, 'eggs'), /did not confirm/);
  const tok = consent.issue(1, '7\nmilk');
  assert.throws(() => consumeAndAdd(d(1), tok, 1, 7, 'eggs'), /did not confirm/, 'token bound to the exact text');
  assert.deepEqual(added, ['milk']);
  // Text in a reply can't approve anything: the engine only ever calls the hook, which asks.
  assert.doesNotMatch(engineSrc, /addChecklistItem|consumeAndAdd/);
});

test('1. save a message into the memory note: one tap, 2000-char cap, clear message when full', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  assert.equal(db.appendBotMemory(bot.id, 'I live in Lyon').memoryNote, 'I live in Lyon');
  assert.equal(db.appendBotMemory(bot.id, 'metric units').memoryNote, 'I live in Lyon\nmetric units');
  db.setBotMemory(bot.id, 'x'.repeat(MEMORY_NOTE_MAX - 5));
  assert.throws(() => db.appendBotMemory(bot.id, 'a long message'), /almost full: 4 of 2000 characters left/);
  db.setBotMemory(bot.id, 'x'.repeat(MEMORY_NOTE_MAX));
  assert.throws(() => db.appendBotMemory(bot.id, 'hi'), /memory note is full \(2000 characters\)/);
  assert.equal(db.getBot(bot.id)!.memoryNote.length, MEMORY_NOTE_MAX, 'unchanged when refused');
  assert.match(main, /handle\('memory:remember'[\s\S]*?db\.appendBotMemory\(chat\.botId, m\.content\)/);
  assert.match(renderer, /'Save to memory note', 'remember-btn'/);
  db.close();
});

test('3/4. accent colors via CSS variables only (Liz\'s hex values); reduce motion setting + prefers-reduced-motion', () => {
  assert.deepEqual(ACCENTS.map((a) => a.hex), ['#5b8cff', '#2ec4b6', '#9b7bff', '#f5a524', '#ff6b8a']);
  assert.equal(parseAccent('teal'), 'teal');
  assert.equal(parseAccent('url(evil)'), 'blue');
  for (const a of ACCENTS.slice(1)) assert.match(css, new RegExp(`:root\\[data-accent="${a.id}"\\]\\s+\\{ --accent: ${a.hex};`));
  assert.match(css, /--accent: #5b8cff;/);
  for (const s of ['blue', 'teal', 'violet', 'amber', 'rose']) assert.match(html, new RegExp(`data-accent="${s}"`));
  assert.ok(fs.existsSync(path.join(root, 'src/renderer/assets/swatch-teal.svg')));
  assert.match(renderer, /document\.documentElement\.dataset\.accent = name/);
  assert.doesNotMatch(renderer, /\.style\b|cssText|setProperty\(/, 'no inline styles from script');
  assert.equal(readUiPrefs(() => null).reduceMotion, false);
  assert.equal(readUiPrefs((k) => (k === 'reduce_motion' ? '1' : null)).reduceMotion, true);
  assert.match(css, /:root\.reduce-motion \.bot-icon \{ animation: none !important; \}/);
  assert.match(css, /:root\.reduce-motion #splash \{ animation: splash-out 0s/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-icon \{ animation: none !important; \}\s*#splash/);
});

test('5. find in chat: separate from the dock search, highlights built with createElement (no HTML parsing)', () => {
  assert.deepEqual(findRanges('Milk, milk and MILK', 'milk'), [[0, 4], [6, 10], [15, 19]]);
  assert.deepEqual(findRanges('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(findRanges('x', '  '), []);
  assert.match(html, /id="find-input"/);
  assert.notEqual(html.indexOf('id="find-input"'), html.indexOf('id="search"'));
  const find = renderer.slice(renderer.indexOf('function applyFind'), renderer.indexOf('function openFind'));
  assert.match(find, /document\.createElement\('mark'\)/);
  assert.match(find, /mark\.textContent = /);
  assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(find, /DOMParser/);
  assert.ok(SHORTCUTS.some((s) => s.keys === 'Ctrl+F'));
});

test('6. a room exports the same way as a bot: text file and Markdown', () => {
  assert.deepEqual(plusMenuItems({ kind: 'room' }).map((i) => i.id), ['export', 'markdown', 'mute', 'archive']);
  const md = roomMarkdown('Team', [
    { id: 1, roomId: 1, role: 'user', botId: null, content: 'Plan?', createdAt: '' },
    { id: 2, roomId: 1, role: 'assistant', botId: 5, content: 'Step one.', createdAt: '' },
  ], (id) => (id === 5 ? 'Ada' : null));
  assert.equal(md, '# Room: Team\n\n**You:**\nPlan?\n\n**Ada:**\nStep one.\n');
  assert.match(main, /kind === 'room'[\s\S]*?roomMarkdown\(name, db\.listRoomMessages\(id\), nameOf\)/);
});

test('8. phone: archived bots listed as hidden, not openable; archive/unarchive is 403; nothing new unlocked', async () => {
  const db = new CipherDb(tmpDb());
  const a = db.createBot({ name: 'Ada', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Bo', systemPrompt: 'Hi', toolsEnabled: false, folderPath: null });
  db.setArchived('bot', b.id, true);
  const port = 28400 + Math.floor(Math.random() * 500);
  const server = new PhoneServer({ db, staticDir: path.join(root, 'src/phone'), model: 'fake', port,
    sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {} });
  server.start();
  await server.whenListening();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const code = server.status().pairingCode!;
    const pair = await (await fetch(`${baseUrl}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json() as { token: string };
    const h = { Authorization: `Bearer ${pair.token}` };
    const bots = await (await fetch(`${baseUrl}/api/bots`, { headers: h })).json() as { bots: { id: number; hidden: boolean }[] };
    assert.deepEqual(bots.bots.map((x) => [x.id, x.hidden]), [[a.id, false], [b.id, true]]);
    for (const p of [`/api/bots/${b.id}/unarchive`, `/api/bots/${b.id}/restore`, `/api/bots/${a.id}/archive`, `/api/rooms/1/unarchive`]) {
      const r = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: h });
      assert.equal(r.status, 403, p);
    }
    assert.equal((await fetch(`${baseUrl}/api/bots/${b.id}/chat`, { headers: h })).status, 404, 'still not openable');
    assert.equal(db.getBot(b.id)!.archived, true);
  } finally { server.stop(); db.close(); }
  assert.match(phoneJs, /if \(b\.hidden\) \{[\s\S]*?btn\.disabled = true;/);
  for (const ch of ['memory:remember', 'checklist:list', 'checklist:add', 'checklist:done', 'checklist:delete', 'accent:get', 'accent:set']) {
    assert.ok(!UNLOCKED_CHANNELS.has(ch), `${ch} is lock-guarded`);
    assert.match(main, new RegExp(`handle\\('${ch}'`));
  }
});

test('policy describes file writes, the checklist and the phone truthfully', () => {
  assert.match(policy, /never writes without asking/);
  assert.match(policy, /full path on this computer/);
  assert.match(policy, /Rooms, routines, reminders and the phone can never write files, and the phone cannot answer the question/);
  assert.match(policy, /only after you press Add/);
  assert.match(policy, /shows it on the phone only as hidden/);
  assert.match(policy, /up to 2000 characters; when it is full/);
});

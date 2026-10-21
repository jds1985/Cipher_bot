import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { runChatTurn, type ActionHooks, type SearchHooks } from '../main/chatEngine';
import { DEFAULT_TOOL_SWITCHES, parseToolUpdate, TOOL_NAMES } from '../main/toolSwitches';
import { REMINDER_GRACE_MS, ReminderScheduler, reminderState, validateReminder } from '../main/reminders';
import { MAX_DOCX_ENTRIES, MAX_DOCX_XML, docxBytesToText, documentXmlToText, readDocxInFolder } from '../main/docxText';
import { readFileInFolder } from '../main/readFileTool';
import { diskUsage, folderBytes } from '../main/diskUsage';
import { formatMessageTime, formatReminderAt, formatSize, plusMenuItems, SHORTCUTS } from '../renderer/view';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';
import type { ChatEvent, Reminder } from '../shared/types';

// v1.23: tool switches, paste a screenshot, undo delete, reminders, docx/txt, focus mode, disk used, overwrite confirm.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const engineSrc = read('src/main/chatEngine.ts');
const renderer = read('src/renderer/renderer.ts');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const phoneSrc = read('src/main/phoneServer.ts');
const phoneApp = read('src/phone/app.js');
const policy = POLICY_SECTIONS.map((s) => `${s.heading}\n${s.paragraphs.join('\n')}`).join('\n');

function tmpDb(): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v123-')), 'cipher.db'); }
function folder(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v123-dir-')); }

/** Scripted Ollama: round 1 asks for `calls` (after `before()`), round 2 answers plainly. Records tools offered. */
function scripted(calls: unknown[], offered: string[][], before?: () => void): typeof fetch {
  let round = 0;
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    offered.push((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name));
    const first = round++ === 0;
    if (first) before?.();
    const msg = first && calls.length ? { role: 'assistant', content: '', tool_calls: calls } : { role: 'assistant', content: 'ok' };
    return new Response(`${JSON.stringify({ message: msg, done: false })}\n${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

const ALL_CALLS = [
  { function: { name: 'read_file', arguments: { path: 'a.txt' } } },
  { function: { name: 'web_search', arguments: { query: 'weather' } } },
  { function: { name: 'calculator', arguments: { expression: '2+2' } } },
  { function: { name: 'checklist_add', arguments: { text: 'milk' } } },
  { function: { name: 'write_file', arguments: { path: 'b.txt', content: 'hi' } } },
];

function hooks(hits: string[]): { actions: ActionHooks; search: SearchHooks } {
  return {
    actions: {
      writeFile: async (_c, _b, p) => { hits.push('write_file'); return { ok: true, path: String(p), content: 'Wrote.' }; },
      addChecklist: async (_c, _b, t) => { hits.push('checklist_add'); return { ok: true, text: String(t), content: 'Added.' }; },
    },
    search: {
      isOnline: () => true,
      confirm: async () => { hits.push('web_search'); return 'tok'; },
      run: async () => { hits.push('web_search:run'); return []; },
    },
  };
}

test('version 1.24.0, schema 14, WHATS_NEW five lines of 90 chars or fewer, CSP and names unchanged', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.25.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher');
  assert.equal(SCHEMA_VERSION, 14);
  assert.ok(WHATS_NEW.length >= 1 && WHATS_NEW.length <= 5);
  for (const l of WHATS_NEW) assert.ok(l.length <= 90, l);
  assert.doesNotMatch(WHATS_NEW.join(' '), /grok/i);
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['better-sqlite3', 'pdfjs-dist', 'qrcode'], 'no new runtime dependency (docx uses node:zlib)');
});

test('migration v12 → v13: every existing bot has every switch off except files (which keeps its value); idempotent', () => {
  const file = tmpDb();
  const db = new CipherDb(file);
  const a = db.createBot({ name: 'Files on', systemPrompt: '', toolsEnabled: true, folderPath: null });
  const b = db.createBot({ name: 'Files off', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.close();
  // Make it a v12 database again: drop the v13 columns, set the version back.
  const raw = new Database(file);
  for (const c of ['tool_search', 'tool_calc', 'tool_checklist', 'tool_write']) raw.exec(`ALTER TABLE bots DROP COLUMN ${c}`);
  raw.pragma('user_version = 12');
  raw.close();
  const re = new CipherDb(file);
  assert.deepEqual(re.getBot(a.id)!.tools, { files: true, search: false, calculator: false, checklist: false, write: false });
  assert.deepEqual(re.getBot(b.id)!.tools, { files: false, search: false, calculator: false, checklist: false, write: false });
  re.setToolSwitches(a.id, { calculator: true });
  re.close();
  const again = new CipherDb(file);
  assert.equal(again.getBot(a.id)!.tools!.calculator, true, 'reopening does not reset switches');
  const chk = new Database(file);
  assert.equal(chk.pragma('user_version', { simple: true }), 14);
  chk.close();
  again.close();
  assert.deepEqual({ ...DEFAULT_TOOL_SWITCHES }, { files: true, search: false, calculator: false, checklist: false, write: false });
});

test('switch updates are validated: only the five keys, booleans only', () => {
  assert.deepEqual(parseToolUpdate({ search: true, write: false }), { search: true, write: false });
  for (const bad of [null, [], 'x', { search: 'yes' }, { email: true }, { files: 1 }]) assert.throws(() => parseToolUpdate(bad));
});

test('EVERY tool is refused at execution while its switch is off (even when the model calls it uninvited)', async () => {
  const db = new CipherDb(tmpDb());
  const d = folder();
  fs.writeFileSync(path.join(d, 'a.txt'), 'secret');
  const bot = db.createBot({ name: 'Off', systemPrompt: '', toolsEnabled: false, folderPath: d });
  db.setToolSwitches(bot.id, { files: false, search: false, calculator: false, checklist: false, write: false });
  const chat = db.getBotChat(bot.id);
  const hits: string[] = [];
  const offered: string[][] = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(ALL_CALLS, offered), ...hooks(hits) }, chat.id, 'go', new AbortController().signal);
  assert.deepEqual(offered[0], [], 'nothing offered');
  assert.deepEqual(hits, [], 'no hook ran');
  const tools = db.listMessages(chat.id).filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => m.toolName), [...TOOL_NAMES.filter((n) => n === 'read_file'), 'web_search', 'calculator', 'checklist_add', 'write_file']);
  for (const m of tools) assert.match(m.content, /^Error: .*(off|switched off) for this Cipher bot/);
  assert.ok(!tools.some((m) => m.content.includes('secret')), 'the file was not read');
  assert.ok(!tools.some((m) => m.content.includes('= 4')), 'the calculator did not run');
});

test('switches are re-checked at execution: offered while on, refused if turned off before the call runs', async () => {
  const db = new CipherDb(tmpDb());
  const d = folder();
  fs.writeFileSync(path.join(d, 'a.txt'), 'secret');
  const bot = db.createBot({ name: 'On', systemPrompt: '', toolsEnabled: true, folderPath: d });
  db.setToolSwitches(bot.id, { search: true, calculator: true, checklist: true, write: true });
  const chat = db.getBotChat(bot.id);
  const hits: string[] = [];
  const offered: string[][] = [];
  const allOff = () => { db.setToolSwitches(bot.id, { files: false, search: false, calculator: false, checklist: false, write: false }); };
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(ALL_CALLS, offered, allOff), ...hooks(hits) }, chat.id, 'go', new AbortController().signal);
  assert.deepEqual([...offered[0]].sort(), ['calculator', 'checklist_add', 'read_file', 'web_search', 'write_file']);
  assert.deepEqual(hits, [], 'turned off before running: nothing ran');
  assert.deepEqual(offered[1], [], 'and nothing is offered on the next round');
  // With everything on, all five run (through main's hooks for search/write/checklist).
  db.setToolSwitches(bot.id, { files: true, search: true, calculator: true, checklist: true, write: true });
  const hits2: string[] = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(ALL_CALLS, []), ...hooks(hits2) }, chat.id, 'go', new AbortController().signal);
  assert.deepEqual(hits2, ['web_search', 'web_search:run', 'checklist_add', 'write_file']);
  const last = db.listMessages(chat.id).filter((m) => m.role === 'tool').slice(-5);
  assert.equal(last[0].content.includes('secret'), true, 'read_file ran');
  assert.equal(last[2].content, '2+2 = 4', 'calculator ran');
});

test('switches live in main: only the desktop handler changes them; never the phone, never a reply', () => {
  assert.match(main, /handle\('bots:setToolSwitches', \(_e, botId: unknown, update: unknown\) => db\.setToolSwitches\(asId\(botId\), parseToolUpdate\(update\)\)\);/);
  assert.equal((main.match(/setToolSwitches\(/g) ?? []).length, 1, 'one call site in main');
  assert.doesNotMatch(engineSrc, /setToolSwitches|setBotTools|UPDATE bots/, 'the engine (bot replies) cannot change switches');
  assert.doesNotMatch(phoneSrc, /setToolSwitches|setBotTools|tool_|toolSwitch/i, 'the phone server has no route for switches');
  assert.doesNotMatch(phoneApp, /setToolSwitches|tools/i);
});

test('reminders run like routines: no write/checklist/search, the bot switches still apply', async () => {
  const db = new CipherDb(tmpDb());
  const d = folder();
  const bot = db.createBot({ name: 'R', systemPrompt: '', toolsEnabled: true, folderPath: d });
  db.setToolSwitches(bot.id, { search: true, calculator: true, checklist: true, write: true });
  const chat = db.getBotChat(bot.id);
  const hits: string[] = [];
  const offered: string[][] = [];
  // main passes no actions and no search for reminders, but even if it did, the engine refuses them.
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted(ALL_CALLS, offered), fromRoutine: true, reminder: true, ...hooks(hits) },
    chat.id, 'remind', new AbortController().signal);
  assert.deepEqual(offered[0], ['read_file', 'calculator']);
  assert.deepEqual(hits, []);
  const user = db.listMessages(chat.id).find((m) => m.role === 'user')!;
  assert.equal(user.reminder, true);
  db.setToolSwitches(bot.id, { files: false, calculator: false });
  const off: string[][] = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted([], off), fromRoutine: true, reminder: true }, chat.id, 'x', new AbortController().signal);
  assert.deepEqual(off[0], [], 'switched off: nothing offered');
  // main: reminder turns get no hooks for actions or search; notice skips muted bots; lock purge/order unchanged
  const fn = main.slice(main.indexOf('function runReminderTurn'), main.indexOf('// ---------- v1.23: undo'));
  assert.match(fn, /runChatTurn\(\{ db, model: currentModel\(\), emit, forceToolsOff: false, fromRoutine: true, reminder: true, sharedFolder \}/);
  assert.doesNotMatch(fn, /actions|search:/);
  assert.match(fn, /routineNotifier\?\.notify\(r\.botId/);
  assert.match(main, /isMuted: \(botId\) => db\.isMuted\('bot', botId\)/);
});

test('reminder schedule: due within the grace period, missed (skipped, never caught up) after; archived skipped; busy retried', () => {
  const now = new Date(2026, 9, 12, 9, 0, 30);
  const r = (at: string, id = 1): Reminder => ({ id, botId: 1, at, prompt: 'p', status: 'pending', note: null, createdAt: '' });
  assert.equal(reminderState(r('2026-10-12T09:00'), now), 'due');
  assert.equal(reminderState(r('2026-10-12T09:01'), now), 'wait');
  assert.equal(reminderState(r('2026-10-12T08:55'), now), 'missed');
  assert.equal(REMINDER_GRACE_MS, 120_000);
  const list = [r('2026-10-12T09:00', 1), r('2026-10-11T09:00', 2), { ...r('2026-10-12T09:00', 3), botId: 2 }, { ...r('2026-10-12T09:00', 4), botId: 3 }];
  const status: Record<number, string> = {};
  const ran: number[] = [];
  let busy = true;
  const s = new ReminderScheduler({
    listPending: () => list.filter((x) => !status[x.id] || status[x.id] === 'pending'),
    bot: (id) => (id === 2 ? { archived: true } : { archived: false }),
    chatIdForBot: (id) => id * 10,
    isBusy: (c) => c === 30 && busy,
    setStatus: (id, st) => { status[id] = st; },
    run: (x) => ran.push(x.id),
    now: () => now,
  });
  assert.deepEqual(s.tick(), [1]);
  assert.equal(status[2], 'missed', 'app was closed yesterday: skipped, not caught up');
  assert.equal(status[3], 'skipped', 'archived bot');
  assert.equal(status[4], undefined, 'busy: retried next tick');
  busy = false;
  assert.deepEqual(s.tick(), [4]);
  assert.deepEqual(s.tick(), [], 'each runs once');
  assert.deepEqual(ran, [1, 4]);
  assert.throws(() => validateReminder('2026-10-12T08:00', 'x', now), /future/);
  assert.throws(() => validateReminder('2026-13-40T08:00', 'x', now));
  assert.throws(() => validateReminder('2026-10-13T08:00', '  ', now));
  assert.deepEqual(validateReminder('2026-10-13T08:00', ' hi ', now), { at: '2026-10-13T08:00', prompt: 'hi' });
});

test('reminders in the database: per bot, capped, deleted with the bot', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'R', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const soon = new Date(Date.now() + 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
  const rem = db.addReminder(bot.id, at, 'Check the oven');
  assert.equal(rem.status, 'pending');
  db.setReminderStatus(rem.id, 'missed', 'skipped');
  assert.equal(db.listReminders(bot.id)[0].status, 'missed');
  db.deleteBot(bot.id);
  assert.deepEqual(db.listReminders(), []);
});

/** A minimal .docx (zip) with the given document.xml, deflated. */
function makeZip(entries: { name: string; data: Buffer; method?: 0 | 8 }[]): Buffer {
  const locals: Buffer[] = [], cds: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); cds.push(cd, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const docXml = (body: string) => Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`);

test('docx: text only (paragraphs, tabs, breaks, the five XML entities), in main, under the folder rules', async () => {
  const xml = docXml('<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> &amp; bye &lt;3 &#233;</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r></w:p>');
  const buf = makeZip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: xml }]);
  assert.equal(docxBytesToText(buf), 'Hello\t & bye <3 é\nLine\ntwo');
  const d = folder();
  fs.writeFileSync(path.join(d, 'plan.docx'), buf);
  fs.writeFileSync(path.join(d, 'note.txt'), 'plain text');
  assert.equal((await readDocxInFolder(d, 'plan.docx')).content, 'Hello\t & bye <3 é\nLine\ntwo');
  assert.equal((await readFileInFolder(d, 'plan.docx')).content.includes('Hello'), true, 'read_file / Attach route .docx to the reader');
  assert.equal((await readFileInFolder(d, 'note.txt')).content.includes('plain text'), true, '.txt read as text');
  const outside = path.join(folder(), 'x.docx');
  fs.writeFileSync(outside, buf);
  await assert.rejects(readDocxInFolder(d, outside));
  await assert.rejects(readDocxInFolder(d, '../x.docx'));
  fs.symlinkSync(outside, path.join(d, 'link.docx'));
  await assert.rejects(readDocxInFolder(d, 'link.docx'), 'symlink out of the folder refused');
});

test('docx: zip-bomb guards (entry count, unpacked size) and no DTD/entities', () => {
  const many = makeZip(Array.from({ length: MAX_DOCX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x'), method: 0 as const })));
  assert.throws(() => docxBytesToText(many), /too many parts/);
  const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(MAX_DOCX_XML + 1024, 0x20) }]);
  assert.ok(bomb.length < 1024 * 1024, 'small on disk');
  assert.throws(() => docxBytesToText(bomb), /too large once unpacked/);
  // Declared size lies (says small) but the data inflates past the cap: inflation still stops.
  const lie = Buffer.from(bomb);
  const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(100, cd + 24);
  assert.throws(() => docxBytesToText(lie), /too large once unpacked/);
  assert.throws(() => documentXmlToText('<!DOCTYPE x [<!ENTITY e SYSTEM "http://example.com/x">]><w:t>&e;</w:t>'), /DTD/);
  assert.equal(documentXmlToText('<w:p><w:t>&e;&foo;</w:t></w:p>'), '&e;&foo;', 'unknown entities are never resolved');
  assert.throws(() => docxBytesToText(Buffer.from('not a zip at all, just text....')), /not a \.docx/);
  const src = read('src/main/docxText.ts');
  assert.doesNotMatch(src, /require\(|import\(|fetch|http|net\b|child_process|DOMParser|xml2js|eval/, 'no parser, network or code');
  assert.match(src, /maxOutputLength: MAX_DOCX_XML/);
});

test('soft delete: hidden for 10 s, undo restores everything, purge deletes for real', () => {
  const db = new CipherDb(tmpDb());
  const a = db.createBot({ name: 'A', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'B', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const room = db.createRoom({ name: 'AB', botIds: [a.id, b.id] });
  const chat = db.getBotChat(a.id);
  const m1 = db.addMessage({ chatId: chat.id, role: 'user', content: 'one' });
  const m2 = db.addMessage({ chatId: chat.id, role: 'user', content: 'two' });
  assert.equal(db.softDeleteMessages(chat.id, [m1.id], 'b1'), 1);
  assert.deepEqual(db.listMessages(chat.id).map((m) => m.id), [m2.id]);
  assert.equal(db.getMessage(chat.id, m1.id), null);
  db.undoBatch('b1');
  assert.deepEqual(db.listMessages(chat.id).map((m) => m.id), [m1.id, m2.id]);
  // bot delete hides the bot and the room it leaves with one member
  const r = db.softDeleteBot(a.id, 'b2');
  assert.deepEqual(r.deletedRoomIds, [room.id]);
  assert.equal(db.getBot(a.id), null);
  assert.equal(db.getRoom(room.id), null);
  assert.deepEqual(db.listBots().map((x) => x.id), [b.id]);
  assert.equal(db.listRooms().length, 0);
  db.undoBatch('b2');
  assert.equal(db.getBot(a.id)!.name, 'A');
  assert.deepEqual(db.getRoom(room.id)!.memberIds, [a.id, b.id]);
  // clear chat + purge
  db.softClearBotChat(a.id, 'b3');
  assert.equal(db.listMessages(chat.id).length, 0);
  db.purgeDeleted('b3');
  db.undoBatch('b3');
  assert.equal(db.listMessages(chat.id).length, 0, 'purged: undo is too late');
  db.softDeleteRoom(room.id, 'b4');
  db.softDeleteBot(b.id, 'b5');
  assert.ok(db.purgeDeleted(null) >= 2, 'startup purge removes every leftover');
  assert.equal(db.getRoom(room.id), null);
  assert.equal(db.getBot(b.id), null);
  assert.equal(db.getBot(a.id)!.name, 'A');
});

test('undo in main: one pending batch, 10 s timer, purged on a newer delete, lock, quit, restore and at startup', () => {
  assert.match(main, /const UNDO_MS = 10_000;/);
  const begin = main.slice(main.indexOf('function beginUndo'), main.indexOf('function undoDelete'));
  assert.match(begin, /finishUndo\(\);/);
  assert.match(begin, /setTimeout\([\s\S]*db\.purgeDeleted\(id\)[\s\S]*UNDO_MS\)/);
  assert.match(main, /checklistConsent\.revokeAll\(\);\s*finishUndo\(\);/, 'lock purges');
  assert.match(main, /app\.on\('will-quit', \(\) => \{\s*finishUndo\(\);/, 'quit purges');
  assert.match(main, /finishUndo\(\); \/\/ v1\.23: a pending delete is purged before the database is replaced/);
  assert.match(main, /db\.purgeDeleted\(null\);\s*db\.purgeUnsentPastedImages\(\);/, 'startup purges');
  assert.match(renderer, /showUndo\(r\.undoId/);
  assert.match(renderer, /showUndo\(result\.undoId/);
  assert.match(renderer, /showUndo\(rr\.undoId/);
  assert.match(renderer, /showUndo\(chat\.undoId/);
});

test('pasted screenshot: bytes checked in main (type sniffed, 5 MB), kept in cipher.db, shown only as data: URL', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'P', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const id = db.addPastedImage(chat.id, 'image/png', png);
  const msg = db.addMessage({ chatId: chat.id, role: 'user', content: 'see', image: `pasted:${id}` });
  const got = db.getPastedImage(chat.id, id)!;
  assert.equal(got.messageId, msg.id);
  assert.ok(got.bytes.equals(png));
  assert.equal(db.getPastedImage(chat.id + 999, id), null, 'only from its own chat');
  const unsent = db.addPastedImage(chat.id, 'image/png', png);
  assert.equal(db.purgeUnsentPastedImages(chat.id), 1);
  assert.equal(db.getPastedImage(chat.id, unsent), null);
  assert.ok(db.getPastedImage(chat.id, id), 'sent ones stay');
  const h = main.slice(main.indexOf("handle('image:pasted'"), main.indexOf("handle('image:discardPasted'"));
  assert.match(h, /raw\.byteLength > MAX_IMAGE_BYTES/);
  assert.match(h, /sniffImage\(bytes\)/);
  assert.match(h, /toDataUrl\(mime, bytes\)/);
  assert.doesNotMatch(h, /writeFile|fs\./, 'never saved into a folder');
  const paste = renderer.slice(renderer.indexOf("el.input.addEventListener('paste'"), renderer.indexOf('// ---------- v1.23: per-bot tool switches'));
  assert.match(paste, /api\.pasteImage\(chat\.id, new Uint8Array\(await file\.arrayBuffer\(\)\)\)/);
  assert.doesNotMatch(paste, /createObjectURL|fetch|https?:|getData\('text\/html'\)|\.src =/, 'never loaded from a URL');
});

test('overwrite: the v1.22 token-based confirm still runs, with a clear separate warning', () => {
  const src = read('src/main/fileWrite.ts');
  assert.match(src, /wants to REPLACE an existing file/);
  assert.match(src, /Replace file will OVERWRITE it; its current contents will be lost/);
  assert.match(src, /buttons: \['Cancel', 'Replace file', 'Save as new name'\]/);
  assert.match(main, /writeFile: \(chatId, bot, p, content\) => confirmAndWrite\(/);
});

test('focus mode hides the dock, search bar and frames; Esc exits; Liz icons via CSS mask (currentColor → accent)', () => {
  assert.match(css, /:root\.focus-mode #sidebar, :root\.focus-mode #search-bar, :root\.focus-mode #bottombar \{ display: none !important; \}/);
  assert.match(css, /:root\.focus-mode #titlebar \{ background: transparent; \}/);
  assert.match(renderer, /if \(e\.key === 'Escape' && inFocusMode\(\) && !e\.defaultPrevented\) setFocusMode\(false\);/);
  assert.ok(SHORTCUTS.some((s) => s.keys === 'Ctrl+Shift+F'));
  for (const f of ['focus-mode', 'reminder', 'tool-files', 'tool-search', 'tool-calculator', 'tool-checklist', 'tool-write-file']) {
    assert.match(css, new RegExp(`url\\("assets/cipher-${f}\\.svg"\\)`));
    const svg = read(`src/renderer/assets/cipher-${f}.svg`);
    assert.doesNotMatch(svg, /<script|on\w+=|href/i);
  }
  assert.match(css, /mask: var\(--ico\)[^;]*;/);
  assert.match(css, /\.ico \{[^}]*background-color: var\(--accent\)/);
  const items = plusMenuItems({ kind: 'bot', toolsEnabled: false, folderPath: null, busy: false, routineTime: null }).map((i) => i.id);
  assert.ok(items.includes('tools') && items.includes('reminder'));
});

test('Settings shows disk used: chats (db), files (folders, symlinks not followed), backups unknown unless before-restore copies', async () => {
  const dir = folder();
  const dbPath = path.join(dir, 'cipher.db');
  fs.writeFileSync(dbPath, Buffer.alloc(1000));
  fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(24));
  const f = folder();
  fs.writeFileSync(path.join(f, 'a'), Buffer.alloc(300));
  fs.mkdirSync(path.join(f, 'sub'));
  fs.writeFileSync(path.join(f, 'sub', 'b'), Buffer.alloc(200));
  fs.symlinkSync(dir, path.join(f, 'link'));
  const u = await diskUsage({ dbPath, folders: [f, f] });
  assert.equal(u.chats, 1024);
  assert.equal(u.files, 500);
  assert.equal(u.folders, 1);
  assert.equal(u.backups, null);
  assert.match(u.backupsNote, /does not keep track/);
  fs.writeFileSync(`${dbPath}.before-restore-20261012`, Buffer.alloc(77));
  fs.writeFileSync(`${dbPath}.before-restore-20261012-shm`, Buffer.alloc(23));
  const withCopy = await diskUsage({ dbPath, folders: [] });
  assert.equal(withCopy.backups, 100);
  assert.match(withCopy.backupsNote, /^1 before-restore copy /, 'sidecars are not counted as copies');
  let t = 0;
  const capped = await folderBytes([f], () => (t += 10_000));
  assert.equal(capped.capped, true, 'time cap');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.match(html, /<h3>Storage<\/h3>/);
});

test('policy and new channels: truthful text; no new network path; new channels are locked', () => {
  assert.match(policy, /Tool switches \(v1\.23\)[^\n]*all of them off except Files[^\n]*the phone and a bot\\?'s replies cannot/);
  assert.match(policy, /Reminders run like routines: no web search, no write file and no checklist/);
  assert.match(policy, /skipped and marked Missed; it is never run later/);
  assert.match(policy, /\.docx file's text[^\n]*2,000 parts[^\n]*20 MB once unpacked/);
  assert.match(policy, /kept inside cipher\.db with that message, not saved into any folder/);
  assert.match(policy, /hidden for 10 seconds so you can press Undo/);
  assert.match(policy, /Backups are saved wherever you choose[^\n]*unknown/);
  const lock = read('src/main/lock.ts');
  for (const ch of ['bots:setToolSwitches', 'undo:delete', 'image:pasted', 'reminders:add', 'disk:usage']) assert.ok(!lock.includes(`'${ch}'`), `${ch} is locked`);
  for (const f of ['reminders.ts', 'docxText.ts', 'diskUsage.ts', 'toolSwitches.ts']) {
    assert.doesNotMatch(read(`src/main/${f}`), /fetch\(|https?:\/\/|net\.|http\.request|electron/, `${f}: no network`);
  }
});

test('Reminders list uses the same 12-hour formatter as the picker and chat', () => {
  assert.equal(formatReminderAt('2026-10-12T16:45'), '2026-10-12 4:45 PM');
  assert.equal(formatReminderAt('2026-10-13T00:05'), '2026-10-13 12:05 AM');
  assert.equal(formatReminderAt('2026-10-13T12:00'), '2026-10-13 12:00 PM');
  assert.equal(formatReminderAt('2026-10-13T09:00').slice(11), formatMessageTime(new Date(2026, 9, 13, 9, 0).toISOString()));
  assert.match(renderer, /text\.textContent = `\$\{formatReminderAt\(r\.at\)\} · /);
  assert.doesNotMatch(renderer, /r\.at\.replace\('T', ' '\)/);
});

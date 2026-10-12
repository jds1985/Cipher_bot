import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { runChatTurn } from '../main/chatEngine';
import { executeToolCall, READ_FILE_TOOL } from '../main/readFileTool';
import { hashPassphrase, LOCK_FILE_NAME, UNLOCKED_CHANNELS, type LockRecord } from '../main/lock';
import { PhoneUnlock, PHONE_CHALLENGE_TTL_MS, PHONE_UNLOCK_TTL_MS, expectedResponse } from '../main/phoneUnlock';
import { PhoneServer } from '../main/phoneServer';
import { LOCK_TIMEOUTS, parseLockTimeout, shouldIdleLock } from '../main/lockTimeout';
import { BACKUP_SCHEDULES, isBackupDue, parseSchedule, runScheduledBackup, checkBackupFolder } from '../main/scheduledBackup';
import { networkMountFor, isNetworkFolder } from '../main/mountInfo';
import { FONTS, SETTINGS_EXPORT, buildSettingsExport, parseFont, parseMemoryImport, parseSettingsImport } from '../main/settingsFile';
import { REACTIONS, normalizeGroup, normalizeTags, parseReaction } from '../main/botMeta';
import { confirmFolderSummary } from '../main/folderSummary';
import { SearchConsent } from '../main/searchConsent';
import { parseReminderLine, validateReminder } from '../main/reminders';
import { REACTION_CHOICES, allTags, autoTitle, dockSections, formatActivity, plusMenuItems, tokensPerSecond } from '../renderer/view';
import { WHATS_NEW } from '../renderer/whatsNew';
import { POLICY_SECTIONS } from '../renderer/policy';

// v1.24: shared folder, lock timeout, tokens/s, reactions, auto-title, scheduled backup, activity, reminder import,
// dock folders, tags, summarize folder, edit history, fonts, phone unlock, settings export/import.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
const phoneSrc = read('src/main/phoneServer.ts');
const phoneApp = read('src/phone/app.js');
const phoneHtml = read('src/phone/index.html');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const renderer = read('src/renderer/renderer.ts');
const policy = POLICY_SECTIONS.map((s) => `${s.heading}\n${s.paragraphs.join('\n')}`).join('\n');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kdf = require(path.join(root, 'src', 'phone', 'kdf.js')) as { unlockResponse(p: string, ch: object): string; scrypt(...a: unknown[]): Uint8Array };

const tmpDir = (p = 'cipher-v124-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tmpDb = () => path.join(tmpDir(), 'cipher.db');
const PASS = 'zebra-lantern-4417';

function scripted(calls: unknown[], offered: string[][]): typeof fetch {
  let round = 0;
  return (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    offered.push((body.tools ?? []).map((t: { function: { name: string } }) => t.function.name));
    const first = round++ === 0;
    const msg = first && calls.length ? { role: 'assistant', content: '', tool_calls: calls } : { role: 'assistant', content: 'ok' };
    return new Response(`${JSON.stringify({ message: msg, done: false })}\n${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true })}\n`, { status: 200 });
  }) as unknown as typeof fetch;
}

test('version 1.24.0, schema 14, WHATS_NEW ≤5 lines of ≤90 chars, names stay Cipher, CSP fonts from self only', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '1.24.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.build.productName, 'Cipher');
  assert.equal(SCHEMA_VERSION, 14);
  assert.ok(WHATS_NEW.length <= 5);
  for (const l of WHATS_NEW) assert.ok(l.length <= 90, l);
  assert.doesNotMatch(html + WHATS_NEW.join(' ') + policy, /grok/i);
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), Object.keys(JSON.parse(execGitShow('package.json')).dependencies ?? {}).sort(), 'no new dependencies');
});

function execGitShow(file: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try { return execFileSync('git', ['show', `c08398b:${file}`], { cwd: root, encoding: 'utf8' }); } catch { return read(file); }
}

// ---------- 1. shared folder ----------
test('shared folder: read_file folder "shared" reads it; refuses outside paths and symlink escapes; read-only tool', async () => {
  const shared = tmpDir(); const outside = tmpDir();
  fs.writeFileSync(path.join(shared, 'team.txt'), 'shared notes');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(shared, 'link.txt'));
  fs.symlinkSync(outside, path.join(shared, 'linkdir'));
  const call = (p: string, folder = 'shared') => ({ function: { name: 'read_file', arguments: { path: p, folder } } });
  const ok = await executeToolCall(call('team.txt'), null, null, shared);
  assert.equal(ok.ok, true); assert.match(ok.content, /shared notes/); assert.match(ok.path, /^shared: /);
  for (const p of ['link.txt', 'linkdir/secret.txt', '../x.txt', path.join(outside, 'secret.txt')]) {
    const r = await executeToolCall(call(p), null, null, shared);
    assert.equal(r.ok, false, p); assert.doesNotMatch(r.content, /SECRET-OUTSIDE/);
  }
  const none = await executeToolCall(call('team.txt'), null, null, null);
  assert.equal(none.ok, false); assert.match(none.content, /No shared folder/);
  assert.deepEqual([...READ_FILE_TOOL.function.parameters.properties.folder.enum], ['main', 'second', 'shared']);
  assert.doesNotMatch(main, /shared:write|writeShared/);
});

test('shared folder: refused when the Files switch is off (not offered, never read), also if turned off mid-turn', async () => {
  const shared = tmpDir();
  fs.writeFileSync(path.join(shared, 'team.txt'), 'SHARED-CONTENT');
  const db = new CipherDb(tmpDb());
  const off = db.createBot({ name: 'Off', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(off.id);
  const offered: string[][] = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted([{ function: { name: 'read_file', arguments: { path: 'team.txt', folder: 'shared' } } }], offered), sharedFolder: () => shared },
    chat.id, 'read the shared folder', new AbortController().signal);
  assert.ok(offered.every((o) => !o.includes('read_file')));
  assert.ok(db.listMessages(chat.id).every((m) => !m.content.includes('SHARED-CONTENT')));
  // Files on at offer, switched off before execution: re-checked right before the read.
  const on = db.createBot({ name: 'On', systemPrompt: '', toolsEnabled: true, folderPath: null });
  const chat2 = db.getBotChat(on.id);
  const offered2: string[][] = [];
  let round = 0;
  const f = (async (u: string, init: RequestInit) => { if (round++ === 0) db.setToolSwitches(on.id, { files: false }); return scripted([{ function: { name: 'read_file', arguments: { path: 'team.txt', folder: 'shared' } } }], offered2)(u, init); }) as unknown as typeof fetch;
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: f, sharedFolder: () => shared }, chat2.id, 'x', new AbortController().signal);
  assert.ok(db.listMessages(chat2.id).every((m) => !m.content.includes('SHARED-CONTENT')));
  // Files on: read works and the hint is in the system prompt.
  const on2 = db.createBot({ name: 'On2', systemPrompt: '', toolsEnabled: true, folderPath: null });
  const chat3 = db.getBotChat(on2.id);
  const offered3: string[][] = [];
  await runChatTurn({ db, model: 'm', emit: () => undefined, fetchImpl: scripted([{ function: { name: 'read_file', arguments: { path: 'team.txt', folder: 'shared' } } }], offered3), sharedFolder: () => shared },
    chat3.id, 'x', new AbortController().signal);
  assert.ok(offered3[0].includes('read_file'));
  assert.ok(db.listMessages(chat3.id).some((m) => m.role === 'tool' && m.content.includes('SHARED-CONTENT')));
  db.close();
  assert.match(main, /executeToolCall|sharedFolder/);
  assert.match(read('src/main/chatEngine.ts'), /allowed\('read_file'\)[\s\S]{0,600}deps\.sharedFolder\?\.\(\)/);
  assert.match(main, /handle\('shared:pick'[\s\S]{0,200}fs\.realpath/);
});

// ---------- 2. lock timeout ----------
test('lock timeout: 1, 5, 15 or never; default 5; idle lock only when the lock is on and unlocked', () => {
  assert.deepEqual([...LOCK_TIMEOUTS], ['1', '5', '15', 'never']);
  assert.equal(parseLockTimeout(null), '5'); assert.equal(parseLockTimeout('bad'), '5'); assert.equal(parseLockTimeout('never'), 'never');
  assert.equal(shouldIdleLock({ enabled: true, locked: false, timeout: '5', idleSeconds: 301 }), true);
  assert.equal(shouldIdleLock({ enabled: true, locked: false, timeout: '5', idleSeconds: 299 }), false);
  assert.equal(shouldIdleLock({ enabled: true, locked: false, timeout: '1', idleSeconds: 61 }), true);
  assert.equal(shouldIdleLock({ enabled: true, locked: false, timeout: 'never', idleSeconds: 1e6 }), false);
  assert.equal(shouldIdleLock({ enabled: false, locked: false, timeout: '1', idleSeconds: 1e6 }), false);
  assert.equal(shouldIdleLock({ enabled: true, locked: true, timeout: '1', idleSeconds: 1e6 }), false);
  assert.match(main, /powerMonitor\.getSystemIdleTime\(\)[\s\S]{0,200}lockApp/);
  assert.match(html, /id="lock-timeout"[\s\S]*value="1"[\s\S]*value="5"[\s\S]*value="15"[\s\S]*value="never"/);
});

// ---------- 3. tokens per second ----------
test('tokens per second: off by default, measured in the window only', () => {
  assert.equal(tokensPerSecond(50, 2000), '25.0 tokens/s');
  assert.equal(tokensPerSecond(1, 2000), null);
  assert.equal(tokensPerSecond(10, 50), null);
  assert.match(main, /handle\('tps:get', \(\) => db\.getSetting\(TPS_KEY\) === '1'\)/);
  assert.match(html, /<input type="checkbox" id="tps-switch" \/>/);
  assert.match(renderer, /state\.showTps && state\.tps\.has\(m\.id\)/);
});

// ---------- 4. reactions ----------
test('reactions: five choices matching Liz\'s icons, stored locally, toggle off; bad ones refused', () => {
  assert.deepEqual([...REACTIONS], ['like', 'heart', 'laugh', 'check', 'star']);
  assert.deepEqual(REACTION_CHOICES.map((r) => r.id), [...REACTIONS]);
  for (const r of REACTIONS) {
    assert.ok(fs.existsSync(path.join(root, 'src/renderer/assets', `cipher-react-${r}.svg`)));
    assert.match(css, new RegExp(`\\.ico-react-${r} \\{ --ico: url\\("assets/cipher-react-${r}\\.svg"\\); \\}`));
  }
  assert.equal(parseReaction(null), null);
  assert.throws(() => parseReaction('rocket'), /Unknown reaction/);
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'R', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const m = db.addMessage({ chatId: chat.id, role: 'assistant', content: 'hi' });
  assert.equal(db.setReaction(chat.id, m.id, 'heart').reaction, 'heart');
  assert.equal(db.listMessages(chat.id)[0].reaction, 'heart');
  assert.equal(db.setReaction(chat.id, m.id, null).reaction ?? null, null);
  assert.throws(() => db.setReaction(chat.id + 999, m.id, 'like'));
  db.close();
  assert.match(phoneSrc, /reactions\?/);
});

// ---------- 5. auto-title ----------
test('auto-title from the job, editable (stops once the user types a name)', () => {
  assert.equal(autoTitle('Help me plan my week and keep answers short.'), 'Plan my week and');
  assert.equal(autoTitle('You are a friendly French tutor. Correct my grammar.'), 'Friendly French tutor');
  assert.equal(autoTitle('   '), '');
  assert.ok(autoTitle('x'.repeat(100)).length <= 40);
  assert.match(renderer, /state\.editBotId !== null \|\| state\.nameTouched\) return;/);
  assert.match(html, /<input id="bot-name" maxlength="80" required/);
});

// ---------- 6. scheduled backup ----------
test('scheduled backup: daily/weekly due logic; writes only into the chosen local folder; never lock.json; never deletes', async () => {
  assert.deepEqual([...BACKUP_SCHEDULES], ['off', 'daily', 'weekly']);
  assert.equal(parseSchedule('x'), 'off');
  const now = new Date('2026-10-12T10:00:00');
  assert.equal(isBackupDue('off', null, now), false);
  assert.equal(isBackupDue('daily', null, now), true);
  assert.equal(isBackupDue('daily', new Date(now.getTime() - 23 * 3600e3).toISOString(), now), false);
  assert.equal(isBackupDue('daily', new Date(now.getTime() - 25 * 3600e3).toISOString(), now), true);
  assert.equal(isBackupDue('weekly', new Date(now.getTime() - 3 * 86400e3).toISOString(), now), false);
  assert.equal(isBackupDue('weekly', new Date(now.getTime() - 8 * 86400e3).toISOString(), now), true);
  const userData = tmpDir();
  const dbFile = path.join(userData, 'cipher.db');
  const db = new CipherDb(dbFile);
  fs.writeFileSync(path.join(userData, LOCK_FILE_NAME), JSON.stringify(await hashPassphrase(PASS)));
  const dest = tmpDir('cipher-v124-backups-');
  fs.writeFileSync(path.join(dest, 'old-backup.db'), 'keep me');
  const writes: string[] = [];
  const out = await runScheduledBackup({ folder: dest, now, backup: (p) => { writes.push(p); return db.backup(p); } });
  assert.equal(writes.length, 1);
  assert.equal(path.dirname(out), fs.realpathSync(dest));
  assert.deepEqual(fs.readdirSync(dest).sort(), [path.basename(out), 'old-backup.db'].sort());
  assert.equal(fs.readFileSync(path.join(dest, 'old-backup.db'), 'utf8'), 'keep me');
  const bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
  const hash = JSON.parse(fs.readFileSync(path.join(userData, LOCK_FILE_NAME), 'utf8')).hash as string;
  assert.ok(!bytes.includes(Buffer.from(hash)), 'backup has no lock hash');
  assert.ok(!bytes.includes(Buffer.from(PASS)));
  await assert.rejects(runScheduledBackup({ folder: dest, now, backup: async () => undefined }), /already exists/, 'never overwrites');
  await assert.rejects(runScheduledBackup({ folder: 'relative/dir', now, backup: async () => undefined }));
  await assert.rejects(runScheduledBackup({ folder: path.join(dest, 'missing'), now, backup: async () => undefined }));
  await assert.rejects(checkBackupFolder(path.join(dest, 'old-backup.db')));
  await assert.rejects(runScheduledBackup({ folder: 'http://example.com/x', now, backup: async () => undefined }));
  db.close();
  assert.doesNotMatch(read('src/main/scheduledBackup.ts'), /unlink|rm\(|rmSync|fetch|http/);
  assert.match(main, /handle\('backupsched:pick'[\s\S]{0,400}isNetworkFolder\(dir\)[\s\S]{0,300}nativeAsk/);
});

test('backup folder: network/cloud mounts detected from /proc/mounts fstype and warned about', () => {
  const mounts = [
    '/dev/sda1 / ext4 rw 0 0',
    '/dev/sdb1 /media/me/USB vfat rw 0 0',
    '//nas/share /mnt/nas cifs rw 0 0',
    'nas:/export /mnt/nfs nfs4 rw 0 0',
    'me@host:/x /home/me/remote fuse.sshfs rw 0 0',
    'gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0',
    '//srv/My\\040Share /media/me/My\\040Share smb3 rw 0 0',
    'rclone: /home/me/gdrive fuse.rclone rw 0 0',
  ].join('\n');
  const net = (p: string) => networkMountFor(p, mounts).network;
  assert.equal(net('/home/me/backups'), false);
  assert.equal(net('/media/me/USB/backups'), false);
  assert.equal(net('/mnt/nas/backups'), true);
  assert.equal(networkMountFor('/mnt/nas/backups', mounts).fstype, 'cifs');
  assert.equal(net('/mnt/nfs'), true);
  assert.equal(net('/home/me/remote/b'), true);
  assert.equal(net('/run/user/1000/gvfs/smb-share:server=x,share=y/b'), true);
  assert.equal(net('/media/me/My Share/b'), true);
  assert.equal(net('/home/me/gdrive/b'), true);
  assert.equal(net('/mnt/nas2'), false, 'prefix must be a whole path segment');
  assert.equal(isNetworkFolder('/x', () => { throw new Error('no proc'); }).network, false);
});

// ---------- 7. activity line ----------
test('activity line: last reply time and last tool used, in the header as text only', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'A', systemPrompt: '', toolsEnabled: true, folderPath: null });
  const chat = db.getBotChat(bot.id);
  assert.deepEqual(db.botActivity(bot.id), { lastReplyAt: null, lastTool: null, lastToolAt: null });
  db.addMessage({ chatId: chat.id, role: 'tool', content: 'x', toolName: 'calculator' } as never);
  db.addMessage({ chatId: chat.id, role: 'assistant', content: 'done' });
  const a = db.botActivity(bot.id);
  assert.ok(a.lastReplyAt); assert.equal(a.lastTool, 'calculator');
  assert.match(formatActivity(a), /^Last reply \d{1,2}:\d{2} (AM|PM) · last tool calculator$/);
  assert.equal(formatActivity({ lastReplyAt: null, lastTool: null }), '');
  db.close();
  const header = /<header id="chat-header">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
  assert.match(header, /<span id="chat-activity" class="activity-line"/);
  assert.doesNotMatch(header, /<button|<input|<label/);
});

// ---------- 8. reminder from a text line ----------
test('reminder import from one line: date, time, prompt; validated like the form', () => {
  assert.deepEqual(parseReminderLine('2026-10-14 9:30 AM Call the plumber'), { at: '2026-10-14T09:30', prompt: 'Call the plumber' });
  assert.deepEqual(parseReminderLine('2026-10-14 16:45 Water the plants'), { at: '2026-10-14T16:45', prompt: 'Water the plants' });
  assert.deepEqual(parseReminderLine('10/14/2026 12 PM - Lunch'), { at: '2026-10-14T12:00', prompt: 'Lunch' });
  assert.deepEqual(parseReminderLine('2026-10-14T00:05 midnight snack'), { at: '2026-10-14T00:05', prompt: 'midnight snack' });
  assert.deepEqual(parseReminderLine('2026-10-14 12:15 am late'), { at: '2026-10-14T00:15', prompt: 'late' });
  for (const bad of ['', 'tomorrow call mom', '2026-10-14 25:00 x', '2026-10-14 13:00 PM x', '2026-10-14 9:30', 42]) assert.throws(() => parseReminderLine(bad), String(bad));
  const now = new Date('2026-10-12T10:00:00');
  const ok = parseReminderLine('2026-10-14 9:30 AM Call the plumber');
  assert.doesNotThrow(() => validateReminder(ok.at, ok.prompt, now));
  assert.match(main, /handle\('reminders:import'[\s\S]{0,200}parseReminderLine\(line\)[\s\S]{0,80}db\.addReminder/);
});

// ---------- 9 + 10. dock folders and tags ----------
test('dock folders (collapsible) and tags with a dock filter', () => {
  assert.deepEqual(normalizeTags(' work, Writing ,work,,x'.split(',')), ['work', 'writing', 'x']);
  assert.throws(() => normalizeTags(['a', 'b', 'c', 'd', 'e', 'f']), /Up to 5 tags/);
  assert.deepEqual(normalizeTags(42), []);
  assert.equal(normalizeGroup('  Work  '), 'Work');
  assert.equal(normalizeGroup(''), '');
  assert.ok(normalizeGroup('x'.repeat(80)).length <= 30);
  const db = new CipherDb(tmpDb());
  const a = db.createBot({ name: 'A', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'B', systemPrompt: '', toolsEnabled: false, folderPath: null });
  db.createBot({ name: 'C', systemPrompt: '', toolsEnabled: false, folderPath: null });
  assert.deepEqual(db.setBotTags(a.id, ['work', 'notes']).tags, ['work', 'notes']);
  db.setBotTags(b.id, ['Work']);
  assert.equal(db.setBotGroup(b.id, 'Team').group, 'Team');
  const bots = db.listBots();
  assert.deepEqual(allTags(bots), ['notes', 'work']);
  const all = dockSections(bots, '', []);
  assert.deepEqual(all.map((s) => [s.group, s.bots.map((x) => x.name)]), [['', ['A', 'C']], ['Team', ['B']]]);
  assert.equal(dockSections(bots, '', ['Team'])[1].collapsed, true);
  const work = dockSections(bots, 'work', []);
  assert.deepEqual(work.flatMap((s) => s.bots.map((x) => x.name)), ['A', 'B']);
  db.close();
  for (const f of ['cipher-dock-folders', 'cipher-tags', 'cipher-shared-folder']) {
    const svg = read(`src/renderer/assets/${f}.svg`);
    assert.match(svg, /currentColor/); assert.doesNotMatch(svg, /<script|href=|url\(http/i);
    assert.match(css, new RegExp(`assets/${f}\\.svg`));
  }
  assert.match(html, /id="tag-filter"/);
  assert.match(main, /handle\('dock:setGroupsCollapsed'/);
});

// ---------- 11. summarize folder ----------
test('summarize folder: asks first in main, one-time token, Files re-checked before reading', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha text'); fs.writeFileSync(path.join(dir, 'b.md'), 'beta text');
  fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.from([0, 1, 2]));
  const consent = new SearchConsent();
  let bot = { name: 'S', folderPath: dir, filesOn: true };
  let asked = 0;
  const deps = (answer: number, onAsk?: () => void) => ({ consent, isLocked: () => false, bot: () => bot, ask: async () => { asked++; onAsk?.(); return answer; } });
  const text = await confirmFolderSummary(deps(1), 7);
  assert.equal(asked, 1);
  assert.match(text!, /alpha text/); assert.match(text!, /beta text/); assert.doesNotMatch(text!, /c\.bin/);
  assert.equal(await confirmFolderSummary(deps(0), 7), null, 'cancel reads nothing');
  await assert.rejects(confirmFolderSummary(deps(1, () => { bot = { ...bot, filesOn: false }; }), 7), /Files was turned off/);
  bot = { name: 'S', folderPath: dir, filesOn: false };
  asked = 0;
  await assert.rejects(confirmFolderSummary(deps(1), 7), /Turn on Files/);
  assert.equal(asked, 0, 'never even asks when Files is off');
  assert.match(main, /summaryConsent\.revokeAll\(\)/);
  const items = plusMenuItems({ kind: 'bot', toolsEnabled: false, folderPath: null, busy: false, routineTime: null });
  assert.equal(items.find((i) => i.id === 'summarize')?.disabled, true);
  assert.equal(plusMenuItems({ kind: 'bot', toolsEnabled: true, folderPath: dir, busy: false, routineTime: null }).find((i) => i.id === 'summarize')?.disabled, false);
});

// ---------- 12. edit history ----------
test('message edit history: only your own messages; old text kept and listed', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'E', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const chat = db.getBotChat(bot.id);
  const u = db.addMessage({ chatId: chat.id, role: 'user', content: 'frist draft' });
  const r = db.addMessage({ chatId: chat.id, role: 'assistant', content: 'reply' });
  const e1 = db.editMessage(chat.id, u.id, 'first draft');
  assert.equal(e1.content, 'first draft'); assert.equal(e1.edited, true);
  db.editMessage(chat.id, u.id, 'final draft');
  assert.deepEqual(db.listMessageEdits(chat.id, u.id).map((e) => e.oldText), ['frist draft', 'first draft']);
  assert.throws(() => db.editMessage(chat.id, r.id, 'hacked'));
  assert.throws(() => db.editMessage(chat.id, u.id, '   '));
  db.close();
  assert.match(html, /id="edits-modal"/);
});

// ---------- 13. fonts ----------
test('fonts: three bundled fonts plus system, local files only, no web font links', () => {
  assert.deepEqual([...FONTS], ['system', 'sans', 'serif', 'mono']);
  assert.equal(parseFont('comic'), 'system');
  for (const f of ['DejaVuSans.ttf', 'DejaVuSerif.ttf', 'DejaVuSansMono.ttf', 'DejaVu-LICENSE.txt']) assert.ok(fs.existsSync(path.join(root, 'src/renderer/assets/fonts', f)), f);
  const faces = css.match(/@font-face \{[^}]*\}/g) ?? [];
  assert.equal(faces.length, 3);
  for (const f of faces) assert.match(f, /src: url\("assets\/fonts\/DejaVu[A-Za-z]+\.ttf"\)/);
  assert.doesNotMatch(css + html, /fonts\.googleapis|fonts\.gstatic|@import|url\(["']?(https?:|\/\/)/i);
});

// ---------- 14. phone unlock ----------
test('phone kdf.js scrypt matches Node; the response matches main\'s expected answer', async () => {
  const rec = await hashPassphrase(PASS);
  const nonce = crypto.randomBytes(32).toString('hex');
  const ch = { nonce, salt: rec.salt, N: rec.N, r: rec.r, p: rec.p, keylen: rec.keylen };
  assert.equal(kdf.unlockResponse(PASS, ch), expectedResponse(rec, nonce).toString('hex'));
  assert.notEqual(kdf.unlockResponse('wrong-pass-123', ch), expectedResponse(rec, nonce).toString('hex'));
  assert.match(phoneHtml, /<script src="kdf\.js"><\/script>\s*<script src="app\.js"/);
});

test('phone unlock: one-time challenge, throttled, short session, revoked on lock; unreadable lock fails closed', async () => {
  const rec = await hashPassphrase(PASS);
  let t = 1_000_000;
  const pu = new PhoneUnlock({ record: () => rec, now: () => t });
  assert.equal(pu.required(), true); assert.equal(pu.isUnlocked('s'), false);
  const c1 = pu.challenge('s'); assert.ok(c1.ok);
  const ch = (c1 as { challenge: object & { nonce: string } }).challenge;
  assert.ok(!('hash' in ch));
  const good = kdf.unlockResponse(PASS, ch);
  assert.equal(pu.answer('s', good).ok, true);
  assert.equal(pu.isUnlocked('s'), true);
  assert.equal(pu.answer('s', good).ok, false, 'a challenge is one-time (replay refused)');
  t += PHONE_UNLOCK_TTL_MS + 1; assert.equal(pu.isUnlocked('s'), false, 'session expires');
  const c2 = pu.challenge('s'); t += PHONE_CHALLENGE_TTL_MS + 1;
  assert.equal(pu.answer('s', kdf.unlockResponse(PASS, (c2 as { challenge: object }).challenge)).ok, false, 'challenge expires');
  for (let i = 0; i < 5; i++) { pu.challenge('s'); pu.answer('s', '00'.repeat(32)); }
  const blocked = pu.challenge('s');
  assert.equal(blocked.ok, false); assert.ok((blocked as { waitMs: number }).waitMs > 0);
  const pu2 = new PhoneUnlock({ record: () => rec, now: () => t });
  const c3 = pu2.challenge('x') as { challenge: object };
  pu2.answer('x', kdf.unlockResponse(PASS, c3.challenge));
  assert.equal(pu2.isUnlocked('x'), true);
  pu2.revokeAll(); assert.equal(pu2.isUnlocked('x'), false);
  const bad = new PhoneUnlock({ record: () => 'invalid' });
  assert.equal(bad.required(), true); assert.equal(bad.challenge('s').ok, false);
  assert.equal(new PhoneUnlock({ record: () => null }).isUnlocked('s'), true, 'no lock: nothing to unlock');
  assert.match(main, /finishUndo\(\);[^\n]*\n\s*summaryConsent\.revokeAll\(\);[^\n]*\n\s*phoneUnlock\?\.revokeAll\(\);/);
});

test('phone unlock over HTTP: the passphrase, hash and lock.json never cross the phone link; desktop-only routes 403', async () => {
  const rec: LockRecord = await hashPassphrase(PASS);
  const db = new CipherDb(tmpDb());
  db.createBot({ name: 'Phone bot', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const phoneUnlock = new PhoneUnlock({ record: () => rec });
  const port = 28400 + Math.floor(Math.random() * 300);
  const staticDir = fs.existsSync(path.join(__dirname, '..', 'phone', 'index.html')) ? path.join(__dirname, '..', 'phone') : path.join(root, 'src', 'phone');
  const server = new PhoneServer({ db, staticDir, model: 'fake', port, phoneUnlock, sendChat: async () => {}, stopChat: () => {}, sendRoom: async () => {}, stopRoom: () => {} });
  server.start();
  await server.whenListening();
  const base = `http://127.0.0.1:${port}`;
  const wire: string[] = [];
  const call = async (p: string, method = 'GET', body?: unknown, token?: string) => {
    const reqBody = body === undefined ? undefined : JSON.stringify(body);
    if (reqBody) wire.push(reqBody);
    const res = await fetch(`${base}${p}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(reqBody ? { 'Content-Type': 'application/json' } : {}) }, body: reqBody });
    const text = await res.text(); wire.push(text);
    return { status: res.status, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
  };
  try {
    const paired = await call('/api/pair', 'POST', { code: server.status().pairingCode });
    const token = String(paired.body.token);
    const locked = await call('/api/bots', 'GET', undefined, token);
    assert.equal(locked.status, 401); assert.equal(locked.body.phoneLocked, true);
    const ch = await call('/api/unlock/challenge', 'POST', {}, token);
    assert.equal(ch.status, 200);
    assert.deepEqual(Object.keys(ch.body).sort(), ['N', 'keylen', 'nonce', 'p', 'r', 'salt']);
    const wrong = await call('/api/unlock/answer', 'POST', { response: kdf.unlockResponse('not-the-pass-1', ch.body) }, token);
    assert.equal(wrong.status, 401);
    const ch2 = await call('/api/unlock/challenge', 'POST', {}, token);
    const ok = await call('/api/unlock/answer', 'POST', { response: kdf.unlockResponse(PASS, ch2.body) }, token);
    assert.equal(ok.status, 200);
    const bots = await call('/api/bots', 'GET', undefined, token);
    assert.equal(bots.status, 200);
    for (const p of ['/api/backup', '/api/shared-folder', '/api/tags', '/api/dock', '/api/reactions', '/api/edits', '/api/summarize', '/api/fonts', '/api/lock', '/api/export', '/api/import']) {
      assert.equal((await call(p, 'GET', undefined, token)).status, 403, p);
    }
    server.closeStreams();
    assert.equal((await call('/api/bots', 'GET', undefined, token)).status, 401, 'lock / stop voids the phone unlock');
    const all = wire.join('\n');
    assert.ok(!all.includes(PASS), 'passphrase never on the wire');
    assert.ok(!all.includes(rec.hash), 'hash never on the wire');
    assert.ok(!all.includes(Buffer.from(rec.hash, 'base64').toString('hex')));
    assert.doesNotMatch(all, /lock\.json|"hash"/);
  } finally {
    server.stop();
    db.close();
  }
  assert.doesNotMatch(phoneApp, /JSON\.stringify\(\{[^}]*pass/);
  assert.match(phoneApp, /\$\('unlock-pass'\)\.value = '';/);
  assert.match(policy, /passphrase is never sent/);
});

// ---------- 15. settings export / import ----------
test('settings export: no chats, no lock, no paths, memory only when opted in; import validated', () => {
  const db = new CipherDb(tmpDb());
  const bot = db.createBot({ name: 'Mem', systemPrompt: 'job', toolsEnabled: true, folderPath: '/home/me/private' });
  db.setBotMemory(bot.id, 'MEMORY-NOTE-TEXT');
  db.addMessage({ chatId: db.getBotChat(bot.id).id, role: 'user', content: 'CHAT-SECRET' });
  db.setSetting('accent', 'teal'); db.setSetting('font', 'serif'); db.setSetting('lock_timeout_min', '15');
  db.setSetting('shared_folder', '/home/me/shared'); db.setSetting('backup_folder', '/home/me/bk');
  const out = buildSettingsExport((k) => db.getSetting(k), '1.24.0');
  const obj = JSON.parse(out);
  assert.equal(obj.app, 'Cipher Bot'); assert.equal(obj.kind, 'settings');
  assert.deepEqual(obj.settings, { accent: 'teal', font: 'serif', lock_timeout_min: '15' });
  for (const bad of ['CHAT-SECRET', 'MEMORY-NOTE-TEXT', '/home/me', 'hash', 'salt', 'passphrase', 'messages', 'chats']) assert.ok(!out.includes(bad), bad);
  const withMem = buildSettingsExport((k) => db.getSetting(k), '1.24.0', db.memoryNotes());
  assert.ok(withMem.includes('MEMORY-NOTE-TEXT')); assert.ok(!withMem.includes('CHAT-SECRET'));
  assert.ok(!Object.keys(SETTINGS_EXPORT).some((k) => /lock_hash|passphrase|folder|search|pair|online/.test(k)), 'never paths, lock data or Online');
  // Import: only known keys with allowed values.
  const items = parseSettingsImport(JSON.stringify({ app: 'Cipher Bot', kind: 'settings', settings: { accent: 'rose', font: 'evil', online: '1', shared_folder: '/etc', lock_timeout_min: 'never', __proto__: 'x' } }));
  assert.deepEqual(items, [{ key: 'accent', value: 'rose' }, { key: 'lock_timeout_min', value: 'never' }]);
  for (const bad of ['nope', '{}', JSON.stringify({ app: 'Other', kind: 'settings', settings: {} }), 'x'.repeat(20000), JSON.stringify({ app: 'Cipher Bot', kind: 'settings', settings: { online: '1' } })]) {
    assert.throws(() => parseSettingsImport(bad));
  }
  assert.deepEqual(parseMemoryImport(withMem, 2000), [{ bot: 'Mem', note: 'MEMORY-NOTE-TEXT' }]);
  assert.deepEqual(parseMemoryImport(JSON.stringify({ memory: [{ bot: 1, note: 'x' }, { bot: 'a', note: 'y'.repeat(3000) }] }), 2000), []);
  db.close();
  assert.match(main, /includeMemory === true \? db\.memoryNotes\(\) : null/);
  assert.match(main, /if \(includeMemory === true\) \{/);
  assert.match(html, /id="settings-memory"/);
});

test('new IPC is desktop-only and lock-guarded; preload exposes it; no new network path', () => {
  const channels = ['shared:get', 'shared:pick', 'shared:clear', 'locktimeout:set', 'tps:set', 'font:set', 'messages:react', 'messages:edit', 'messages:edits',
    'bots:activity', 'bots:setTags', 'bots:setGroup', 'dock:setGroupsCollapsed', 'reminders:import', 'folder:summarize', 'backupsched:set', 'backupsched:pick', 'settings:export', 'settings:import'];
  for (const c of channels) {
    assert.match(main, new RegExp(`handle\\('${c}'`), c);
    assert.ok(!UNLOCKED_CHANNELS.has(c), c);
    assert.match(preload, new RegExp(`'${c}'`), c);
  }
  for (const f of ['scheduledBackup.ts', 'mountInfo.ts', 'settingsFile.ts', 'botMeta.ts', 'folderSummary.ts', 'phoneUnlock.ts', 'lockTimeout.ts']) {
    assert.doesNotMatch(read(`src/main/${f}`), /fetch\(|https?:\/\/|net\.|http\.request|electron'.*net/, f);
  }
  assert.doesNotMatch(read('src/phone/kdf.js'), /fetch\(|XMLHttpRequest|https?:\/\//);
  assert.match(policy, /Shared folder \(v1\.24\)/);
  assert.match(policy, /Scheduled backup \(v1\.24\)[\s\S]*never includes lock\.json/);
  assert.match(policy, /Settings file \(v1\.24\)/);
});

test('v1.24 layout: reactions white on own bubbles, choices on hover/focus only, picked always shown; dark tag filter', () => {
  assert.match(css, /\.msg\.user \.react-btn \.ico \{ filter: brightness\(0\) invert\(1\); opacity: 0\.8; \}/);
  assert.match(css, /\.msg\.user \.msg-act img \{ filter: brightness\(0\) invert\(1\); opacity: 0\.8; \}/, 'same filter as quote and pin');
  assert.match(css, /\.react-btn \{ opacity: 0;/);
  assert.match(css, /\.msg:hover \.react-btn, \.msg:focus-within \.react-btn \{ opacity: 0\.55; \}/);
  assert.match(css, /\.react-btn\[aria-pressed="true"\][^{]*\{ opacity: 1;/);
  assert.doesNotMatch(css, /\.react-btn[^{]*\{[^}]*display: none/, 'hidden choices stay in the tab order');
  assert.match(css, /\.tag-filter-wrap select \{ appearance: none;[^}]*color-scheme: dark;[^}]*max-width: 100%;[^}]*background: var\(--panel2\)/);
  assert.doesNotMatch(css, /\.tag-filter-wrap select \{[^}]*max-width: \d+px/, 'no fixed width that truncates the tag');
  assert.match(css, /\.tag-filter-wrap select option \{ background: var\(--panel2\); color: var\(--text\); \}/);
  assert.match(renderer, /b\.setAttribute\('aria-pressed', String\(m\.reaction === r\.id\)\)/);
});

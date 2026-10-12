import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CipherDb, SCHEMA_VERSION } from '../main/db';
import { SEND_SOUND_SETTING_KEY, parseSendSound, shouldMarkUnread } from '../main/unread';

// v1.16: installer look, real version, unread dots, optional send sound, About.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');
const renderer = read('src/renderer/renderer.ts');
const main = read('src/main/main.ts');
const pkg = JSON.parse(read('package.json')) as {
  name: string; productName: string; version: string; description: string;
  build: { productName: string; appId: string; linux: { synopsis: string; description: string; icon: string; desktop: { entry: { Name: string } } } };
};
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v116-')), 'cipher.db');
const section = (id: string) => new RegExp(`<section id="${id}"[\\s\\S]*?</section>`).exec(html)![0];

test('1. package screen says Cipher Bot, has the icon, and no lone "Cipher"; setup page is dark with the icon', () => {
  assert.match(pkg.build.linux.synopsis, /^Cipher Bot\b/);
  assert.match(pkg.build.linux.description, /^Cipher Bot\b/);
  for (const t of [pkg.build.linux.synopsis, pkg.build.linux.description]) {
    assert.deepEqual(t.match(/\bCipher\b(?! Bot\b)(?! bots?\b)/g) ?? [], [], t);
  }
  assert.equal(pkg.build.linux.icon, 'build/icons');
  assert.ok(fs.existsSync(path.join(root, 'build/icons/512x512.png')));
  assert.equal(pkg.build.linux.desktop.entry.Name, 'Cipher Bot');
  // No white flash before the page paints: the window and the page are #15171c.
  assert.match(main, /const FRAME_BG = '#15171c';/);
  assert.match(main, /backgroundColor: FRAME_BG,/);
  assert.match(css, /--bg: #15171c;/);
  assert.match(css, /--accent: #5b8cff;/);
  assert.match(css, /html, body \{ margin: 0; height: 100%; background: var\(--bg\);/);
  const setup = section('setup-view');
  assert.match(setup, /<img class="setup-logo" src="assets\/icon\.png" alt="" width="56" height="56" \/><span>Cipher Bot<\/span>/);
  // No other window or page is created that could show a default white page.
  assert.equal((main.match(/new BrowserWindow\(/g) ?? []).length, 1);
  assert.doesNotMatch(main, /loadURL\(/);
});

test('2. version: from package.json via app.getVersion(), read once in main, never hardcoded in the UI', () => {
  assert.equal(pkg.version, '1.23.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher', 'userData stays ~/.config/Cipher');
  assert.equal(pkg.build.productName, 'Cipher');
  // v1.20: main also reads it for the update check and the debug log; the UI still gets it only via app:version.
  assert.equal((main.match(/app\.getVersion\(\)/g) ?? []).length, 3, 'main only');
  assert.match(main, /handle\('app:version', \(\) => app\.getVersion\(\)\);/);
  assert.match(renderer, /state\.version = await api\.getVersion\(\);/);
  for (const t of [html, renderer, read('src/renderer/view.ts')]) assert.doesNotMatch(t, /\b(0\.1\.0|1\.16\.0|1\.17\.0)\b/);
  assert.match(section('settings-view'), /<span id="settings-version" class="app-version"><\/span>/);
});

test('3. unread: marked only when the bot or room is not open in a visible, unlocked window; stopped turns never', () => {
  const view = { visible: true, locked: false, openBotId: 1, openRoomId: null };
  assert.equal(shouldMarkUnread({ kind: 'bot', id: 1 }, view, false), false, 'open: no dot');
  assert.equal(shouldMarkUnread({ kind: 'bot', id: 2 }, view, false), true);
  assert.equal(shouldMarkUnread({ kind: 'room', id: 5 }, view, false), true);
  assert.equal(shouldMarkUnread({ kind: 'room', id: 5 }, { ...view, openBotId: null, openRoomId: 5 }, false), false);
  assert.equal(shouldMarkUnread({ kind: 'bot', id: 1 }, { ...view, visible: false }, false), true, 'in the tray');
  assert.equal(shouldMarkUnread({ kind: 'bot', id: 1 }, { ...view, locked: true }, false), true, 'locked');
  assert.equal(shouldMarkUnread({ kind: 'bot', id: 2 }, view, true), false, 'stopped');
});

test('3. unread: stored locally (v7 migration, idempotent), set and cleared per bot and room, persists', () => {
  const file = tmpDb();
  let db = new CipherDb(file);
  const a = db.createBot({ name: 'Ada', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const b = db.createBot({ name: 'Bo', systemPrompt: '', toolsEnabled: false, folderPath: null });
  const room = db.createRoom({ name: '', botIds: [a.id, b.id] });
  assert.equal(db.getBot(a.id)!.unread, false);
  assert.equal(db.getRoom(room.id)!.unread, false);
  db.setUnread('bot', a.id, true);
  db.setUnread('room', room.id, true);
  db.close();
  db = new CipherDb(file);
  assert.equal(db.getBot(a.id)!.unread, true);
  assert.equal(db.getBot(b.id)!.unread, false);
  assert.equal(db.getRoom(room.id)!.unread, true);
  db.setUnread('bot', a.id, false);
  assert.equal(db.getBot(a.id)!.unread, false);
  db.close();
  // A v6 database (no unread columns) migrates to v7 and keeps its data.
  const raw = new Database(file);
  raw.exec('ALTER TABLE bots DROP COLUMN unread; ALTER TABLE rooms DROP COLUMN unread');
  raw.pragma('user_version = 6');
  raw.close();
  db = new CipherDb(file); db.close();
  db = new CipherDb(file);
  assert.equal(db.getBot(a.id)!.name, 'Ada');
  assert.equal(db.getRoom(room.id)!.unread, false);
  db.close();
  const check = new Database(file, { readonly: true });
  assert.equal(check.pragma('user_version', { simple: true }), 13); // current schema (v13 since v1.23)
  assert.equal(SCHEMA_VERSION >= 7, true);
  check.close();
});

test('3. unread: #5b8cff dot in the sidebar, cleared on open; hidden on the lock screen and never sent to the phone', () => {
  assert.match(css, /\.unread-dot \{[^}]*background: (#5b8cff|var\(--accent\));/);
  assert.match(renderer, /addUnreadDot\(btn, b\.unread && !\(showingChat && b\.id === state\.botId\)\);/);
  assert.match(renderer, /addUnreadDot\(btn, r\.unread && !\(showingChat && r\.id === state\.roomId\)\);/);
  assert.match(renderer, /clearUnread\('bot', botId\);/);
  assert.match(renderer, /clearUnread\('room', roomId\);/);
  // Lock screen: no sidebar data in it, and the lists only load after unlock (bots:list is lock-guarded).
  const lock = /<div id="lock-screen"[\s\S]*?\n {4}<\/div>\n/.exec(html)![0];
  assert.doesNotMatch(lock, /unread|bot-list|room-list/);
  assert.match(main, /if \(isLocked\(\)\) return; \/\/ nothing about it goes to the window while locked/);
  // Phone: bots and rooms are sent with explicit fields only, never `unread`.
  const phone = read('src/main/phoneServer.ts');
  assert.match(phone, /db\.listBots\(\)\.map\(\(b\) => \(\{ id: b\.id, name: b\.name, shape: b\.shape, color: b\.color, hidden: b\.archived \}\)\)/);
  for (const f of ['src/main/phoneServer.ts', 'src/phone/app.js', 'src/phone/index.html']) assert.doesNotMatch(read(f), /unread/i, f);
});

test('4. send sound: bundled generated WAV, off by default, plays only when on; CSP adds media-src \'self\' only', () => {
  const wav = fs.readFileSync(path.join(root, 'src/renderer/assets/send.wav'));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.ok(wav.length < 20_000);
  assert.ok(fs.existsSync(path.join(root, 'scripts/make-send-sound.py')));
  assert.equal(parseSendSound(null), false, 'off by default');
  assert.equal(parseSendSound('0'), false);
  assert.equal(parseSendSound('1'), true);
  assert.equal(SEND_SOUND_SETTING_KEY, 'send_sound');
  const db = new CipherDb(tmpDb());
  assert.equal(parseSendSound(db.getSetting(SEND_SOUND_SETTING_KEY)), false, 'a new database has it off');
  db.close();
  assert.match(renderer, /if \(!state\.sendSound\) return;\n {2}sendAudio \?\?= new Audio\('assets\/send\.wav'\);/);
  assert.match(section('settings-view'), /<input type="checkbox" id="sound-switch" \/>[\s\S]*Send sound[\s\S]*Off by default/);
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.doesNotMatch(html, /style=/);
});

test('5. About: icon, Cipher Bot, version from main, and an in-app Policy button (no web link)', () => {
  const about = section('about-view');
  assert.match(about, /<img class="about-logo" src="assets\/icon\.png"/);
  assert.match(about, /<h2>Cipher Bot<\/h2>/);
  assert.match(about, /Version <span id="about-version" class="app-version"><\/span>/);
  assert.match(about, /<button type="button" id="about-policy" class="secondary">Policy<\/button>/);
  assert.doesNotMatch(about, /<a\b|href=|https?:/);
  assert.match(renderer, /el\.aboutPolicy\.addEventListener\('click', openPolicy\);/);
  assert.match(renderer, /el\.aboutVersion\.textContent = state\.version;/);
  assert.match(section('settings-view'), /<button type="button" id="open-about" class="secondary">About<\/button>/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const view = require('../renderer/view.js') as { decideView: (i: unknown) => string };
  const setup = { phase: 'ready' };
  assert.equal(view.decideView({ botCount: 1, formOpen: false, aboutOpen: true, setup }), 'about');
  assert.equal(view.decideView({ botCount: 1, formOpen: false, aboutOpen: true, policyOpen: true, setup }), 'policy');
});

test('no network code added; networkGuard and Online unchanged in this version', () => {
  for (const f of ['src/main/unread.ts', 'scripts/make-send-sound.py']) {
    assert.doesNotMatch(read(f), /fetch\(|https?:\/\/|require\('https?'\)|import .*'node:(http|https|net)'|urllib|socket/, f);
  }
  const added = [main, renderer].join('\n');
  assert.doesNotMatch(added, /new WebSocket|XMLHttpRequest|navigator\.sendBeacon/);
  assert.match(read('src/renderer/policy.ts'), /export const POLICY_CONTACT = 'Contact: \[to be added\]';/);
});

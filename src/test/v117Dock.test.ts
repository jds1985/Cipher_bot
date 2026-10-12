import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachFromPath } from '../main/attachFile';
import { lockGuard, LOCKED_MESSAGE, UNLOCKED_CHANNELS } from '../main/lock';
import { MAX_FILE_BYTES } from '../main/readFileTool';
import { clampToDisplays, debounce, loadWindowState, parseWindowState, saveWindowState, WINDOW_STATE_FILE, MIN_SIZE } from '../main/windowBounds';
import { CipherDb } from '../main/db';
import { readUiPrefs, UI_PREFS } from '../main/uiPrefs';

// v1.17: drag to attach, message times, dock collapse, window memory, About what's new.
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const main = read('src/main/main.ts');
const renderer = read('src/renderer/renderer.ts');
const preload = read('src/preload/preload.ts');
const html = read('src/renderer/index.html');
const css = read('src/renderer/styles.css');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v117-')));
const folder = path.join(base, 'notes');
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'a.txt'), 'hello');
fs.writeFileSync(path.join(folder, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
fs.writeFileSync(path.join(folder, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP SECRET');
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(folder, 'link-out'));

test('1. drop: plus > Attach and drag-and-drop both call the one attach path, attachFromPath', () => {
  assert.equal((main.match(/attachFromPath\(/g) ?? []).length, 3, 'pick (no folder), pick (chosen file), drop');
  assert.match(main, /handle\('attach:dropped', \(_e, botIdRaw: unknown, filePath: unknown\) => \{[\s\S]*?return attachFromPath\(bot, filePath\);/);
  assert.doesNotMatch(main, /readFileForAttach\(/, 'no second read path in main');
  // The path comes from webUtils.getPathForFile in preload (sandbox-safe), not from the renderer's File object.
  assert.match(preload, /pathForFile: \(file\) => \{ try \{ return webUtils\.getPathForFile\(file\); \} catch \{ return ''; \} \},/);
  assert.match(renderer, /const filePath = api\.pathForFile\(files\[0\]\);[\s\S]*?api\.attachDroppedFile\(bot\.id, filePath\)/);
});

test('1. drop: the same folder rules as Attach (inside the bot\'s folder, no escape, size and text limits)', async () => {
  const bot = { folderPath: folder };
  const ok = await attachFromPath(bot, path.join(folder, 'a.txt'));
  assert.equal(ok.ok, true);
  for (const p of [path.join(base, 'secret.txt'), path.join(folder, 'link-out'), path.join(folder, '..', 'secret.txt'), path.join(folder, 'big.txt'), path.join(folder, 'bin.dat')]) {
    const r = await attachFromPath(bot, p);
    assert.equal(r.ok, false, p);
    assert.doesNotMatch(JSON.stringify(r), /TOP SECRET/);
  }
  const noFolder = await attachFromPath({ folderPath: null }, path.join(folder, 'a.txt'));
  assert.deepEqual(noFolder, { ok: false, error: 'Choose a folder for this Cipher bot before attaching a file.', needFolder: true });
  assert.deepEqual(await attachFromPath(null, path.join(folder, 'a.txt')), { ok: false, error: 'Cipher bot not found.' });
});

test('1. drop: refused while the app is locked (attach:dropped goes through lockGuard)', async () => {
  assert.equal(UNLOCKED_CHANNELS.has('attach:dropped'), false);
  assert.equal(UNLOCKED_CHANNELS.has('dialog:pickAttachFile'), false);
  let locked = true;
  let called = 0;
  const handler = lockGuard('attach:dropped', () => locked, (_e: unknown, _id: unknown, p: unknown) => { called++; return attachFromPath({ folderPath: folder }, p as string); });
  assert.throws(() => handler(null, 1, path.join(folder, 'a.txt')), new RegExp(LOCKED_MESSAGE.replace('.', '\\.')));
  assert.equal(called, 0, 'the file is not read while locked');
  locked = false;
  assert.equal((await handler(null, 1, path.join(folder, 'a.txt'))).ok, true);
  // main registers it with handle(), which always wraps in lockGuard.
  assert.match(main, /ipcMain\.handle\(channel, lockGuard\(channel, isLocked, fn\)\);/);
  assert.match(main, /handle\('attach:dropped',/);
  assert.doesNotMatch(main, /ipcMain\.handle\('attach:dropped'/);
});

test('1. drop: rooms are refused with a note; files never load in the window (document dragover/drop, will-navigate)', () => {
  assert.match(renderer, /if \(state\.roomId !== null\) \{ showAttachError\('Files can be attached in a Cipher bot\\'s chat, not in rooms\.'\); return; \}/);
  assert.match(renderer, /document\.addEventListener\('dragover', \(e\) => \{\n {2}e\.preventDefault\(\);/);
  assert.match(renderer, /document\.addEventListener\('drop', \(e\) => \{\n {2}e\.preventDefault\(\);/);
  assert.match(main, /win\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\);/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(css, /#chat-view\.drop-over \{[^}]*(#5b8cff|var\(--accent\))/);
  assert.doesNotMatch(html, /style=/);
});

test('2. message times: h:mm from the stored timestamp; toggle on by default, stored locally', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const view = require('../renderer/view.js') as { formatMessageTime: (iso: string, f?: (d: Date) => { h: number; m: number }) => string };
  const utc = (d: Date) => ({ h: d.getUTCHours(), m: d.getUTCMinutes() });
  assert.equal(view.formatMessageTime('2026-10-12T09:05:00.000Z', utc), '9:05 AM');
  assert.equal(view.formatMessageTime('2026-10-12T00:30:00.000Z', utc), '12:30 AM');
  assert.equal(view.formatMessageTime('2026-10-12T12:00:00.000Z', utc), '12:00 PM');
  assert.equal(view.formatMessageTime('2026-10-12T23:59:59.999Z', utc), '11:59 PM');
  assert.equal(view.formatMessageTime('not a date'), '');
  assert.equal(UI_PREFS.showTimes.default, true);
  const db = new CipherDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v117db-')), 'cipher.db'));
  assert.equal(readUiPrefs((k) => db.getSetting(k)).showTimes, true, 'a new database shows times');
  db.setSetting(UI_PREFS.showTimes.key, '0');
  assert.equal(readUiPrefs((k) => db.getSetting(k)).showTimes, false);
  db.close();
  assert.match(html, /<input type="checkbox" id="times-switch" \/>[\s\S]*Show message times[\s\S]*On by default/);
  assert.match(renderer, /const t = state\.prefs\.showTimes && createdAt \? formatMessageTime\(createdAt\) : '';/);
});

test('3. dock: collapse/expand control with aria-label; state persists locally; collapsed keeps icons and unread dots', () => {
  assert.match(html, /<button type="button" id="dock-toggle" class="dock-toggle" aria-expanded="true" aria-controls="sidebar" aria-label="Collapse the bot dock"/);
  assert.match(renderer, /el\.dockToggle\.setAttribute\('aria-label', label\);/);
  assert.match(renderer, /setUiPref\('dockCollapsed', !state\.prefs\.dockCollapsed\)/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v117db-')), 'cipher.db');
  let db = new CipherDb(file);
  assert.equal(readUiPrefs((k) => db.getSetting(k)).dockCollapsed, false, 'expanded by default');
  db.setSetting(UI_PREFS.dockCollapsed.key, '1');
  db.close();
  db = new CipherDb(file);
  assert.equal(readUiPrefs((k) => db.getSetting(k)).dockCollapsed, true, 'persists');
  db.close();
  assert.match(css, /body\.dock-collapsed \.rail-name \{ display: none; \}/);
  assert.doesNotMatch(css, /body\.dock-collapsed [^{]*unread-dot[^{]*\{[^}]*display: none/);
  // Only known preferences can be set.
  assert.match(main, /if \(!isUiPrefName\(name\)\) throw new Error\('Unknown setting\.'\);/);
});

test('4. window bounds: parsed safely, clamped onto a visible display, off-screen falls back, saved locally', () => {
  const screenA = { x: 0, y: 0, width: 1920, height: 1080 };
  const screenB = { x: 1920, y: 0, width: 1280, height: 1024 };
  assert.equal(parseWindowState(null), null);
  assert.equal(parseWindowState({ x: 1, y: 2, width: 'big', height: 3 }), null);
  const s = { x: 100, y: 80, width: 1200, height: 800, maximized: false };
  assert.deepEqual(clampToDisplays(s, [screenA]), s, 'already visible: unchanged');
  assert.equal(clampToDisplays({ ...s, x: 5000, y: 5000 }, [screenA]), null, 'off every display: default');
  assert.deepEqual(clampToDisplays({ ...s, x: 1800, y: 900 }, [screenA]), { x: 720, y: 280, width: 1200, height: 800, maximized: false }, 'pulled fully inside');
  assert.deepEqual(clampToDisplays({ ...s, x: 2500, y: 100, width: 3000, height: 2000, maximized: true }, [screenA, screenB]), { x: 1920, y: 0, width: 1280, height: 1024, maximized: true }, 'shrunk to its display');
  assert.equal(clampToDisplays({ ...s, width: 100, height: 100 }, [screenA])!.width, MIN_SIZE.width);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-v117win-'));
  assert.equal(loadWindowState(dir, [screenA]), null, 'no file: default');
  saveWindowState(dir, s);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_STATE_FILE), 'utf8')), s);
  assert.deepEqual(loadWindowState(dir, [screenA]), s, 'restored');
  fs.writeFileSync(path.join(dir, WINDOW_STATE_FILE), '{not json');
  assert.equal(loadWindowState(dir, [screenA]), null, 'corrupt file: default');
  assert.match(main, /loadWindowState\(app\.getPath\('userData'\), screen\.getAllDisplays\(\)\.map\(\(d\) => d\.workArea\)\)/);
  assert.match(main, /saveWindowState\(app\.getPath\('userData'\), \{ \.\.\.win\.getNormalBounds\(\), maximized: win\.isMaximized\(\) \}\)/);
});

test('4. window bounds: saving is debounced', async () => {
  let n = 0;
  const d = debounce(() => { n++; }, 20);
  d.call(); d.call(); d.call();
  assert.equal(n, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1);
  d.call(); d.flush();
  assert.equal(n, 2);
});

test('5. About: "New in this version" from one constant, five lines or fewer; version 1.21.0', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WHATS_NEW } = require('../renderer/whatsNew.js') as { WHATS_NEW: readonly string[] };
  assert.ok(WHATS_NEW.length >= 1 && WHATS_NEW.length <= 5, `${WHATS_NEW.length} lines`);
  for (const line of WHATS_NEW) { assert.ok(line.length > 0 && line.length <= 90, line); assert.doesNotMatch(line, /\n/); }
  assert.match(html, /<h3 class="whats-new-title">New in this version<\/h3>\s*<ul id="whats-new" class="whats-new"><\/ul>/);
  assert.match(renderer, /el\.whatsNew\.replaceChildren\(\.\.\.WHATS_NEW\.slice\(0, 5\)/);
  const pkg = JSON.parse(read('package.json')) as { name: string; productName: string; version: string };
  assert.equal(pkg.version, '1.24.0');
  assert.equal(pkg.name, 'cipher');
  assert.equal(pkg.productName, 'Cipher', 'userData stays ~/.config/Cipher');
});

test('no network code added in v1.17', () => {
  for (const f of ['src/main/windowBounds.ts', 'src/main/uiPrefs.ts', 'src/renderer/whatsNew.ts', 'src/main/attachFile.ts']) {
    assert.doesNotMatch(read(f), /fetch\(|https?:\/\/|require\('https?'\)|from 'node:(http|https|net)'|WebSocket/, f);
  }
  assert.doesNotMatch(renderer, /fetch\(|XMLHttpRequest|new WebSocket|sendBeacon/);
});

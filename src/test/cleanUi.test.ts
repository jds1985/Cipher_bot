import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface PlusItem { id: string; label: string; disabled: boolean; checked?: boolean; hint?: string }
interface ViewModule {
  plusMenuItems(i: { kind: 'room' } | { kind: 'bot'; toolsEnabled: boolean; folderPath: string | null; busy: boolean; routineTime: string | null }): PlusItem[];
  showsSplash(hash: string): boolean;
  splashRemainingMs(elapsedMs: number): number;
  SPLASH_MIN_MS: number;
  SPLASH_MAX_MS: number;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const view = require('../renderer/view.js') as ViewModule;
const rendererDir = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');

test('plus menu in a room: only Export', () => {
  assert.deepEqual(view.plusMenuItems({ kind: 'room' }).map((i) => [i.id, i.disabled]), [['export', false]]);
});

test('plus menu in a 1:1 chat: attach, export, clear, edit, folder, read files (on/off), routine', () => {
  const off = view.plusMenuItems({ kind: 'bot', toolsEnabled: false, folderPath: null, busy: false, routineTime: null });
  assert.deepEqual(off.map((i) => i.id), ['attach', 'export', 'clear', 'edit', 'folder', 'tools', 'routine']);
  const tools = (items: PlusItem[]) => items.find((i) => i.id === 'tools')!;
  assert.equal(tools(off).checked, false, 'Read files shows off');
  assert.equal(off.find((i) => i.id === 'folder')!.disabled, true, 'Choose folder needs Read files on (as before)');
  const on = view.plusMenuItems({ kind: 'bot', toolsEnabled: true, folderPath: '/home/me/notes', busy: true, routineTime: '08:30' });
  assert.equal(tools(on).checked, true, 'Read files shows on');
  assert.equal(on.find((i) => i.id === 'folder')!.disabled, false);
  assert.equal(on.find((i) => i.id === 'folder')!.hint, '/home/me/notes');
  assert.equal(on.find((i) => i.id === 'attach')!.disabled, true, 'Attach waits while the chat is replying (as before)');
  assert.match(on.find((i) => i.id === 'routine')!.label, /08:30/);
});

test('header is name-only: no controls left in the chat header; the plus button sits in the composer next to Send', () => {
  const header = /<header id="chat-header">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(header, /<button|<input|<label|room-note|chat-title/);
  assert.match(header, /id="chat-icon"/);
  assert.match(header, /id="chat-bot-name"/);
  const composer = /<form id="composer"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? '';
  assert.match(composer, /<textarea id="input"[\s\S]*<button type="button" id="plus"[^>]*aria-haspopup="menu" aria-expanded="false" aria-controls="plus-menu"[\s\S]*<button type="submit" id="send"/);
  assert.doesNotMatch(composer, /id="attach"/, 'attach moved into the plus menu');
  assert.match(html, /<div id="plus-menu" class="plus-menu" role="menu"[^>]*hidden><\/div>/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('plus menu: keyboard (arrows, Home/End, Escape returns focus), outside click and choosing an item close it', () => {
  for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End']) assert.match(js, new RegExp(`e\\.key === '${key}'`));
  assert.match(js, /closePlusMenu\(true\)/);
  assert.match(js, /document\.addEventListener\('mousedown'/);
  assert.match(js, /btn\.addEventListener\('click', \(\) => \{ closePlusMenu\(\); void runPlusItem\(item\.id\); \}\)/);
  assert.match(js, /setAttribute\('role', item\.checked === undefined \? 'menuitem' : 'menuitemcheckbox'\)/);
  assert.match(js, /setAttribute\('aria-expanded', 'true'\)/);
  // Each item runs the same handler as before.
  for (const call of ['attachFile()', 'exportOpenChat()', 'requestClearChat()', 'openEditBot()', 'chooseFolder()', 'openRoutine()']) {
    assert.ok(js.includes(`return ${call}`), call);
  }
});

test('splash: every launch for about a second, nothing persisted; only a real process start shows it', () => {
  assert.equal(view.SPLASH_MIN_MS, 1000);
  assert.ok(view.SPLASH_MAX_MS >= view.SPLASH_MIN_MS && view.SPLASH_MAX_MS <= 1500);
  assert.equal(view.splashRemainingMs(0), 1000);
  assert.equal(view.splashRemainingMs(400), 600);
  assert.equal(view.splashRemainingMs(5000), 0, 'never waits once loading took longer');
  assert.equal(view.showsSplash(''), true);
  assert.equal(view.showsSplash('#nosplash'), false);
  // No "seen splash" flag anywhere: no storage and no setting in the renderer, nothing about the splash in main's DB.
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.doesNotMatch(main, /setSetting\([^)]*splash/i);
  // Only the first window of the process shows it; restoring from the tray / second launch only shows the window.
  assert.match(main, /const splash = windowsCreated\+\+ === 0;/);
  assert.match(main, /splash \? \{\} : \{ hash: 'nosplash' \}/);
  assert.match(main, /function showWindow\(\): void \{[\s\S]*?win\.show\(\);[\s\S]*?\}/);
  assert.match(main, /app\.on\('second-instance', \(\) => \{\s*if \(app\.isReady\(\)\) showWindow\(\);/);
  assert.match(main, /app\.on\('activate', \(\) => showWindow\(\)\)/);
  // The splash doesn't hold back setup/model check (they start in main right away) and makes no requests.
  assert.match(main, /createTray\(\);\s*void setup\.run\(true\);/);
  assert.match(html, /<div id="splash" aria-hidden="true"><img src="assets\/splash\.png" alt="Cipher" \/><\/div>/);
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /#nosplash:target ~ #splash \{ display: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*#splash \{ transition: none;/);
});

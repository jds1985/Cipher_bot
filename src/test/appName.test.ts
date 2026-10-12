import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { routineNoticeContent } from '../main/routineNotice';
import { LOCKED_MESSAGE } from '../main/lock';
import { PHONE_LOCKED_MESSAGE } from '../main/phoneServer';

// v1.14: the name a person sees is "Cipher Bot". Data paths and install names stay "Cipher" / "cipher".
const root = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const sha = (rel: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');

interface PolicyModule { POLICY_SECTIONS: readonly { heading: string; paragraphs: readonly string[] }[] }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const policy = require('../renderer/policy.js') as PolicyModule;

/**
 * "Cipher" on its own as the app's name. Allowed: "Cipher Bot" (the app), "Cipher bot(s)" (your bots), and
 * folder paths such as ~/.config/Cipher, %APPDATA%\Cipher, Application Support/Cipher (the real folder name).
 */
const BARE_APP_NAME = /(?<![\w/\\.])Cipher\b(?! Bot\b)(?! bots?\b)/g;
const codeOnly = (text: string) =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).map((l) => l.replace(/\s\/\/\s.*$/, '')).join('\n');
const bare = (text: string) => codeOnly(text).match(BARE_APP_NAME) ?? [];

test('the app name a person sees is "Cipher Bot": window title, HTML titles, title strip, splash, lock screen, tray, notification, phone', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /title: 'Cipher Bot',\n/, 'BrowserWindow title');
  assert.match(main, /tray\.setToolTip\('Cipher Bot'\);/);
  assert.match(main, /label: 'Show Cipher Bot'/);
  assert.match(main, /label: 'Quit Cipher Bot'/);
  assert.match(main, /title: 'Back up Cipher Bot'/);
  assert.match(main, /title: 'Restore Cipher Bot from a backup'/);
  const html = read('src/renderer/index.html');
  assert.match(html, /<title>Cipher Bot<\/title>/);
  assert.match(html, /<span class="titlebar-title">Cipher Bot<\/span>/);
  assert.match(html, /<img src="assets\/splash\.png" alt="Cipher Bot" \/>/);
  assert.match(html, /<h2 id="lock-title">Cipher Bot is locked<\/h2>/);
  assert.deepEqual(routineNoticeContent('finished', 'Ada'), { title: 'Cipher Bot', body: 'Routine finished: Ada' });
  assert.equal(LOCKED_MESSAGE, 'Cipher Bot is locked.');
  assert.equal(PHONE_LOCKED_MESSAGE, 'Cipher Bot is locked on the desktop.');
  const phone = read('src/phone/index.html');
  assert.match(phone, /<title>Cipher Bot<\/title>/);
  assert.match(phone, /<strong>Cipher Bot<\/strong>/);
  assert.match(phone, /<h1>Cipher Bot is locked on the desktop<\/h1>/);
  // The splash word is in the image: it is the regenerated v1.14 splash (same generator, word "Cipher Bot").
  assert.equal(sha('src/renderer/assets/splash.png'), sha('art/v1.14/cipher-splash-v1.14.png'));
  assert.match(read('art/v1.14/splash-v1.14.py'), /WORD="Cipher Bot"/);
});

test('no user-visible string calls the app plain "Cipher" (bots stay "Cipher bot"; folder paths stay literal)', () => {
  const files = [
    'src/renderer/index.html', 'src/renderer/renderer.ts', 'src/renderer/view.ts', 'src/renderer/policy.ts',
    'src/phone/index.html', 'src/phone/app.js',
    'src/main/main.ts', 'src/main/routineNotice.ts', 'src/main/lock.ts', 'src/main/phoneServer.ts', 'src/main/backup.ts',
    'src/main/ollama.ts', 'src/main/exportChat.ts', 'src/main/chatEngine.ts', 'src/main/db.ts', 'src/main/createBot.ts',
    'src/main/deleteGuard.ts', 'src/main/attachFile.ts',
  ];
  for (const f of files) assert.deepEqual(bare(read(f)), [], f);
  const text = policy.POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
  assert.deepEqual(text.match(BARE_APP_NAME) ?? [], [], 'policy');
  // The policy's folder paths are still the real ones.
  assert.match(text, /~\/\.config\/Cipher on Linux, %APPDATA%\\Cipher on Windows, ~\/Library\/Application Support\/Cipher on macOS/);
  assert.match(text, /cipher\.db/);
  assert.match(text, /lock\.json/);
  assert.match(text, /"Cipher Bot is locked on the desktop"/);
  // The sanity check itself: plain "Cipher" is caught, the allowed forms aren't.
  assert.deepEqual(bare("x = 'Cipher is locked';"), ['Cipher']);
  assert.deepEqual(bare("x = 'Cipher Bot and your Cipher bots in ~/.config/Cipher';"), []);
});

test('install and data names are unchanged: package name, productName, appId, version, userData folder (~/.config/Cipher)', () => {
  const pkg = JSON.parse(read('package.json')) as {
    name: string; productName: string; version: string;
    build: { appId: string; productName: string; linux: { executableName?: string; desktop: { entry: { Name: string } } } };
  };
  assert.equal(pkg.name, 'cipher', '.deb is cipher_<version>_amd64.deb');
  assert.equal(pkg.version, '1.22.0');
  assert.equal(pkg.productName, 'Cipher', 'Electron derives userData (~/.config/Cipher) and the install dir from this');
  assert.equal(pkg.build.productName, 'Cipher');
  assert.equal(pkg.build.appId, 'com.jds1985.cipher');
  assert.equal(pkg.build.linux.executableName, undefined);
  assert.equal(pkg.build.linux.desktop.entry.Name, 'Cipher Bot', 'only the menu entry\'s display name changes');
  // Nothing in main renames the app or moves its data folder.
  const main = read('src/main/main.ts');
  assert.doesNotMatch(main, /app\.setName\(|app\.name\s*=|setPath\(\s*'userData'|setAppUserModelId/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'cipher\.db'\)/);
  assert.match(main, /new LockStore\(app\.getPath\('userData'\)\)/);
});

test('lock screen look: the same app icon, large and centered; passphrase panel on top of it; small readable note at the bottom', () => {
  const html = read('src/renderer/index.html');
  const lock = /<div id="lock-screen"[\s\S]*?\n {4}<\/div>\n/.exec(html)![0];
  // The same icon: a copy of build/icon.png (1024 px), which assets/icon.png (512 px) was made from.
  assert.match(lock, /<img class="lock-logo" src="assets\/icon-1024\.png" alt="" width="1024" height="1024" \/>/);
  assert.equal(sha('src/renderer/assets/icon-1024.png'), sha('build/icon.png'));
  // The form sits in the same grid cell as the logo (centered on it); the input stays masked.
  assert.match(lock, /<div class="lock-stage">\s*<img class="lock-logo"[^>]*>\s*<form id="lock-form" class="lock-panel">/);
  assert.match(lock, /<input id="lock-pass" type="password" autocomplete="current-password" maxlength="1024" \/>/);
  assert.match(lock, /<p id="lock-pass-error" class="error" hidden><\/p>\s*<button type="submit" id="lock-unlock">Unlock<\/button>/);
  assert.match(lock, /<p class="lock-note">There is no recovery: Cipher Bot can't reset a forgotten passphrase\. If you forget it, quit Cipher Bot and delete the file lock\.json in Cipher Bot's user data folder\. That removes the lock and keeps your chats\. The lock does not encrypt anything\.<\/p>/);
  assert.doesNotMatch(lock, /style=/);
  const css = read('src/renderer/styles.css');
  assert.match(css, /\.lock-logo \{ grid-area: 1 \/ 1; width: min\(80vw, 80vh\); height: min\(80vw, 80vh\); max-width: 100%; max-height: 100%;\s*object-fit: contain;/);
  assert.match(css, /\.lock-panel \{ grid-area: 1 \/ 1;[^}]*background: #15171cdb;[^}]*border: 1px solid (#5b8cff73|rgba\(var\(--accent-rgb\), \.45\));/);
  // The overlay is opaque and above the app (no chat, bot names or sidebar show behind it).
  assert.match(css, /\.lock-screen \{\s*position: fixed; inset: var\(--titlebar-h\) 0 0 0; z-index: 90;[^}]*background: var\(--bg\);/);
  // The note: 12 px, muted text on the window background, contrast well above 4.5:1.
  const note = /\.lock-note \{[^}]*\}/.exec(css)![0];
  assert.match(note, /font-size: 12px;/);
  assert.match(note, /color: var\(--muted\);/);
  const hex = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)![1];
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (lum(hex('muted')) + 0.05) / (lum(hex('bg')) + 0.05);
  assert.ok(ratio >= 4.5, `note contrast ${ratio.toFixed(2)}:1`);
  // No new animation on the lock screen.
  assert.doesNotMatch(/v1\.14: the app icon[\s\S]*?\.lock-status/.exec(css)![0], /\b(animation|transition)\s*:/);
});

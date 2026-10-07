import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface PolicyModule {
  POLICY_CONTACT: string;
  POLICY_TITLE: string;
  POLICY_SECTIONS: readonly { heading: string; paragraphs: readonly string[] }[];
}
// The renderer's policy module is an ES module; Electron's Node can require() it directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const policy = require('../renderer/policy.js') as PolicyModule;
const all = policy.POLICY_SECTIONS.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const section = (h: RegExp) => {
  const s = policy.POLICY_SECTIONS.find((x) => h.test(x.heading));
  assert.ok(s, `section ${h}`);
  return s!.paragraphs.join('\n');
};

test('policy has the contact placeholder for the user to fill in', () => {
  assert.equal(policy.POLICY_CONTACT, 'Contact: [to be added]');
});

test('"stays on this computer" names both exceptions right there: plain-HTTP phone link and the model download', () => {
  const first = policy.POLICY_SECTIONS[0];
  assert.match(first.heading, /stay on this computer, with two exceptions/);
  const p = first.paragraphs[0];
  assert.match(p, /stay|keeps/);
  assert.match(p, /Phone link/);
  assert.match(p, /plain HTTP/);
  assert.match(p, /not encrypted/);
  assert.match(p, /Ollama downloads the model from its online registry/);
  // Every sentence that says "stays on this computer" must sit in a paragraph that names both exceptions.
  for (const s of policy.POLICY_SECTIONS) for (const para of s.paragraphs) {
    if (/stays? on this computer/i.test(para)) assert.ok(/plain HTTP/.test(para) && /registry/.test(para), para);
  }
});

test('required points: local database and where, files only from the chosen folder, local model, Ollama is separate', () => {
  assert.match(all, /cipher\.db/);
  assert.match(all, /user data folder/);
  assert.match(all, /not encrypted: anyone who can open your user account/);
  assert.match(section(/^Files$/), /only from the one folder you choose/);
  assert.match(section(/^Files$/), /Read files on/);
  assert.match(section(/model/i), /Ollama on this computer/);
  assert.match(section(/model/i), /can't control what Ollama does/);
});

test('phone link: a window to this desktop, off until turned on, pairing code, plain HTTP not encrypted', () => {
  const p = section(/^Phone link$/);
  assert.match(p, /window to this desktop/);
  assert.match(p, /off each time Cipher starts, until you turn it on/);
  assert.match(p, /code works once and expires/);
  assert.match(p, /plain HTTP/);
  assert.match(p, /not encrypted/);
});

test('Online: off unless turned on, enables nothing yet, and does not claim the app never touches the network', () => {
  const p = section(/^Online/);
  assert.match(p, /off unless you turn it on/);
  assert.match(p, /does not enable any feature/);
  assert.match(p, /does not mean Cipher never touches the network/);
  assert.match(p, /model download and the "Get the engine" button/);
  assert.match(p, /regardless of the switch/);
  // Apart from the sentence that denies it, nothing claims Cipher never uses the network.
  assert.doesNotMatch(all.replace('does not mean Cipher never touches the network', ''), /no network ever|never (connects to|touches|uses) the (internet|network)/i);
});

test('routines: only on this computer, only while Cipher is open or in the tray, no internet, file reading off', () => {
  const p = section(/^Routines$/);
  assert.match(p, /only on this computer/);
  assert.match(p, /only while Cipher is open or in the tray/);
  assert.match(p, /skipped/);
  assert.match(p, /don't use the internet/);
  assert.match(p, /file reading off/);
});

test('routines: explicitly not after you quit Cipher', () => {
  assert.match(section(/^Routines$/), /only while Cipher is open or in the tray, not after you quit Cipher/);
});

test('routine notice: bot name and finished/failed only, no message or reply, OS notification system, may stay in history', () => {
  const p = section(/^Routines$/);
  assert.match(p, /When a routine finishes or fails, Cipher shows a desktop notification/);
  assert.match(p, /with the bot's name and "finished" or "failed" only; the routine's message and the reply are not in it/);
  assert.match(p, /your computer's own notification system, not the internet/);
  assert.match(p, /may stay in that system's notification history/);
  assert.match(p, /no notification if that bot's chat is already open in front of you, or if you stop the routine/);
});

test('lock: passphrase never leaves the computer; salted scrypt hash in lock.json (not cipher.db); no account', () => {
  const p = section(/^Lock$/);
  assert.match(p, /off unless you turn it on in Settings → Lock/);
  assert.match(p, /each time it starts and each time its window is shown again after being hidden/);
  assert.match(p, /Your passphrase never leaves this computer and is never saved/);
  assert.match(p, /only a salted scrypt hash of it, in a small file, lock\.json, in Cipher's user data folder, separate from cipher\.db/);
  assert.match(p, /There is no account/);
  assert.match(p, /After 5 wrong tries in a row, Cipher makes you wait/);
  // True to the code: the lock file name and the throttle.
  const lock = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'lock.ts'), 'utf8');
  assert.match(lock, /export const LOCK_FILE_NAME = 'lock\.json';/);
  assert.match(lock, /export const FREE_ATTEMPTS = 5;/);
  assert.match(lock, /scryptCb\(/);
});

test('lock: not encryption; cipher.db and backups readable; phone link refuses all while locked; routines go on; forgotten passphrase', () => {
  const p = section(/^Lock$/);
  assert.match(p, /The lock does not encrypt anything/);
  assert.match(p, /cipher\.db and any backup files stay readable by anyone with access to your user account's files/);
  assert.match(p, /Phone link refuses every request, pairing included; only its page loads/);
  assert.match(p, /"Cipher is locked on the desktop"/);
  assert.match(p, /Routines keep running while locked, and their notification \(bot name only\) still shows/);
  assert.match(p, /There is no recovery/);
  assert.match(p, /quit Cipher and delete lock\.json from Cipher's user data folder\. That removes the lock and keeps your chats/);
  // Nothing claims the lock encrypts or protects the database file.
  assert.doesNotMatch(all, /lock (encrypts|protects your (chats|files|database))|encrypted (database|chats)/i);
});

test('backup and restore: local files you choose, not encrypted, contain everything, no lock, pre-restore copy, Online off', () => {
  const p = section(/^Backup and restore$/);
  assert.match(p, /a file you choose on this computer/);
  assert.match(p, /Nothing is uploaded/);
  assert.match(p, /A backup is not encrypted and contains all your Cipher bots, chats, rooms, routines and settings/);
  assert.match(p, /It does not include the lock: restoring never changes whether Cipher is locked or what the passphrase is/);
  assert.match(p, /cipher\.db\.before-restore-<date>-<time>/);
  assert.match(p, /Restore turns Online off/);
  assert.match(section(/stay on this computer/), /settings \(except the app lock; see Lock\) are saved in one database file, cipher\.db/);
});

test('no account, telemetry, analytics or crash reporting, and the code really has none', () => {
  assert.match(section(/Accounts/), /no account or sign-in/);
  assert.match(section(/Accounts/), /no telemetry, analytics, crash reporting or auto-updater/);
  const root = path.join(__dirname, '..', '..');
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /electron-updater|sentry|analytics|telemetry/i);
  for (const dir of ['main', 'preload', 'renderer']) {
    for (const f of fs.readdirSync(path.join(root, 'src', dir)).filter((x) => x.endsWith('.ts') && x !== 'policy.ts')) {
      const src = fs.readFileSync(path.join(root, 'src', dir, f), 'utf8');
      assert.doesNotMatch(src, /crashReporter|autoUpdater|telemetry|analytics/, `${dir}/${f}`);
    }
  }
});

test('the routine panel hint says the same: only while open or in the tray, skipped otherwise, file reading off', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const hint = /<p class="muted routine-hint">([^<]+)<\/p>/.exec(html)?.[1] ?? '';
  assert.match(hint, /only while Cipher is open or in the tray/);
  assert.match(hint, /skipped \(no catch-up\)/);
  assert.match(hint, /File reading is off for routines/);
  assert.match(hint, /only on this computer/);
});

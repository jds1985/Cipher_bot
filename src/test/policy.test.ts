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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface PlusItem { id: string; label: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const view = require('../renderer/view.js') as {
  plusMenuItems(i: { kind: 'room' } | { kind: 'bot'; toolsEnabled: boolean; folderPath: string | null; busy: boolean; routineTime: string | null }): PlusItem[];
};
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

test('Settings page has Lock, Backup, Restore and Policy sections, and keeps Online and Phone link', () => {
  const settings = /<section id="settings-view"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const order = ['<h3>Lock</h3>', '<h3>Backup</h3>', '<h3>Restore</h3>', 'id="online-switch"', '<h3>Phone link</h3>', '<h3>Policy</h3>'];
  let at = -1;
  for (const marker of order) {
    const i = settings.indexOf(marker);
    assert.ok(i > at, `${marker} present, in order`);
    at = i;
  }
  assert.match(settings, /id="open-policy"/);
  assert.match(settings, /The backup is not encrypted: anyone who can open the file can read your chats\. It does not include the lock\./);
  assert.match(settings, /Cipher first keeps a copy of the current database next to it, then restarts\. The lock on this computer stays as it is, and Online is turned off\./);
  assert.match(settings, /The lock does not encrypt your chats, and there is no recovery if you forget the passphrase\./);
  // Passphrase fields are password inputs, at least 8 characters for new ones.
  for (const id of ['lock-set-new', 'lock-set-confirm', 'lock-change-new', 'lock-change-confirm']) {
    assert.match(settings, new RegExp(`<input id="${id}" type="password" autocomplete="new-password" minlength="8"`));
  }
  for (const id of ['lock-change-current', 'lock-off-current']) assert.match(settings, new RegExp(`<input id="${id}" type="password" autocomplete="current-password"`));
});

test('the plus menu keeps chat actions only: no lock, backup, restore, policy or settings items', () => {
  const items = [
    ...view.plusMenuItems({ kind: 'room' }),
    ...view.plusMenuItems({ kind: 'bot', toolsEnabled: true, folderPath: '/x', busy: false, routineTime: '08:00' }),
  ];
  for (const i of items) assert.doesNotMatch(`${i.id} ${i.label}`, /lock|backup|back up|restore|policy|settings|online|phone/i);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// main.ts needs a running Electron app, so these are source checks of the close-to-tray code paths.
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
const block = (start: string, end: string): string => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `missing: ${start}`);
  const j = src.indexOf(end, i + start.length);
  assert.ok(j > i, `missing end for: ${start}`);
  return src.slice(i, j);
};

test('tray menu has "Show Cipher" and a real Quit; close hides only while not quitting and the tray exists', () => {
  const tray = block('function createTray', '/** Folders the user picked');
  assert.match(tray, /label: 'Show Cipher'/);
  assert.match(tray, /label: 'Quit', click: \(\) => \{ quitting = true; app\.quit\(\); \}/);
  assert.match(tray, /catch \{\s*tray = null;/, 'no tray → normal close-to-quit');
  assert.match(src, /if \(!quitting && tray && !tray\.isDestroyed\(\)\) \{\s*e\.preventDefault\(\);\s*hideToTray\(win\);/);
  assert.match(block('function hideToTray', '\n}\n'), /win\.hide\(\);/);
  assert.match(src, /app\.on\('before-quit', \(\) => \{ quitting = true; \}\)/);
  assert.match(src, /requestSingleInstanceLock\(\)/);
});

test('hiding/showing the window never touches the phone link or the Online setting', () => {
  const paths = [
    block('function showWindow', '\n}\n'),
    block('function createTray', '/** Folders the user picked'),
    block("win.on('close'", '\n  });'),
    block('function hideToTray', '\n}\n'),
  ];
  for (const p of paths) assert.doesNotMatch(p, /phone\.|setSetting|ONLINE_SETTING_KEY|online:/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BOT_ICONS, DEFAULT_BOT_ICON, normalizeBotIcon, pickLeastUsedIcon } from '../main/botIcons';
import { CipherDb } from '../main/db';
import type { NewBot } from '../shared/types';

// The renderer's icon module is an ES module; Electron's Node can require() it directly.
interface BotIconModule { BOT_ICON_FILES: Record<string, string>; botIconSrc(icon: unknown): string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rendererIcons = require('../renderer/botIcon.js') as BotIconModule;

const tmpDbFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-icons-')), 'cipher.db');
const newBot = (name: string): NewBot => ({ name, systemPrompt: '', toolsEnabled: false, folderPath: null });

/** A database exactly as v1.3 left it: schema version 2, no icon column. */
function makeV2Db(file: string, bots: { name: string; createdAt: string }[]): void {
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, system_prompt TEXT NOT NULL DEFAULT '',
      tools_enabled INTEGER NOT NULL DEFAULT 0, folder_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')), content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT, tool_name TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ins = raw.prepare('INSERT INTO bots (name, created_at) VALUES (?, ?)');
  for (const b of bots) ins.run(b.name, b.createdAt);
  raw.pragma('user_version = 2');
  raw.close();
}

const columnNames = (file: string): string[] => {
  const raw = new Database(file, { readonly: true });
  const cols = (raw.prepare('PRAGMA table_info(bots)').all() as { name: string }[]).map((c) => c.name);
  raw.close();
  return cols;
};

test('the icon set is Liz\'s nine icons in set order, 01 hex first', () => {
  assert.deepEqual([...BOT_ICONS], ['hex', 'circle', 'square', 'diamond', 'triangle', 'shield', 'octagon', 'capsule', 'pentagon']);
  assert.equal(DEFAULT_BOT_ICON, 'hex');
});

test('pickLeastUsedIcon: least-used icon, ties broken in set order; unknown values count as the fallback', () => {
  assert.equal(pickLeastUsedIcon([]), 'hex');
  assert.equal(pickLeastUsedIcon(['hex']), 'circle');
  assert.equal(pickLeastUsedIcon(['hex', 'circle', 'square']), 'diamond');
  assert.equal(pickLeastUsedIcon(['circle']), 'hex', 'ties go to the earliest icon in the set');
  assert.equal(pickLeastUsedIcon([...BOT_ICONS]), 'hex', 'all used once: start over at hex');
  assert.equal(pickLeastUsedIcon([...BOT_ICONS, 'hex', 'circle']), 'square');
  assert.equal(pickLeastUsedIcon(['bogus', null, '']), 'circle', 'unknown values show as hex, so they count as hex');
  assert.equal(pickLeastUsedIcon(BOT_ICONS.filter((k) => k !== 'octagon')), 'octagon');
});

test('normalizeBotIcon: whitelist only, anything else falls back to the first icon', () => {
  for (const k of BOT_ICONS) assert.equal(normalizeBotIcon(k), k);
  for (const bad of [null, undefined, '', 'HEX', ' hex', 'hex.png', '../../etc/passwd', 'cipher-bot-01-hex', '__proto__', 'constructor', 'toString', 3, {}]) {
    assert.equal(normalizeBotIcon(bad), 'hex', `fallback for ${String(bad)}`);
  }
});

test('creating bots assigns icons automatically: least-used first, ties in set order', () => {
  const db = new CipherDb(tmpDbFile());
  const icons = Array.from({ length: 11 }, (_, i) => db.createBot(newBot(`Bot ${i + 1}`)).icon);
  assert.deepEqual(icons, [...BOT_ICONS, 'hex', 'circle']);
  // Icons are stored and survive listBots / getBot.
  assert.deepEqual(db.listBots().map((b) => b.icon), icons);
  assert.equal(db.getBot(1)?.icon, 'hex');
  db.close();
});

test('least-used assignment accounts for the icons already stored', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  for (let i = 0; i < 3; i++) db.createBot(newBot(`B${i}`)); // hex, circle, square
  db.close();
  const raw = new Database(file);
  raw.prepare("UPDATE bots SET icon = 'diamond' WHERE id IN (1, 2)").run(); // diamond x2, square x1
  raw.close();
  db = new CipherDb(file);
  assert.equal(db.createBot(newBot('Next')).icon, 'hex');
  assert.equal(db.createBot(newBot('Then')).icon, 'circle');
  db.close();
});

test('migration from v1.3 (schema 2): adds the icon column once and backfills icons in creation order', () => {
  const file = tmpDbFile();
  // Creation order differs from id order: Charlie (id 3) is the oldest, then Alpha, then Bravo.
  makeV2Db(file, [
    { name: 'Alpha', createdAt: '2026-01-02T00:00:00.000Z' },
    { name: 'Bravo', createdAt: '2026-01-03T00:00:00.000Z' },
    { name: 'Charlie', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.ok(!columnNames(file).includes('icon'));

  let db = new CipherDb(file);
  const byName = Object.fromEntries(db.listBots().map((b) => [b.name, b.icon]));
  assert.deepEqual(byName, { Charlie: 'hex', Alpha: 'circle', Bravo: 'square' });
  assert.equal(db.createBot(newBot('Delta')).icon, 'diamond', 'new bots continue the least-used sequence');
  db.close();

  // Reopening is a no-op: no duplicate-column error, icons unchanged, schema version 3.
  db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((b) => b.icon), ['circle', 'square', 'hex', 'diamond']);
  db.close();
  assert.equal(columnNames(file).filter((c) => c === 'icon').length, 1);
  const raw = new Database(file, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 3);
  raw.close();
});

test('migration is idempotent when the icon column already exists; only bots without an icon are backfilled', () => {
  const file = tmpDbFile();
  makeV2Db(file, [
    { name: 'Has icon', createdAt: '2026-01-01T00:00:00.000Z' },
    { name: 'Empty', createdAt: '2026-01-02T00:00:00.000Z' },
    { name: 'Null', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
  const raw = new Database(file);
  raw.exec('ALTER TABLE bots ADD COLUMN icon TEXT');
  raw.prepare("UPDATE bots SET icon = 'hex' WHERE id = 1").run();
  raw.prepare("UPDATE bots SET icon = '' WHERE id = 2").run();
  raw.close(); // user_version is still 2

  const db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((b) => [b.name, b.icon]), [['Has icon', 'hex'], ['Empty', 'circle'], ['Null', 'square']]);
  db.close();
});

test('an unknown stored icon is shown as the first icon and is never passed through', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  db.createBot(newBot('Tampered'));
  db.close();
  const raw = new Database(file);
  raw.prepare("UPDATE bots SET icon = '../../../etc/passwd' WHERE id = 1").run();
  raw.close();
  db = new CipherDb(file);
  assert.equal(db.listBots()[0].icon, 'hex');
  assert.equal(db.getBot(1)?.icon, 'hex');
  db.close();
});

test('renderer icon whitelist matches the main list, and every icon ships as a 256x256 RGBA PNG', () => {
  assert.deepEqual(Object.keys(rendererIcons.BOT_ICON_FILES), [...BOT_ICONS]);
  const dir = path.join(__dirname, '..', 'renderer', 'assets', 'bot-icons'); // copied by scripts/copy-static.mjs
  const shipped = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.deepEqual(shipped, Object.values(rendererIcons.BOT_ICON_FILES).sort());
  BOT_ICONS.forEach((k, i) => {
    const file = rendererIcons.BOT_ICON_FILES[k];
    assert.equal(file, `cipher-bot-${String(i + 1).padStart(2, '0')}-${k}.png`);
    const png = fs.readFileSync(path.join(dir, file));
    assert.equal(png.readUInt32BE(16), 256, `${file} width`);
    assert.equal(png.readUInt32BE(20), 256, `${file} height`);
    assert.equal(png[25], 6, `${file} is RGBA (has alpha)`);
  });
});

test('botIconSrc only ever points into assets/bot-icons/, falling back to the first icon', () => {
  assert.equal(rendererIcons.botIconSrc('shield'), 'assets/bot-icons/cipher-bot-06-shield.png');
  for (const bad of [undefined, null, '', '../splash', '__proto__', 'constructor', 'hasOwnProperty', 'cipher-bot-02-circle.png']) {
    assert.equal(rendererIcons.botIconSrc(bad), 'assets/bot-icons/cipher-bot-01-hex.png', `fallback for ${String(bad)}`);
  }
});

test('bot icon animation pauses when unfocused and is off with reduced motion; CSP and no inline styles kept', () => {
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /:root\.unfocused \.bot-icon \{ animation-play-state: paused; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-icon \{ animation: none;/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /style-src 'self'; img-src 'self' data:;/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /<style/);
});

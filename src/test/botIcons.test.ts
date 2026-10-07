import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  BOT_COLORS, BOT_ICONS, BOT_SHAPES, DEFAULT_BOT_COLOR, DEFAULT_BOT_ICON, DEFAULT_BOT_SHAPE,
  normalizeBotColor, normalizeBotIcon, normalizeBotShape, pickLeastUsedIcon,
} from '../main/botIcons';
import { CipherDb } from '../main/db';
import { toNewBot } from '../main/createBot';
import type { NewBot } from '../shared/types';

// The renderer's icon modules are ES modules; Electron's Node can require() them directly.
interface BotIconModule {
  BOT_SHAPES: readonly string[]; BOT_COLORS: readonly string[]; DEFAULT_SHAPE: string; DEFAULT_COLOR: string;
  shapeOf(v: unknown): string; colorOf(v: unknown): string; colorClass(v: unknown): string; shapeSvg(v: unknown): string;
  leastUsedShape(used: Iterable<unknown>): string;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rendererIcons = require('../renderer/botIcon.js') as BotIconModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BOT_SHAPE_SVGS } = require('../renderer/botIconSvgs.js') as { BOT_SHAPE_SVGS: Record<string, string> };

const repoRoot = path.join(__dirname, '..', '..');
const rendererDir = path.join(__dirname, '..', 'renderer'); // dist/renderer (copied by scripts/copy-static.mjs)
const tmpDbFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-icons-')), 'cipher.db');
const newBot = (name: string, extra: Partial<NewBot> = {}): NewBot => ({ name, systemPrompt: '', toolsEnabled: false, folderPath: null, ...extra });
const BAD_VALUES = [null, undefined, '', 'HEX', ' hex', 'hex.png', '../../etc/passwd', 'cipher-bot-01-hex', '__proto__', 'constructor',
  'toString', 'hasOwnProperty', '#5b8cff', 'red', 'c-blue', 3, {}, ['hex']];

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

const columnNames = (file: string, table = 'bots'): string[] => {
  const raw = new Database(file, { readonly: true });
  const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  raw.close();
  return cols;
};

/** Plain static SVG only: known shape elements and presentation attributes; no scripts, styles, links or entities. */
function assertStaticSvg(name: string, svg: string, extraAttrs: string[] = []): void {
  const tags = new Set(['svg', 'g', 'line', 'circle', 'rect', 'polygon', 'polyline', 'path']);
  const attrs = new Set(['xmlns', 'width', 'height', 'viewBox', 'color', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'x', 'y', 'rx', 'points', 'd',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', ...extraAttrs]);
  assert.doesNotMatch(svg, /<!|<\?|&|script|foreignObject|href|url\(|style|on[a-z]+\s*=/i, `${name}: no scripts/styles/external refs`);
  for (const [, tag, list] of svg.matchAll(/<\/?([a-zA-Z]+)([^>]*)>/g)) {
    assert.ok(tags.has(tag), `${name}: <${tag}> not allowed`);
    for (const [, attr] of list.matchAll(/([a-zA-Z-:]+)\s*=/g)) assert.ok(attrs.has(attr), `${name}: attribute ${attr} not allowed`);
  }
}

test('the v1.4 icon set is still Liz\'s nine icons in set order (used to backfill older databases)', () => {
  assert.deepEqual([...BOT_ICONS], ['hex', 'circle', 'square', 'diamond', 'triangle', 'shield', 'octagon', 'capsule', 'pentagon']);
  assert.equal(DEFAULT_BOT_ICON, 'hex');
});

test('v1.5 shapes are the nine v1.4 icons (same names) plus chip, antenna, monitor; colors are a fixed palette with blue default', () => {
  assert.deepEqual([...BOT_SHAPES], [...BOT_ICONS, 'chip', 'antenna', 'monitor']);
  assert.equal(DEFAULT_BOT_SHAPE, 'hex');
  assert.deepEqual([...BOT_COLORS], ['blue', 'cyan', 'green', 'yellow', 'orange', 'coral', 'pink', 'violet']);
  assert.equal(DEFAULT_BOT_COLOR, 'blue');
});

test('pickLeastUsedIcon: least-used icon, ties broken in set order; unknown values count as the fallback', () => {
  assert.equal(pickLeastUsedIcon([]), 'hex');
  assert.equal(pickLeastUsedIcon(['hex']), 'circle');
  assert.equal(pickLeastUsedIcon(['circle']), 'hex', 'ties go to the earliest icon in the set');
  assert.equal(pickLeastUsedIcon([...BOT_ICONS, 'hex', 'circle']), 'square');
  assert.equal(pickLeastUsedIcon(['bogus', null, '']), 'circle', 'unknown values show as hex, so they count as hex');
});

test('whitelist fallback in main: unknown, tampered or path-like values become the defaults', () => {
  for (const k of BOT_ICONS) assert.equal(normalizeBotIcon(k), k);
  for (const k of BOT_SHAPES) assert.equal(normalizeBotShape(k), k);
  for (const k of BOT_COLORS) assert.equal(normalizeBotColor(k), k);
  for (const bad of BAD_VALUES) {
    assert.equal(normalizeBotIcon(bad), 'hex', `icon fallback for ${String(bad)}`);
    assert.equal(normalizeBotShape(bad), 'hex', `shape fallback for ${String(bad)}`);
    assert.equal(normalizeBotColor(bad), 'blue', `color fallback for ${String(bad)}`);
  }
  // The create form mapping validates too.
  assert.deepEqual([toNewBot({ name: 'a', job: '', shape: 'antenna', color: 'pink' }).shape, toNewBot({ name: 'a', job: '', shape: 'antenna', color: 'pink' }).color], ['antenna', 'pink']);
  const bad = toNewBot({ name: 'a', job: '', shape: '../../x.svg', color: 'url(evil)' });
  assert.equal(bad.shape, 'hex');
  assert.equal(bad.color, 'blue');
});

test('creating bots stores the picked shape and color; anything off the whitelist is stored as the default', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  const a = db.createBot(newBot('Antenna', { shape: 'antenna', color: 'green' }));
  const b = db.createBot(newBot('Monitor', { shape: 'monitor', color: 'violet' }));
  const c = db.createBot(newBot('Bad', { shape: '<svg onload=x>', color: 'javascript:' }));
  const d = db.createBot(newBot('None'));
  assert.deepEqual([a, b, c, d].map((x) => [x.shape, x.color]), [['antenna', 'green'], ['monitor', 'violet'], ['hex', 'blue'], ['hex', 'blue']]);
  db.close();
  db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((x) => [x.shape, x.color]), [['antenna', 'green'], ['monitor', 'violet'], ['hex', 'blue'], ['hex', 'blue']]);
  db.close();
  // Stored raw values are only ever whitelist keys; the v1.4 icon column mirrors the shape for older versions.
  const raw = new Database(file, { readonly: true });
  assert.deepEqual(raw.prepare('SELECT icon, shape, color FROM bots ORDER BY id').all(), [
    { icon: 'antenna', shape: 'antenna', color: 'green' }, { icon: 'monitor', shape: 'monitor', color: 'violet' },
    { icon: 'hex', shape: 'hex', color: 'blue' }, { icon: 'hex', shape: 'hex', color: 'blue' },
  ]);
  raw.close();
});

test('migration from v1.3 (schema 2) to v4: icons backfilled in creation order, then mapped to shapes with the default color', () => {
  const file = tmpDbFile();
  // Creation order differs from id order: Charlie (id 3) is the oldest, then Alpha, then Bravo.
  makeV2Db(file, [
    { name: 'Alpha', createdAt: '2026-01-02T00:00:00.000Z' },
    { name: 'Bravo', createdAt: '2026-01-03T00:00:00.000Z' },
    { name: 'Charlie', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.ok(!columnNames(file).includes('icon'));

  let db = new CipherDb(file);
  const byName = Object.fromEntries(db.listBots().map((b) => [b.name, `${b.shape}/${b.color}`]));
  assert.deepEqual(byName, { Charlie: 'hex/blue', Alpha: 'circle/blue', Bravo: 'square/blue' });
  db.close();

  // Reopening is a no-op: no duplicate-column error, values unchanged, schema version 4.
  db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((b) => b.shape), ['circle', 'square', 'hex']);
  db.close();
  for (const c of ['icon', 'shape', 'color']) assert.equal(columnNames(file).filter((n) => n === c).length, 1);
  const raw = new Database(file, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 4);
  raw.close();
});

test('schema v4 shape/color migration from v1.4 (schema 3): each bot keeps its v1.4 icon as the shape, default color; idempotent', () => {
  const file = tmpDbFile();
  makeV2Db(file, [
    { name: 'Shield', createdAt: '2026-01-01T00:00:00.000Z' },
    { name: 'Pentagon', createdAt: '2026-01-02T00:00:00.000Z' },
    { name: 'Tampered', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
  let raw = new Database(file);
  raw.exec('ALTER TABLE bots ADD COLUMN icon TEXT');
  raw.prepare("UPDATE bots SET icon = 'shield' WHERE id = 1").run();
  raw.prepare("UPDATE bots SET icon = 'pentagon' WHERE id = 2").run();
  raw.prepare("UPDATE bots SET icon = '../../etc/passwd' WHERE id = 3").run();
  raw.pragma('user_version = 3');
  raw.close();

  let db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((b) => [b.name, b.shape, b.color]),
    [['Shield', 'shield', 'blue'], ['Pentagon', 'pentagon', 'blue'], ['Tampered', 'hex', 'blue']]);
  db.close();

  // A half-done earlier upgrade (shape column present, color missing, version still 3) finishes cleanly.
  raw = new Database(file);
  raw.prepare("UPDATE bots SET color = NULL WHERE id = 2").run();
  raw.pragma('user_version = 3');
  raw.close();
  db = new CipherDb(file);
  db.close();
  db = new CipherDb(file);
  assert.deepEqual(db.listBots().map((b) => [b.shape, b.color]), [['shield', 'blue'], ['pentagon', 'blue'], ['hex', 'blue']]);
  db.close();
});

test('tampered stored shape/color values are shown as the defaults and never passed through', () => {
  const file = tmpDbFile();
  let db = new CipherDb(file);
  db.createBot(newBot('Tampered', { shape: 'chip', color: 'pink' }));
  db.close();
  const raw = new Database(file);
  raw.prepare("UPDATE bots SET shape = '../../../etc/passwd', color = 'red;background:url(x)' WHERE id = 1").run();
  raw.close();
  db = new CipherDb(file);
  assert.deepEqual([db.getBot(1)?.shape, db.getBot(1)?.color], ['hex', 'blue']);
  db.close();
});

test('renderer whitelists match main; the bundled SVGs are Liz\'s files verbatim and plain static SVG in currentColor', () => {
  assert.deepEqual([...rendererIcons.BOT_SHAPES], [...BOT_SHAPES]);
  assert.deepEqual([...rendererIcons.BOT_COLORS], [...BOT_COLORS]);
  assert.equal(rendererIcons.DEFAULT_SHAPE, DEFAULT_BOT_SHAPE);
  assert.equal(rendererIcons.DEFAULT_COLOR, DEFAULT_BOT_COLOR);
  assert.deepEqual(Object.keys(BOT_SHAPE_SVGS), [...BOT_SHAPES]);
  const artDir = path.join(repoRoot, 'art', 'v1.5', 'bot-icons-svg');
  BOT_SHAPES.forEach((k, i) => {
    const file = `cipher-bot-${String(i + 1).padStart(2, '0')}-${k}.svg`;
    const svg = BOT_SHAPE_SVGS[k];
    assert.equal(svg, fs.readFileSync(path.join(artDir, file), 'utf8').trim(), `${file} is bundled verbatim (rerun scripts/gen-bot-icon-svgs.mjs)`);
    assertStaticSvg(file, svg);
    assert.match(svg, /stroke="currentColor"/, `${file} draws in currentColor`);
    assert.match(svg, /fill="#15171c"/, `${file} keeps the dark body (two-tone look)`);
  });
});

test('whitelist fallback in the renderer: shapes map only to bundled SVGs, colors only to .c-<key> classes', () => {
  assert.equal(rendererIcons.shapeOf('monitor'), 'monitor');
  assert.equal(rendererIcons.colorClass('coral'), 'c-coral');
  for (const bad of BAD_VALUES) {
    assert.equal(rendererIcons.shapeOf(bad), 'hex', `shape fallback for ${String(bad)}`);
    assert.equal(rendererIcons.colorOf(bad), 'blue', `color fallback for ${String(bad)}`);
    assert.equal(rendererIcons.colorClass(bad), 'c-blue');
    assert.equal(rendererIcons.shapeSvg(bad), BOT_SHAPE_SVGS.hex);
  }
  assert.equal(rendererIcons.leastUsedShape([]), 'hex');
  assert.equal(rendererIcons.leastUsedShape(['hex', 'circle']), 'square');
  assert.equal(rendererIcons.leastUsedShape([...BOT_SHAPES]), 'hex');
});

test('every palette color has a CSS class that reads on #15171c; blue is #5b8cff', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  for (const c of BOT_COLORS) assert.match(css, new RegExp(`\\.c-${c}\\s*\\{ color: #[0-9a-f]{6}; --glow: \\d+, \\d+, \\d+; \\}`), `.c-${c}`);
  assert.match(css, /\.c-blue\s*\{ color: #5b8cff;/);
});

test('bot icon animation pauses when unfocused and is off with reduced motion; CSP and no inline styles kept', () => {
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /:root\.unfocused \.bot-icon \{ animation-play-state: paused; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-icon \{ animation: none;/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /style-src 'self'; img-src 'self' data:;/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /<style/);
  // Every icon rendering goes through iconSvg(), which sets the .bot-icon class; the renderer never sets inline styles.
  const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
  assert.doesNotMatch(js, /\.style\b|setAttribute\(\s*['"]style|cssText|innerHTML|insertAdjacentHTML/);
  assert.match(js, /`\$\{extraClass\} \$\{colorClass\(color\)\}`/);
  assert.match(js, /extraClass = 'bot-icon'/);
});

test('Liz\'s frames ship as plain static SVG (40px top, 28px bottom) and are mounted as full-width bars', () => {
  const dir = path.join(rendererDir, 'assets', 'frames');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cipher-frame-bottom.svg', 'cipher-frame-top.svg']);
  for (const [f, h] of [['cipher-frame-top.svg', 40], ['cipher-frame-bottom.svg', 28]] as const) {
    const svg = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(svg.trim(), fs.readFileSync(path.join(repoRoot, 'art', 'v1.5', 'frames', f), 'utf8').trim(), `${f} is Liz's file`);
    assertStaticSvg(f, svg, ['preserveAspectRatio', 'overflow']);
    assert.match(svg, new RegExp(`^<svg [^>]*width="100%" height="${h}"`));
  }
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /--titlebar-h: env\(titlebar-area-height, 40px\)/);
  assert.match(css, /#titlebar \{[^}]*url\("assets\/frames\/cipher-frame-top\.svg"\) no-repeat 0 0 \/ 100% 100%;\s*-webkit-app-region: drag;/);
  assert.match(css, /#bottombar \{ height: var\(--bottombar-h\); background: var\(--bg\) url\("assets\/frames\/cipher-frame-bottom\.svg"\)/);
  assert.match(css, /#app \{ display: flex; height: calc\(100vh - var\(--titlebar-h\) - var\(--bottombar-h\)\); \}/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  assert.match(main, /TITLE_BAR_HEIGHT = 40/);
  assert.match(main, /titleBarOverlay: \{ color: FRAME_BG, symbolColor: FRAME_ACCENT, height: TITLE_BAR_HEIGHT \}/);
  assert.match(main, /sandbox: true/);
});

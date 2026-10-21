import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The renderer's modules are ES modules; Electron's Node can require() them directly (see botIcons.test.ts).
/* eslint-disable @typescript-eslint/no-require-imports */
const av = require('../renderer/avatar.js') as {
  phaseOf(id: unknown): number; avatarMarkup(shape: unknown, color: unknown): string; avatarDefsMarkup(): string; AVATAR_PHASES: number;
};
const icons = require('../renderer/botIcon.js') as { BOT_SHAPES: readonly string[]; BOT_COLORS: readonly string[]; BOT_PALETTES: Record<string, { a1: string; a2: string }> };
const { BOT_SHAPE_PARTS } = require('../renderer/botIconSvgs.js') as { BOT_SHAPE_PARTS: Record<string, Record<string, string>> };
/* eslint-enable @typescript-eslint/no-require-imports */

const repoRoot = path.join(__dirname, '..', '..');
const rendererDir = path.join(repoRoot, 'src', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'avatar.css'), 'utf8');

test('avatar phase: stable per id, in range, and spread so neighbours differ', () => {
  for (let i = 0; i < 50; i++) { const p = av.phaseOf(i); assert.ok(p >= 0 && p < av.AVATAR_PHASES); assert.equal(av.phaseOf(i), p); }
  assert.equal(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(av.phaseOf)).size >= 6, true);
  for (let i = 1; i < 40; i++) assert.notEqual(av.phaseOf(i), av.phaseOf(i + 1), `bots ${i} and ${i + 1}`);
  assert.equal(av.phaseOf('x'), av.phaseOf(0));
  for (let p = 0; p < av.AVATAR_PHASES; p++) assert.match(css, new RegExp(`\\.avatar\\.ph-${p} \\{ --av-delay:`));
});

test('every shape splits into named parts (body, two eyes, mouth) from Liz\'s files', () => {
  assert.deepEqual(Object.keys(BOT_SHAPE_PARTS), [...icons.BOT_SHAPES]);
  for (const k of icons.BOT_SHAPES) {
    const p = BOT_SHAPE_PARTS[k];
    assert.match(p.body, /fill="#15171c"/, k);
    assert.equal((p.eyes.match(/<circle/g) ?? []).length, 2, `${k} eyes`);
    assert.ok(p.mouth.length > 0, `${k} mouth`);
    const v2 = fs.readFileSync(path.join(repoRoot, 'art', 'v2', 'bot-avatars-svg', `cipher-bot-${String(icons.BOT_SHAPES.indexOf(k) + 1).padStart(2, '0')}-${k}.svg`), 'utf8');
    for (const g of ['deco', 'ports', 'body', 'eyes', 'mouth']) assert.match(v2, new RegExp(`<g class="${g}">`), `${k} v2 art ${g}`);
  }
  assert.match(BOT_SHAPE_PARTS.antenna.deco, /<circle/); // the antenna ball is decoration, not an eye
  assert.match(BOT_SHAPE_PARTS.chip.deco, /<line/);
});

test('avatar markup: aura, orbit, glass body, shine, face; palette gradients only; static, no scripts or styles', () => {
  for (const k of icons.BOT_SHAPES) for (const c of icons.BOT_COLORS) {
    const m = av.avatarMarkup(k, c);
    for (const part of ['av-aura', 'av-orbit', 'av-figure', 'av-body', 'av-shine', 'av-face', 'av-eyes', 'av-mouth']) assert.match(m, new RegExp(`class="${part}"`));
    assert.match(m, new RegExp(`url\\(#cav-g-${c}\\)`));
    assert.match(m, new RegExp(`url\\(#cav-e-${c}\\)`));
    assert.doesNotMatch(m, /currentColor|#15171c|script|style|href|on[a-z]+=/i);
  }
  // tampered values fall back to the defaults, never into the markup
  assert.equal(av.avatarMarkup('../../etc', '"><script>'), av.avatarMarkup('hex', 'blue'));
  const defs = av.avatarDefsMarkup();
  for (const c of icons.BOT_COLORS) {
    for (const g of ['s', 'g', 'a', 'e']) assert.match(defs, new RegExp(`id="cav-${g}-${c}"`));
    assert.ok(defs.includes(icons.BOT_PALETTES[c].a1) && defs.includes(icons.BOT_PALETTES[c].a2));
  }
});

test('palettes are 8 two-tone brand gradients (Cipher blue default)', () => {
  assert.deepEqual(Object.keys(icons.BOT_PALETTES), [...icons.BOT_COLORS]);
  for (const c of icons.BOT_COLORS) { const { a1, a2 } = icons.BOT_PALETTES[c]; assert.match(a1, /^#[0-9A-F]{6}$/i); assert.notEqual(a1, a2); }
  assert.equal(icons.BOT_PALETTES.blue.a2, '#22C8E8');
  assert.equal(icons.BOT_PALETTES.violet.a1, '#8B6CFF');
});

test('avatar CSS: states, reduced motion, offscreen/unfocused pause, pickers animate only hovered or selected', () => {
  for (const st of ['thinking', 'speaking']) assert.match(css, new RegExp(`\\.avatar\\[data-state="${st}"\\]`));
  assert.match(css, /@keyframes av-blink/);
  assert.match(css, /@keyframes av-breathe/);
  assert.match(css, /@keyframes av-gaze/);
  assert.match(css, /\.avatar\.is-muted/);
  assert.match(css, /\.avatar\.is-archived/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.avatar, \.avatar \* \{ animation: none !important;/);
  assert.match(css, /\.avatar\.av-off, \.avatar\.av-off \*/);
  assert.match(css, /label\.shape-opt:not\(:hover\):not\(:has\(input:checked\)\) \.avatar \*/);
  assert.match(css, /\.room-msg:not\(\.live\) \.avatar \* \{ animation: none !important; \}/);
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="avatar.css" \/>/);
});

test('renderer: avatars in rail, header (large), rooms and empty-chat hero; rail is not rebuilt per token', () => {
  const js = fs.readFileSync(path.join(rendererDir, 'renderer.ts'), 'utf8');
  assert.match(js, /createAvatar\(\{ shape: b\.shape, color: b\.color, size, botId: b\.id, muted: b\.muted, archived: b\.archived/);
  assert.match(js, /botIcon\(bot, 56, 'av-header'\)/);
  assert.match(js, /botIcon\(bot, 168, 'av-hero'\)/);
  assert.match(js, /avatarToken\(ev\.botId\)/);
  assert.match(js, /markSpeaking\(botId, true\)\) renderRail\(\)/);
  assert.doesNotMatch(js, /state\.speakingBots\.add\(botId\); renderRail\(\);/);
  const avs = fs.readFileSync(path.join(rendererDir, 'avatar.ts'), 'utf8');
  assert.doesNotMatch(avs, /\.style\b|cssText|innerHTML|requestAnimationFrame/);
  assert.match(avs, /IntersectionObserver/);
});

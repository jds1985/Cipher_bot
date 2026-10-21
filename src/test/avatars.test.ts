import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// v1.26: bot avatars are drones (shared/droneParts.ts) driven by avatar.ts; the v2 robot avatars are retired.
/* eslint-disable @typescript-eslint/no-require-imports */
const av = require('../renderer/avatar.js') as {
  phaseOf(id: unknown): number; AVATAR_PHASES: number; droneDetailFor(size: number): 'full' | 'small';
  droneInstanceMarkup(spec: unknown, size: number, instance: string): string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const repoRoot = path.join(__dirname, '..', '..');
const rendererDir = path.join(repoRoot, 'src', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'drone.css'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'renderer.ts'), 'utf8');
const avs = fs.readFileSync(path.join(rendererDir, 'avatar.ts'), 'utf8');

test('avatar phase: stable per id, in range, and spread so neighbours differ', () => {
  for (let i = 0; i < 50; i++) { const p = av.phaseOf(i); assert.ok(p >= 0 && p < av.AVATAR_PHASES); assert.equal(av.phaseOf(i), p); }
  for (let i = 1; i < 40; i++) assert.notEqual(av.phaseOf(i), av.phaseOf(i + 1), `bots ${i} and ${i + 1}`);
  for (let p = 0; p < av.AVATAR_PHASES; p++) assert.ok(css.includes(`.drone.ph-${p} {`));
});

test('drone instances: unique ids per instance, small detail at <=48px (no grain), tampered specs sanitized', () => {
  const spec = { shell: 'circuit', palette: 'cipher', eye: 'hex', fins: 'panel', crystal: 'gem', accessories: [] };
  const a = av.droneInstanceMarkup(spec, 42, 'i1'), b = av.droneInstanceMarkup(spec, 42, 'i2');
  const ids = (s: string): string[] => [...s.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids(a).filter((i) => ids(b).includes(i)).length, 0);
  for (const m of a.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids(a).includes(m[1]), m[1]);
  assert.equal(av.droneDetailFor(48), 'small'); assert.equal(av.droneDetailFor(56), 'full');
  assert.ok(!a.includes('feTurbulence') && av.droneInstanceMarkup(spec, 168, 'i3').includes('feTurbulence'));
  const bad = av.droneInstanceMarkup({ shell: '"><script>', accessories: ['onload=x'] }, 42, 'i4');
  assert.doesNotMatch(bad, /script|onload|style=/i);
});

test('app loads drone.css (not the retired avatar.css) under the CSP; no inline styles', () => {
  assert.match(html, /<link rel="stylesheet" href="drone.css" \/>/);
  assert.doesNotMatch(html, /avatar\.css/);
  assert.match(html, /style-src 'self'/);
  assert.ok(!fs.existsSync(path.join(rendererDir, 'avatar.css')));
  assert.doesNotMatch(avs, /\.style\b|cssText|innerHTML|requestAnimationFrame/);
  assert.match(avs, /IntersectionObserver/);
  for (const c of ['[data-state="thinking"]', '[data-state="speaking"]', '.beat-a', '.is-muted', '.is-archived', '.av-off', 'prefers-reduced-motion', ':root.reduce-motion']) assert.ok(css.includes(c), c);
});

test('renderer: drones everywhere bots appear (rail, header, hero, rooms, pickers); states from real events', () => {
  assert.match(js, /createAvatar\(\{ spec: b\.drone, size, botId: b\.id, muted: b\.muted, archived: b\.archived/);
  assert.match(js, /botIcon\(bot, 56, 'av-header'\)/);
  assert.match(js, /botIcon\(bot, 168, 'av-hero'\)/);
  assert.match(js, /avatarToken\(ev\.botId\)/);
  assert.match(js, /markSpeaking\(botId, true\)\) renderRail\(\)/);
  assert.doesNotMatch(js, /createAvatar\(\{ shape/);
});

test('builder in the create/edit form: preview, theme box, part pickers, palettes; saves the spec', () => {
  for (const id of ['db-preview', 'db-theme', 'db-pickers', 'db-surprise', 'db-why']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="shape-picker"|id="color-picker"/);
  assert.match(js, /drone: state\.builderSpec/);
  assert.match(js, /setBuilderSpec\(bot\.drone\)/);
  assert.match(js, /themeDrone\(text\)/);
  for (const k of ['cipher', 'orange', 'obsidian']) assert.ok(css.includes(`.dr-swatch.pal-${k} {`), k);
});

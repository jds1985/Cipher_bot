import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const dp = require('../shared/droneParts.js') as typeof import('../shared/droneParts.js');
const dt = require('../shared/droneTheme.js') as typeof import('../shared/droneTheme.js');
/* eslint-enable @typescript-eslint/no-require-imports */
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'drone.css'), 'utf8');

const allSpecs = (): import('../shared/droneParts.js').DroneSpec[] => {
  const out = [];
  for (const shell of dp.DRONE_SHELLS) for (const eye of dp.DRONE_EYES) out.push(dp.sanitizeSpec({ shell, eye, palette: 'cipher', fins: 'blade', crystal: 'gem' }));
  for (const fins of dp.DRONE_FINS) for (const crystal of dp.DRONE_CRYSTALS) out.push(dp.sanitizeSpec({ fins, crystal }));
  for (const a of dp.DRONE_ACCESSORIES) out.push(dp.sanitizeSpec({ accessories: [a] }));
  for (const palette of dp.DRONE_PALETTE_KEYS) out.push(dp.sanitizeSpec({ palette }));
  return out;
};

test('library sizes: 8 shells, 4 eyes, 4 fins, 4 crystals, >=10 accessories, 8 presets', () => {
  assert.equal(dp.DRONE_SHELLS.length, 8);
  assert.ok(dp.DRONE_EYES.length >= 3 && dp.DRONE_FINS.length >= 4 && dp.DRONE_CRYSTALS.length >= 2);
  assert.ok(dp.DRONE_ACCESSORIES.length >= 10);
  assert.deepEqual(dp.DRONE_PRESET_KEYS, ['cipher', 'researcher', 'writer', 'coder', 'planner', 'scout', 'musician', 'error']);
  for (const k of dp.DRONE_SHELLS) assert.ok(dp.DRONE_LIBRARY.shells[k]);
  for (const k of dp.DRONE_ACCESSORIES) assert.ok(dp.DRONE_LIBRARY.accessories[k]);
});

test('composer is deterministic and every part combination renders well-formed SVG', () => {
  for (const s of allSpecs()) for (const detail of ['full', 'small'] as const) {
    const a = dp.composeDrone(s, { detail }), b = dp.composeDrone(s, { detail });
    assert.equal(a, b);
    assert.match(a, /^<svg [^>]*class="drone[^"]*"/);
    assert.ok(a.endsWith('</svg>'));
    assert.ok(!a.includes('undefined') && !a.includes('NaN') && !a.includes('style='), dp.specKey(s));
    assert.equal((a.match(/<g\b/g) ?? []).length, (a.match(/<\/g>/g) ?? []).length, 'balanced groups ' + dp.specKey(s));
    for (const cls of ['dr-float', 'dr-body', 'dr-pendant', 'dr-eye', 'dr-lid', 'dr-scan']) assert.ok(a.includes(cls), cls);
  }
});

test('ids are unique per spec/uid so drones can share a page; referenced ids exist', () => {
  const a = dp.composeDrone(dp.presetSpec('cipher')), b = dp.composeDrone(dp.presetSpec('error'));
  const ids = (s: string): string[] => [...s.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids(a).filter((i) => ids(b).includes(i)).length, 0);
  assert.notEqual(dp.composeDrone(dp.presetSpec('cipher'), { uid: 'x' }), a);
  for (const s of [a, b]) for (const m of s.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids(s).includes(m[1]), m[1]);
});

test('presets match the concept sheet', () => {
  const p = dp.DRONE_PRESETS;
  assert.equal(p.cipher.eye, 'hex'); assert.equal(p.cipher.shell, 'circuit');
  assert.deepEqual([...p.error.accessories], ['tophat', 'monocle-cracked']); assert.equal(p.error.shell, 'cracked');
  assert.equal(p.coder.eye, 'visor'); assert.equal(p.writer.fins, 'quill');
  assert.ok((p.musician.accessories as readonly string[]).includes('headphones'));
  assert.ok((p.scout.accessories as readonly string[]).includes('antenna'));
  assert.ok((p.researcher.accessories as readonly string[]).includes('monocle-magnifier'));
  assert.equal(new Set(dp.DRONE_PRESET_KEYS.map((k) => p[k].palette)).size, 8);
});

test('sanitizeSpec drops junk (LLM output) and caps accessories', () => {
  const s = dp.sanitizeSpec({ shell: 'banana', palette: 'nope', eye: 3, accessories: ['halo', 'halo', 'evil<script>', 'crown', 'tophat', 'leaf'] });
  assert.deepEqual(s, { shell: 'plain', palette: 'cipher', eye: 'ring', fins: 'blade', crystal: 'gem', accessories: ['halo', 'crown', 'tophat'] });
  assert.deepEqual(dp.sanitizeSpec(null).accessories, []);
  assert.ok(!dp.composeDrone(s, { title: '<b>"x"</b>' }).includes('<b>'));
});

test('small detail is a simplified optical variant', () => {
  const s = dp.presetSpec('planner');
  const full = dp.composeDrone(s), small = dp.composeDrone(s, { detail: 'small' });
  assert.ok(small.length < full.length);
  assert.match(small, /class="drone [^"]*dr-sm/);
});

test('theme mapper: required words map to their themes', () => {
  const want: Record<string, string> = { basketball: 'basketball', music: 'music', space: 'space', detective: 'detective', gardening: 'gardening',
    fire: 'fire', ocean: 'ocean', coding: 'coding', chess: 'chess', coffee: 'coffee', 'I love writing poems': 'writing', 'Flowers!': 'gardening', 'DJ beats': 'music' };
  for (const [w, t] of Object.entries(want)) { const r = dt.themeDrone(w); assert.equal(r.theme, t, w); assert.equal(r.source, 'keyword'); }
  assert.equal(dt.themeDrone('basketball').spec.shell, 'basketball');
  assert.ok(dt.themeDrone('basketball').spec.accessories.includes('hoop'));
  assert.ok(dt.themeDrone('music').spec.accessories.includes('headphones'));
  assert.equal(dt.themeDrone('coding').spec.eye, 'visor');
});

test('theme mapper: unknown words fall back to a deterministic hashed spec', () => {
  const a = dt.themeDrone('zorblax'), b = dt.themeDrone('  ZORBLAX ');
  assert.equal(a.source, 'hash'); assert.deepEqual(a.spec, b.spec);
  assert.deepEqual(a.spec, dp.sanitizeSpec(a.spec));
  const many = new Set(['qwop', 'florp', 'blik', 'snarf', 'yonder', 'mizzle', 'quux', 'vex', 'plonk', 'glim'].map((w) => dp.specKey(dt.themeDrone(w).spec)));
  assert.ok(many.size >= 8);
  assert.equal(dt.themeDrone('').source, 'hash');
});

test('LLM part prompt lists the catalog', () => {
  const p = dt.llmPartPrompt('basketball');
  for (const k of [...dp.DRONE_SHELLS, ...dp.DRONE_ACCESSORIES]) assert.ok(p.includes(`"${k}"`), k);
});

test('drone.css: states, phases, pendant sway and reduced motion', () => {
  for (const s of ['thinking', 'speaking']) assert.ok(css.includes(`[data-state="${s}"]`));
  for (const c of ['.is-muted', '.is-archived', 'dr-sway', 'dr-blink', 'dr-bob', 'prefers-reduced-motion', ':root.reduce-motion']) assert.ok(css.includes(c), c);
  for (let p = 0; p < 8; p++) assert.ok(css.includes(`.drone.ph-${p} {`));
});

// ---------- v2 polish ----------
const brandDir = path.join(__dirname, '..', '..', 'art', 'brand');
/* eslint-disable @typescript-eslint/no-require-imports */
const hm = require('../shared/hexMark.js') as typeof import('../shared/hexMark.js');
/* eslint-enable @typescript-eslint/no-require-imports */

test('small sizes: fins tucked, sphere+eye dominate, identifying accessories kept, Error lifted', () => {
  for (const k of dp.DRONE_PRESET_KEYS) {
    const s = dp.presetSpec(k), small = dp.composeDrone(s, { detail: 'small' }), full = dp.composeDrone(s);
    assert.match(small, /scale\(\.58 \.7\)/, `${k} fins tucked`);
    assert.ok(!/scale\(\.58 \.7\)/.test(full));
    for (const a of s.accessories) assert.ok(small.includes(`dr-acc-${a}`), `${k} keeps ${a} at small size`);
  }
  const err = dp.composeDrone(dp.presetSpec('error'), { detail: 'small' });
  assert.match(err, /r="23"/, 'bigger, brighter iris at small size');
  assert.ok(err.includes('dr-acc-tophat') && err.includes('dr-acc-monocle-cracked'));
  // obsidian is lifted off pure black
  const hi = parseInt(dp.DRONE_PALETTES.obsidian.hi.slice(1), 16);
  assert.ok(((hi >> 16) + ((hi >> 8) & 255) + (hi & 255)) / 3 > 90);
});

test('Cipher eye is the real Hex Circuit mark, copied verbatim from the brand files', () => {
  for (const [f, m] of [['hex_circuit.svg', hm.HEX_MARK], ['hex_circuit_small.svg', hm.HEX_MARK_SMALL]] as const) {
    const src = fs.readFileSync(path.join(brandDir, f), 'utf8');
    assert.ok(src.includes(m.body.replaceAll('{G}', 'url(#g)')), f);
    assert.ok(src.includes(m.stops));
  }
  const full = dp.composeDrone(dp.presetSpec('cipher')), small = dp.composeDrone(dp.presetSpec('cipher'), { detail: 'small' });
  const firstPath = (m: { body: string }): string => /d="([^"]+)"/.exec(m.body)![1];
  assert.ok(full.includes(firstPath(hm.HEX_MARK)) && small.includes(firstPath(hm.HEX_MARK_SMALL)));
  assert.ok(full.includes('#1557F0') && full.includes('#D4EA48'), 'brand gradient');
});

test('seams are projected sphere circles (wrap the sphere), with grain/AO at full detail', () => {
  const bb = dp.composeDrone(dp.sanitizeSpec({ shell: 'basketball', palette: 'orange' }));
  assert.ok(bb.includes('-ao"') && bb.includes('feTurbulence'));
  const d = dp.sphereCirclePath([0, 1, 0], Math.PI / 2);
  const pts = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(pts.length > 20);
  for (const [x, y] of pts) assert.ok(Math.hypot(x - 128, y - 118) <= 68.5, 'on the sphere');
  assert.ok(new Set(pts.map(([, y]) => Math.round(y))).size > 5, 'equator curves (not a straight line)');
});

test('recolor without .dr-themed: palette class on root + CSS vars for every token, in sync with DRONE_PALETTES', () => {
  const svg = dp.composeDrone(dp.presetSpec('scout'));
  assert.match(svg, /class="drone pal-coral /);
  for (const t of ['body', 'deep', 'hi', 'glow', 'glow2', 'metal']) {
    assert.ok(css.includes(`.drone .dr-f-${t} { fill: var(--d-${t}, var(--dp-${t})); }`), t);
    assert.ok(css.includes(`.drone .dr-s-${t} { stop-color: var(--d-${t}, var(--dp-${t})); }`), t);
  }
  for (const [k, p] of Object.entries(dp.DRONE_PALETTES)) {
    assert.ok(css.includes(`.drone.pal-${k} { --dp-body: ${p.body}; --dp-deep: ${p.deep}; --dp-hi: ${p.hi}; --dp-glow: ${p.glow}; --dp-glow2: ${p.glow2}; --dp-metal: ${p.metal}; }`), k);
  }
  assert.ok(!css.includes('dr-themed'));
  // every token class element still carries a literal fallback color attribute
  for (const m of svg.matchAll(/<[^>]*class="dr-([fks])-(\w+)"[^>]*>/g)) assert.match(m[0], /(fill|stroke|stop-color)="#[0-9a-fA-F]{6}"/);
});

test('theme mapper: negation', () => {
  assert.equal(dt.themeDrone('not music, space').theme, 'space');
  assert.equal(dt.themeDrone("I don't like coffee, I like chess").theme, 'chess');
  assert.equal(dt.themeDrone('hate fire but love the ocean').theme, 'ocean');
  const r = dt.themeDrone("don't like music");
  assert.notEqual(r.theme, 'music');
  assert.ok(!r.spec.accessories.includes('headphones'));
  assert.equal(dt.themeDrone('no basketball').source, 'hash');
});

test('theme mapper: multi-word picks strongest match and borrows an accessory from the second', () => {
  const r = dt.themeDrone('basketball and music');
  assert.equal(r.spec.shell, 'basketball');
  assert.deepEqual(r.spec.accessories, ['hoop', 'headphones']);
  assert.equal(r.theme, 'basketball+music');
  const s = dt.themeDrone('music songs beats with a little space');
  assert.equal(s.spec.shell, 'striped'); assert.ok(s.spec.accessories.includes('star'));
  assert.deepEqual(dt.themeDrone('basketball and music'), r, 'deterministic');
});

test('composed SVG is well-formed XML: no tag repeats an attribute (DOMParser image/svg+xml in the app)', () => {
  for (const s of allSpecs()) for (const detail of ['full', 'small'] as const) {
    for (const tag of dp.composeDrone(s, { detail }).match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const names = [...tag.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]);
      assert.equal(new Set(names).size, names.length, `${dp.specKey(s)} ${detail}: ${tag.slice(0, 80)}`);
    }
  }
});

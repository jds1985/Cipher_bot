import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rendererDir = path.join(__dirname, '..', '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(rendererDir, 'brand.css'), 'utf8');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(rendererDir, 'renderer.ts'), 'utf8');

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('brand.css loads last, from a file (CSP style-src self), with no remote urls', () => {
  assert.match(html, /href="styles\.css" \/>\s*<link rel="stylesheet" href="drone\.css" \/>\s*<link rel="stylesheet" href="brand\.css" \/>/);
  assert.match(html, /style-src 'self'/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(css, /url\(\s*['"]?(https?:|\/\/)/);
  assert.doesNotMatch(css, /@import/);
});

test('navy base, brand gradient and frosted glass; no busy nebula image', () => {
  assert.match(css, /--bg: #070b1a;/);
  assert.match(css, /--brand-grad: linear-gradient\(100deg, #1557f0 0%, #0e8cf8 33%, #2fddcf 55%, #8cef60 80%, #d4ea48 100%\)/);
  assert.match(css, /backdrop-filter: blur/);
  assert.doesNotMatch(css, /nebula/i);
});

test('accessible contrast: text, muted text and white-on-button ramp stay ≥ 4.5:1', () => {
  assert.ok(contrast('#e9eefc', '#070b1a') >= 7);
  assert.ok(contrast('#9aa6c4', '#121c3a') >= 4.5);
  for (const stop of ['#1450dc', '#0a6ccc', '#0b7a76', '#1a5cf0', '#0a70cf', '#0b7c78']) assert.ok(contrast('#ffffff', stop) >= 4.5, stop);
  assert.match(css, /:focus-visible \{ outline: 2px solid #2fddcf;/);
});

test('room "+" uses the Hex Circuit mark (no old flat shapes); builder thumbnails get a rim', () => {
  assert.match(renderer, /roomPlusMark\.src = 'assets\/brand\/hex_circuit_small\.svg'/);
  assert.doesNotMatch(renderer, /\['hex', 'circle'\]\.map/);
  assert.match(css, /\.drone-builder \.db-opt \{[^}]*border: 1px solid rgba\(150, 180, 255, \.28\)/);
  assert.match(css, /\.drone-builder \.dr-swatch \{ outline: 1px solid/);
});

// Copies non-TS renderer assets (HTML/CSS and assets/) into dist/.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'src/renderer';
const out = 'dist/renderer';
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith('.html') || f.endsWith('.css')) cpSync(join(src, f), join(out, f));
}
const assetsSrc = join(src, 'assets');
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, join(out, 'assets'), { recursive: true });
}

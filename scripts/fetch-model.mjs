// Copies the PUBLIC Cipher model into resources/model/ and verifies it against manifest.json (size + sha256).
// Never copies the private dev build. Source: CIPHER_MODEL_SRC or /workspace/cipher_runtime/sft.ctern.
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'resources/model';
const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const devLike = (v) => typeof v === 'string' && /(^|[^a-z])(dev|private)([^a-z]|$)/i.test(v);
const src = process.env.CIPHER_MODEL_SRC || '/workspace/cipher_runtime/sft.ctern';
if (m.build !== 'public' || devLike(m.id) || devLike(m.file) || devLike(src)) {
  console.error('fetch-model: refusing: only the public Cipher build may be bundled.');
  process.exit(1);
}
const dest = join(dir, m.file);
const sha = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
if (!existsSync(dest) || statSync(dest).size !== m.bytes || (await sha(dest)) !== m.sha256) {
  if (!existsSync(src)) { console.error(`fetch-model: ${src} not found (set CIPHER_MODEL_SRC)`); process.exit(1); }
  copyFileSync(src, dest);
}
const got = await sha(dest);
if (statSync(dest).size !== m.bytes || got !== m.sha256) { console.error(`fetch-model: ${dest} does not match manifest (sha256 ${got})`); process.exit(1); }
console.log(`fetch-model: ${dest} OK (${m.bytes} bytes, ${m.id}, public)`);

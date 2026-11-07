import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fix = path.join(dir, 'fixtures');
const workerSrc = fs.readFileSync(path.join(dir, 'cipher-worker.js'), 'utf8');
const contract = workerSrc.match(/\/\/ CONTRACT_START\n([\s\S]*?)\/\/ CONTRACT_END/);
if (!contract) throw new Error('worker is missing the contract block');
const api = new Function(`${contract[1]}; return { RNG_ADDR, rngState, writeRng, readRng, rngSlotMatches, keepsPrior };`)();

function stub() { return 0; }

async function boot(kind) {
  const buf = fs.readFileSync(path.join(fix, kind === 'mt' ? 'cipher-mt.wasm' : 'cipher-st.wasm'));
  if (kind === 'st') {
    const { instance } = await WebAssembly.instantiate(buf, { a: { a: stub, b: stub, c: stub, d: stub } });
    return { memory: instance.exports.e, sample: instance.exports.l, init: () => {} };
  }
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 16384, shared: true });
  const a = { a: memory };
  for (const name of 'bcdefghijklmnopq') a[name] = stub;
  const { instance } = await WebAssembly.instantiate(buf, { a });
  return { memory, sample: instance.exports.y, init: () => instance.exports.r() };
}

test('seed 0 is an absolute xorshift state, and a second cw_set_sampling call is not', async () => {
  for (const kind of ['st', 'mt']) {
    const rt = await boot(kind);
    rt.init();
    const M = { wasmMemory: rt.memory };
    assert.equal(api.readRng(M), 0x9E3779B97F4A7C15n, kind);
    rt.sample(0.3, 1, 1.15, 0, 0);
    assert.equal(api.rngSlotMatches(M, 0), true, kind);
    rt.sample(0.3, 1, 1.15, 0, 0);
    assert.equal(api.rngSlotMatches(M, 0), false, kind);
    assert.equal(api.readRng(M), 0x9E3779B97F4A7C15n, kind);
    api.writeRng(M, 0);
    assert.equal(api.rngSlotMatches(M, 0), true, kind);
    api.writeRng(M, 1);
    rt.sample(0.3, 1, 1.15, 0, 0);
    api.writeRng(M, 1);
    assert.equal(api.rngSlotMatches(M, 1), true, kind);
  }
});

test('ctx 512 keeps the system segment for every frozen general prompt', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(fix, 'prompt-traces.json'), 'utf8'));
  assert.equal(doc.tokenizerSha256, 'e4bc6fd60a641f62ac614865fb8c8d6034a090123cb565ee7d87d977b52d185e');
  assert.equal(doc.prompts.length, 20);
  for (const row of doc.prompts) {
    assert.equal(row.fullPrompt[0], 4, row.id);
    assert.equal(row.fullPrompt[row.nSystem], 2, row.id);
    assert.equal(row.fullPrompt.at(-1), 3, row.id);
    assert.equal(row.fullPrompt[row.nSystem - 1], doc.newlineId, row.id);
    assert.equal(api.keepsPrior(512, row.nSystem, row.nUserSegment, 128), true, row.id);
    assert.equal(row.keepsSystemAtCtx512, true, row.id);
  }
});

test('cipher.c encoder matches tokenizer.json on the frozen prompts', () => {
  execFileSync('python3', [path.join(dir, 'check_tokenizer.py')], { stdio: 'inherit' });
});

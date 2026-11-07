// Experimental drop-in for the Concierge preview's ./cipher-worker.js.
// Not a production worker. Does not change weights.
//
// Verified against the public runtime bytes, not against a .ctern:
//   cipher-st.wasm sha256 3220b68e1b24d6865ef9ffface9113a0c3b483c5553f315e97989526d0d87d77
//   cipher-mt.wasm sha256 a28bdc23910c80eb34126777b38370e7562cda93917ae1a75c7dc5b8a12b068e
// Both keep the xorshift state at byte 2224 and both stop cw_next on EOT, user, and pad only.
// Native cipher-serve also stops on system and assistant. This file stops the visible
// stream when cw_token_bytes returns 0, which is how those builds report every special.
// The special id has already been evaluated inside cw_next. cw_end still writes EOT.
// A per-question reset drops that cache before the next prompt.
//
// cw_set_sampling XORs the seed into the current state. A second call with seed 0
// does not restore seed 0. writeRng stores golden ^ (seed * mix + 1) before sampling.

// CONTRACT_START
const RNG_ADDR = 2224;
const RNG_GOLDEN = 0x9E3779B97F4A7C15n;
const RNG_MIX = 0x2545F4914F6CDD1Dn;

function rngState(seed) {
  const s = BigInt.asIntN(64, BigInt(seed | 0));
  return RNG_GOLDEN ^ BigInt.asUintN(64, s * RNG_MIX + 1n);
}
function readRng(M) {
  return new DataView(M.wasmMemory.buffer).getBigUint64(RNG_ADDR, true);
}
function writeRng(M, seed) {
  new DataView(M.wasmMemory.buffer).setBigUint64(RNG_ADDR, rngState(seed), true);
}
function rngSlotMatches(M, seed) {
  return readRng(M) === rngState(seed);
}
function keepsPrior(nCtx, nPast, nNew, maxNew) {
  return nCtx > nPast + nNew + maxNew;
}
// CONTRACT_END

if (self.name === 'em-pthread') {
  importScripts('cipher-mt.js');
} else {
let M = null, stopFlag = false, info = {}, loadedSeed = 0;
const CACHE = 'cipher-models-v1';
function post(type, data, transfer) { self.postMessage(Object.assign({ type }, data), transfer || []); }
async function loadRuntime(wantThreads) {
  const mt = wantThreads > 1 && self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  const name = mt ? 'cipher-mt.js' : 'cipher-st.js';
  importScripts(name);
  M = await CipherModule({ mainScriptUrlOrBlob: name, locateFile: (p) => p });
  info.build = mt ? 'wasm-simd+threads' : 'wasm-simd single-thread'; info.threads = mt ? wantThreads : 1;
}
async function fetchModel(url, expectedSize) {
  const cache = await caches.open(CACHE);
  let res = await cache.match(url), fromCache = !!res;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error('model HTTP ' + res.status);
    const [a, b] = res.body.tee();
    cache.put(url, new Response(b, { headers: { 'content-type': 'application/octet-stream' } })).catch(e => post('log', { msg: 'cache put failed: ' + e }));
    res = new Response(a);
  }
  const size = expectedSize;
  let ptr = M._cw_alloc(size), got = 0, lastPost = 0;
  if (!ptr) throw new Error('out of memory allocating ' + size);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (got + value.length > size) throw new Error('model larger than manifest');
    M.HEAPU8.set(value, ptr + got); got += value.length;
    const now = performance.now();
    if (now - lastPost > 100) { lastPost = now; post('progress', { got, size, fromCache }); }
  }
  post('progress', { got, size, fromCache });
  if (got !== size) throw new Error(`short read ${got}/${size}`);
  return { ptr, size, fromCache };
}
function str(s) { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; }
const yieldNow = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      const t0 = performance.now();
      await loadRuntime(m.threads);
      const t1 = performance.now();
      const { ptr, size, fromCache } = await fetchModel(m.url, m.size);
      const t2 = performance.now();
      const rc = M._cw_load(ptr, size, info.threads, m.ctx || 1024);
      if (rc) throw new Error('cw_load failed ' + rc);
      loadedSeed = m.seed ?? (Date.now() & 0xffff);
      M._cw_set_sampling(m.temp ?? 0.7, m.topP ?? 0.9, m.rep ?? 1.2, m.greedy ? 1 : 0, loadedSeed);
      if (!rngSlotMatches(M, loadedSeed)) throw new Error('cipher wasm rng slot 2224 does not match this build; generation refused');
      const t3 = performance.now();
      post('loaded', { info, fromCache, ms: { runtime: t1 - t0, fetch: t2 - t1, init: t3 - t2, total: t3 - t0 }, heapMB: M.wasmMemory.buffer.byteLength / 1048576 });
    } else if (m.type === 'tokenize') {
      const p = str(m.text), out = M._malloc(4 * 8192), n = M._cw_tokenize(p, out, 8192);
      const ids = Array.from(M.HEAP32.subarray(out >> 2, (out >> 2) + n)); M._free(p); M._free(out);
      post('tokens', { id: m.id, ids });
    } else if (m.type === 'reset') { M._cw_reset(); post('reset', { id: m.id }); }
    else if (m.type === 'system') { const p = str(m.text); M._cw_begin(p, 1, 0); M._free(p); post('system', { id: m.id }); }
    else if (m.type === 'generate') {
      stopFlag = false;
      const dec = new TextDecoder(), bp = M._malloc(4);
      const seed = m.seed ?? loadedSeed;
      const t0 = performance.now(), p = str(m.text), nPrompt = M._cw_begin(p, m.raw ? 2 : 0, m.maxNew || 200); M._free(p);
      writeRng(M, seed);
      const tPrefill = performance.now(); let n = 0, tFirst = 0, text = '', halt = 'length';
      for (;;) {
        if (stopFlag) { halt = 'user'; break; }
        const t = M._cw_next();
        if (t < 0) { halt = 'runtime'; break; }
        const len = M._cw_token_bytes(t, bp);
        if (len === 0) { halt = 'special'; break; }
        if (!n) tFirst = performance.now(); n++;
        const ptr = M.HEAPU32[bp >> 2];
        const piece = dec.decode(M.HEAPU8.slice(ptr, ptr + len), { stream: true }); text += piece;
        post('token', { id: m.id, piece, t });
        if (n % (m.yieldEvery || 1) === 0) await yieldNow();
      }
      if (!m.raw) M._cw_end();
      const tEnd = performance.now(); M._free(bp);
      post('done', { id: m.id, text, stopped: stopFlag, stats: { promptTokens: nPrompt, genTokens: n, halt, seed,
        prefillMs: tPrefill - t0, firstTokenMs: (tFirst || tEnd) - t0,
        decodeTokS: n > 1 ? (n - 1) / ((tEnd - tFirst) / 1000) : 0, heapMB: M.wasmMemory.buffer.byteLength / 1048576 } });
    } else if (m.type === 'stop') { stopFlag = true; }
  } catch (e) { post('error', { id: m.id, msg: String(e && e.stack || e) }); }
};
}

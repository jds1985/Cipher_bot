// v1.24: phone unlock challenge-response, computed ON THE PHONE. The passphrase never leaves the phone: it derives
// the same scrypt key the desktop's lock uses (salt and cost from main's one-time challenge) and sends only
// HMAC-SHA256(key, "cipher-phone-unlock-v1|" + nonce). Pure JS (the phone link is plain HTTP, so WebCrypto is not
// available); SHA-256, HMAC, PBKDF2-HMAC-SHA256, Salsa20/8 and scrypt per RFC 7914. No dependencies.
(function (root) {
  'use strict';
  var K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(msg) {
    var h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    var l = msg.length, bitLen = l * 8, padLen = ((l + 9 + 63) >> 6) << 6;
    var p = new Uint8Array(padLen); p.set(msg); p[l] = 0x80;
    var dv = new DataView(p.buffer);
    dv.setUint32(padLen - 4, bitLen >>> 0); dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
    var w = new Uint32Array(64);
    for (var off = 0; off < padLen; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var a0 = w[i - 15], a1 = w[i - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    var out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
    return out;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function hmac(key, msg) {
    if (key.length > 64) key = sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ip = new Uint8Array(64), op = new Uint8Array(64);
    for (var i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    return sha256(concat(op, sha256(concat(ip, msg))));
  }
  function pbkdf2(pass, salt, iter, len) {
    var out = new Uint8Array(len), blocks = Math.ceil(len / 32);
    for (var i = 1; i <= blocks; i++) {
      var u = hmac(pass, concat(salt, new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255])));
      var t = u.slice();
      for (var j = 1; j < iter; j++) { u = hmac(pass, u); for (var x = 0; x < 32; x++) t[x] ^= u[x]; }
      out.set(t.subarray(0, Math.min(32, len - (i - 1) * 32)), (i - 1) * 32);
    }
    return out;
  }
  function salsa8(B, x) {
    var i; for (i = 0; i < 16; i++) x[i] = B[i];
    function R(a, b) { return (a << b) | (a >>> (32 - b)); }
    for (i = 0; i < 8; i += 2) {
      x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
      x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
      x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
      x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
      x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
      x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
      x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
      x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
    }
    for (i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
  }
  function blockMix(B, Y, r, x) {
    var X = B.slice((2 * r - 1) * 16, 2 * r * 16), i, j;
    for (i = 0; i < 2 * r; i++) {
      for (j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
      salsa8(X, x);
      Y.set(X, ((i & 1) * r + (i >> 1)) * 16);
    }
    B.set(Y);
  }
  function scrypt(pass, salt, N, r, p, len) {
    if (N < 2 || (N & (N - 1)) || N > 1048576 || r < 1 || r > 16 || p < 1 || p > 4) throw new Error('bad scrypt parameters');
    var B = pbkdf2(pass, salt, 1, p * 128 * r), W = 32 * r;
    var X = new Int32Array(W), V = new Int32Array(W * N), Y = new Int32Array(W), x = new Int32Array(16);
    var dv = new DataView(B.buffer);
    for (var q = 0; q < p; q++) {
      var base = q * 128 * r, i, j;
      for (i = 0; i < W; i++) X[i] = dv.getInt32(base + i * 4, true);
      for (i = 0; i < N; i++) { V.set(X, i * W); blockMix(X, Y, r, x); }
      for (i = 0; i < N; i++) {
        var k = (X[(2 * r - 1) * 16] & (N - 1)) * W;
        for (j = 0; j < W; j++) X[j] ^= V[k + j];
        blockMix(X, Y, r, x);
      }
      for (i = 0; i < W; i++) dv.setInt32(base + i * 4, X[i], true);
    }
    return pbkdf2(pass, B, 1, len);
  }
  function utf8(s) { return new TextEncoder().encode(s.normalize('NFC')); }
  function b64(s) { var bin = atob(s), o = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
  function hex(u) { var s = ''; for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
  /** Challenge {nonce (hex), salt (base64), N, r, p, keylen} + passphrase → response hex. */
  function unlockResponse(passphrase, ch) {
    var key = scrypt(utf8(passphrase), b64(ch.salt), ch.N, ch.r, ch.p, ch.keylen);
    return hex(hmac(key, new TextEncoder().encode('cipher-phone-unlock-v1|' + ch.nonce)));
  }
  var api = { sha256: sha256, hmac: hmac, pbkdf2: pbkdf2, scrypt: scrypt, unlockResponse: unlockResponse, hex: hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CipherKdf = api;
})(typeof self !== 'undefined' ? self : this);

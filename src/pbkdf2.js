// PBKDF2 for one output block (key length ≤ hash length), used because
// some WebCrypto runtimes refuse more than 100,000 rounds and OmniFocus uses
// over a million.
//
// SHA-1 and SHA-256 use a pure-JS HMAC with precomputed pad states (two
// compressions per round). SHA-512 falls back to WebCrypto HMAC per round.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Block(h, w) {
  // h: Uint32Array(8) state (updated in place); w: Uint32Array(64), first 16 words filled.
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
}

function sha1Block(h, w) {
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = b ^ c ^ d; k = 0xca62c1d6; }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
}

const HASHES = {
  sha256: {
    words: 8, wlen: 64, block: sha256Block,
    iv: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
  },
  sha1: { words: 5, wlen: 80, block: sha1Block, iv: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0] },
};

// Plain hash of arbitrary bytes (for long HMAC keys and the first round).
function digest(H, bytes) {
  const h = new Uint32Array(H.iv);
  const w = new Uint32Array(H.wlen);
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bytes.length * 8);
  dv.setUint32(total - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    H.block(h, w);
  }
  return h;
}

const toBytes = (words) => {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((x, i) => dv.setUint32(4 * i, x));
  return out;
};

function hmacJs(H, key) {
  if (key.length > 64) key = toBytes(digest(H, key));
  const pad = (c) => {
    const p = new Uint8Array(64).fill(c);
    key.forEach((b, i) => (p[i] ^= b));
    const h = new Uint32Array(H.iv);
    const w = new Uint32Array(H.wlen);
    const dv = new DataView(p.buffer);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(4 * i);
    H.block(h, w);
    return h;
  };
  const inner = pad(0x36), outer = pad(0x5c);
  // HMAC of one digest-sized message, given as words; returns words.
  const w = new Uint32Array(H.wlen);
  const h = new Uint32Array(H.words);
  return {
    // Full HMAC of arbitrary bytes (first round only).
    once(msg) {
      const ih = new Uint32Array(inner);
      // hash(inner pad || msg) == continue from inner state over msg with total length 64 + len
      const total = Math.ceil((msg.length + 9) / 64) * 64;
      const buf = new Uint8Array(total);
      buf.set(msg);
      buf[msg.length] = 0x80;
      const dv = new DataView(buf.buffer);
      dv.setUint32(total - 4, (64 + msg.length) * 8);
      for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
        H.block(ih, w);
      }
      return this.outer(ih);
    },
    // Outer hash over an inner digest (words).
    outer(ih) {
      const n = H.words;
      h.set(outer);
      for (let i = 0; i < n; i++) w[i] = ih[i];
      w[n] = 0x80000000;
      for (let i = n + 1; i < 15; i++) w[i] = 0;
      w[15] = (64 + n * 4) * 8;
      H.block(h, w);
      return new Uint32Array(h);
    },
    // HMAC where the message is a previous digest (fixed size), all in words.
    words(msg) {
      const n = H.words;
      h.set(inner);
      for (let i = 0; i < n; i++) w[i] = msg[i];
      w[n] = 0x80000000;
      for (let i = n + 1; i < 15; i++) w[i] = 0;
      w[15] = (64 + n * 4) * 8;
      H.block(h, w);
      return this.outer(new Uint32Array(h));
    },
  };
}

export async function pbkdf2(opts) {
  return (await pbkdf2Step(opts, null, Infinity)).key;
}

// Runs up to `budget` more rounds (internal; also used by tests to check
// the round loop in pieces). state: null to start, or a previous result.
export async function pbkdf2Step({ password, salt, rounds, prf, keyLen = 16 }, state, budget) {
  const pw = new TextEncoder().encode(password);
  const H = HASHES[prf];
  if (!H) return pbkdf2StepWebCrypto({ pw, salt, rounds, prf, keyLen }, state, budget);
  const mac = hmacJs(H, pw);
  let done, u, t;
  if (!state) {
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt);
    msg[salt.length + 3] = 1; // INT(1), big-endian block index
    u = mac.once(msg);
    t = new Uint32Array(u);
    done = 1;
  } else {
    ({ done } = state);
    u = Uint32Array.from(state.u);
    t = Uint32Array.from(state.t);
  }
  const end = Math.min(rounds, (state ? done : 0) + budget);
  for (; done < end; done++) {
    u = mac.words(u);
    for (let i = 0; i < u.length; i++) t[i] ^= u[i];
  }
  const out = { done, rounds, u: Array.from(u), t: Array.from(t) };
  if (done === rounds) out.key = toBytes(t).slice(0, keyLen);
  return out;
}

const WEB = { sha512: "SHA-512", sha256: "SHA-256", sha1: "SHA-1" };
async function pbkdf2StepWebCrypto({ pw, salt, rounds, prf, keyLen }, state, budget) {
  const subtle = globalThis.crypto.subtle;
  if (!WEB[prf]) throw new Error(`Unsupported PBKDF2 prf ${prf}`);
  const k = await subtle.importKey("raw", pw, { name: "HMAC", hash: WEB[prf] }, false, ["sign"]);
  let done, u, t;
  if (!state) {
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt);
    msg[salt.length + 3] = 1;
    u = new Uint8Array(await subtle.sign("HMAC", k, msg));
    t = new Uint8Array(u);
    done = 1;
  } else {
    ({ done } = state);
    u = Uint8Array.from(state.u);
    t = Uint8Array.from(state.t);
  }
  const end = Math.min(rounds, (state ? done : 0) + budget);
  for (; done < end; done++) {
    u = new Uint8Array(await subtle.sign("HMAC", k, u));
    for (let i = 0; i < u.length; i++) t[i] ^= u[i];
  }
  const out = { done, rounds, u: Array.from(u), t: Array.from(t), bytes: true };
  if (done === rounds) out.key = t.slice(0, keyLen);
  return out;
}

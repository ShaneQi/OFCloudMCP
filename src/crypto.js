// Decrypts OmniFocus databases encrypted with OmniFileStore encryption.
// Follows Omni's published spec and reference decryptor:
// github.com/omnigroup/OmniGroup Frameworks/OmniFileStore/EncryptionFormat.md
// and DecryptionExample.py.
//
//   "encrypted" (plist): { method: "password", algorithm: "PBKDF2; aes128-wrap",
//                          rounds, salt, prf, key }  (or a 1-element array of it)
//   PBKDF2(passphrase, salt, rounds, prf) -> 16-byte key -> AES-KW unwrap(key)
//   -> key slots: [type u8][len u8, in 4-byte units][id u16][data]
//   Each file: "OmniFileEncryption\0\0", u16 info length, info (u16 key id, …),
//   zero padding to 16, segments [IV 12][MAC 20][≤64 KiB AES-128-CTR data],
//   then a 32-byte HMAC-SHA256 over 0x01 || segment MACs.
import { UserError } from "./errors.js";
import { pbkdf2 } from "./pbkdf2.js";

const subtle = globalThis.crypto.subtle;
const MAGIC = new TextEncoder().encode("OmniFileEncryption\0\0");
const SEG_IV = 12, SEG_MAC = 20, SEG_PAGE = 65536, FILE_MAC = 32;
const SLOT = { ACTIVE_WRAP: 1, RETIRED_WRAP: 2, ACTIVE_CTR: 3, RETIRED_CTR: 4, PLAIN: 5, RETIRED_PLAIN: 6 };
const PRF = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" };

export function isEncryptedFile(bytes) {
  return bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

// ---------- plist (XML or binary) ----------
export function parsePlist(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  return head.startsWith("bplist") ? parseBinaryPlist(bytes) : parseXmlPlist(new TextDecoder().decode(bytes));
}

function parseXmlPlist(xml) {
  const re = /<(\/?)(dict|array|key|string|data|integer|real|true|false|date)\s*(\/?)>/g;
  const decode = (t) =>
    t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const stack = [];
  let root, key = null, m;
  const put = (v) => {
    const top = stack.at(-1);
    if (!top) root = v;
    else if (Array.isArray(top)) top.push(v);
    else top[key] = v;
  };
  while ((m = re.exec(xml))) {
    const [, close, tag, selfClose] = m;
    if (close) {
      if (tag === "dict" || tag === "array") put(stack.pop());
      continue;
    }
    if (tag === "dict" || tag === "array") {
      if (selfClose) put(tag === "dict" ? {} : []);
      else stack.push(tag === "dict" ? {} : []);
      continue;
    }
    let text = "";
    if (!selfClose) {
      const end = xml.indexOf(`</${tag}>`, re.lastIndex);
      text = xml.slice(re.lastIndex, end);
      re.lastIndex = end + tag.length + 3;
    }
    if (tag === "key") key = decode(text);
    else if (tag === "string" || tag === "date") put(decode(text));
    else if (tag === "integer" || tag === "real") put(Number(text));
    else if (tag === "true" || tag === "false") put(tag === "true");
    else if (tag === "data") put(Uint8Array.from(atob(text.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
  }
  return root;
}

function parseBinaryPlist(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b.length - 32;
  const offSize = b[t + 6], refSize = b[t + 7];
  const num = (pos, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + b[pos + i];
    return v;
  };
  const numObjects = num(t + 8, 8), top = num(t + 16, 8), table = num(t + 24, 8);
  const offsets = Array.from({ length: numObjects }, (_, i) => num(table + i * offSize, offSize));
  const read = (idx) => {
    let pos = offsets[idx];
    const marker = b[pos], hi = marker >> 4, lo = marker & 15;
    const len = () => {
      if (lo !== 15) return lo;
      const sz = 1 << (b[pos + 1] & 15);
      const n = num(pos + 2, sz);
      pos += 1 + sz;
      return n;
    };
    switch (hi) {
      case 0: return lo === 9;
      case 1: return num(pos + 1, 1 << lo);
      case 2: return lo === 3 ? dv.getFloat64(pos + 1) : dv.getFloat32(pos + 1);
      case 4: { const n = len(); return b.slice(pos + 1, pos + 1 + n); }
      case 5: { const n = len(); return new TextDecoder("latin1").decode(b.subarray(pos + 1, pos + 1 + n)); }
      case 6: {
        const n = len();
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(pos + 1 + 2 * i));
        return s;
      }
      case 10: { const n = len(); return Array.from({ length: n }, (_, i) => read(num(pos + 1 + i * refSize, refSize))); }
      case 13: {
        const n = len();
        const o = {};
        for (let i = 0; i < n; i++) o[read(num(pos + 1 + i * refSize, refSize))] = read(num(pos + 1 + (n + i) * refSize, refSize));
        return o;
      }
      default: throw new Error(`Unsupported binary plist object type ${hi}`);
    }
  };
  return read(top);
}

// ---------- document key ----------
export function parseMetadata(bytes) {
  let meta = parsePlist(bytes);
  if (Array.isArray(meta) && meta.length === 1) meta = meta[0];
  if (!meta || typeof meta !== "object") throw new UserError("The OmniFocus \"encrypted\" file has an unexpected format.");
  return meta;
}

// AES key unwrap (RFC 3394) of arbitrary key material, via WebCrypto.
async function aesUnwrap(kek, wrapped) {
  const k = await subtle.importKey("raw", kek, "AES-KW", false, ["unwrapKey"]);
  const key = await subtle.unwrapKey("raw", wrapped, k, "AES-KW", { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
  return new Uint8Array(await subtle.exportKey("raw", key));
}

function parseSlots(bytes) {
  const slots = [];
  for (let i = 0; i + 4 <= bytes.length; ) {
    const type = bytes[i];
    if (type === 0) break;
    const len = 4 * bytes[i + 1];
    const id = (bytes[i + 2] << 8) | bytes[i + 3];
    slots.push({ type, id, data: bytes.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return slots;
}

// Returns the unwrapped key-slot bytes (cacheable), given the "encrypted" file.
export async function unlockDocumentKey(metaBytes, passphrase) {
  const meta = parseMetadata(metaBytes);
  if (meta.method === "static") return meta.key;
  if (meta.method !== "password" || meta.algorithm !== "PBKDF2; aes128-wrap") {
    throw new UserError(`The OmniFocus database uses an unsupported encryption method (${meta.method}; ${meta.algorithm}).`);
  }
  const prf = meta.prf ?? "sha1";
  if (!PRF[prf]) throw new UserError(`The OmniFocus database uses an unsupported key derivation (prf ${prf}).`);
  const kek = await deriveKey(passphrase, meta.salt, meta.rounds, prf);
  try {
    return await aesUnwrap(kek, meta.key);
  } catch {
    throw new UserError(
      "Could not unlock the encrypted OmniFocus database: the passphrase is wrong. " +
        "Set OF_PASSPHRASE to the database encryption passphrase (by default WEBDAV_PASS is used)."
    );
  }
}

// WebCrypto PBKDF2 where allowed; some runtimes refuse more than 100,000 rounds
// (OmniFocus uses over a million), so fall back to the pure-JS version.
async function deriveKey(passphrase, salt, rounds, prf) {
  try {
    const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: PRF[prf], salt, iterations: rounds }, base, 128));
  } catch {
    return pbkdf2({ password: passphrase, salt, rounds, prf, keyLen: 16 });
  }
}

export function keyInfo(slotBytes) {
  return parseSlots(slotBytes).map((s) => ({ type: s.type, id: s.id, bytes: s.data.length }));
}

// ---------- file decryption ----------
const hmacKey = (raw) => subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function decryptFile(name, bytes, slotBytes) {
  const slots = parseSlots(slotBytes);
  if (!isEncryptedFile(bytes)) {
    const allowed = slots.some(
      (s) => (s.type === SLOT.PLAIN || s.type === SLOT.RETIRED_PLAIN) &&
        name.endsWith(new TextDecoder().decode(s.data).replace(/\0+$/, ""))
    );
    if (allowed) return bytes;
    throw new Error(`${name} is not encrypted, but the database is`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = MAGIC.length;
  const infoLen = dv.getUint16(pos);
  pos += 2;
  const info = bytes.subarray(pos, pos + infoLen);
  pos += infoLen;
  pos += (16 - (pos % 16)) % 16;
  const keyId = (info[0] << 8) | info[1];
  const slot = slots.find((s) => s.id === keyId);
  if (!slot) throw new Error(`${name}: key ${keyId} is not in the document key`);

  let material;
  if (slot.type === SLOT.ACTIVE_CTR || slot.type === SLOT.RETIRED_CTR) material = slot.data;
  else if (slot.type === SLOT.ACTIVE_WRAP || slot.type === SLOT.RETIRED_WRAP) material = await aesUnwrap(slot.data, info.subarray(2));
  else throw new Error(`${name}: unsupported key type ${slot.type}`);
  const aes = await subtle.importKey("raw", material.subarray(0, 16), "AES-CTR", false, ["decrypt"]);
  const mac = await hmacKey(material.subarray(16, 32));

  const end = bytes.length - FILE_MAC;
  const out = new Uint8Array(Math.max(0, end - pos));
  const fileMacInput = [new Uint8Array([1])];
  let outPos = 0;
  for (let idx = 0, p = pos; ; idx++) {
    if (p + SEG_IV + SEG_MAC > end) throw new Error(`${name}: truncated`);
    const len = Math.min(SEG_PAGE, end - (p + SEG_IV + SEG_MAC));
    const iv = bytes.subarray(p, p + SEG_IV);
    const segMac = bytes.subarray(p + SEG_IV, p + SEG_IV + SEG_MAC);
    const data = bytes.subarray(p + SEG_IV + SEG_MAC, p + SEG_IV + SEG_MAC + len);
    const macIn = new Uint8Array(SEG_IV + 4 + len);
    macIn.set(iv);
    new DataView(macIn.buffer).setUint32(SEG_IV, idx);
    macIn.set(data, SEG_IV + 4);
    const calc = new Uint8Array(await subtle.sign("HMAC", mac, macIn)).subarray(0, SEG_MAC);
    if (!eq(calc, segMac)) throw new Error(`${name}: segment ${idx} failed its integrity check`);
    fileMacInput.push(segMac);
    const counter = new Uint8Array(16);
    counter.set(iv);
    const plain = new Uint8Array(await subtle.decrypt({ name: "AES-CTR", counter, length: 32 }, aes, data));
    out.set(plain, outPos);
    outPos += plain.length;
    p += SEG_IV + SEG_MAC + len;
    if (len < SEG_PAGE || p >= end) break;
  }
  const all = new Uint8Array(fileMacInput.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of fileMacInput) {
    all.set(a, o);
    o += a.length;
  }
  const fileMac = new Uint8Array(await subtle.sign("HMAC", mac, all));
  if (!eq(fileMac, bytes.subarray(end))) throw new Error(`${name}: file integrity check failed`);
  return out.subarray(0, outPos);
}

// Encrypts a file with the database's active AES-CTR+HMAC key, in the same
// format decryptFile reads (and OmniFocus writes).
export async function encryptFile(bytes, slotBytes) {
  const slot = parseSlots(slotBytes).find((s) => s.type === SLOT.ACTIVE_CTR);
  if (!slot || slot.data.length !== 32) throw new Error("The database has no active AES-CTR+HMAC key to write with.");
  const aes = await subtle.importKey("raw", slot.data.subarray(0, 16), "AES-CTR", false, ["encrypt"]);
  const mac = await hmacKey(slot.data.subarray(16, 32));

  const header = new Uint8Array(MAGIC.length + 4);
  header.set(MAGIC);
  const hv = new DataView(header.buffer);
  hv.setUint16(MAGIC.length, 2); // key info length: just the key id
  hv.setUint16(MAGIC.length + 2, slot.id);
  const pad = (16 - (header.length % 16)) % 16;

  const parts = [header, new Uint8Array(pad)];
  const fileMacInput = [new Uint8Array([1])];
  const segments = Math.max(1, Math.ceil(bytes.length / SEG_PAGE));
  for (let idx = 0; idx < segments; idx++) {
    const plain = bytes.subarray(idx * SEG_PAGE, (idx + 1) * SEG_PAGE);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(SEG_IV));
    const counter = new Uint8Array(16);
    counter.set(iv);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter, length: 32 }, aes, plain));
    const macIn = new Uint8Array(SEG_IV + 4 + ct.length);
    macIn.set(iv);
    new DataView(macIn.buffer).setUint32(SEG_IV, idx);
    macIn.set(ct, SEG_IV + 4);
    const segMac = new Uint8Array(await subtle.sign("HMAC", mac, macIn)).subarray(0, SEG_MAC);
    fileMacInput.push(segMac);
    parts.push(iv, segMac, ct);
  }
  const macAll = concat(fileMacInput);
  parts.push(new Uint8Array(await subtle.sign("HMAC", mac, macAll)));
  return concat(parts);
}

function concat(arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

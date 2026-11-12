// Loads the OmniFocus database from WebDAV, applying only new transaction
// files when a cached copy (in memory or KV) is still valid.
import { XMLParser } from "fast-xml-parser";
import { UserError } from "./errors.js";
import { newModel, applyTransaction, readContentsXml } from "./ofocus.js";
import { davFetch, resetDigest } from "./dav.js";
import { isEncryptedFile, unlockDocumentKey, decryptFile } from "./crypto.js";

const CACHE_KEY = "model-v1";
const TRANSACTION = /^\d{14}=.+\.zip$/;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/></d:prop></d:propfind>';

const davParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "response" || name === "propstat",
});

let memo = null; // { files: string[], model, builtAt }
let docKeyMemo = null; // { id, slots }

export function resetCache() {
  memo = null;
  docKeyMemo = null;
  resetDigest();
}

export function config(env) {
  for (const key of ["OFOCUS_URL", "WEBDAV_USER", "WEBDAV_PASS"]) {
    if (!env[key]) throw new UserError(`The server is missing its ${key} secret.`);
  }
  const base = env.OFOCUS_URL.endsWith("/") ? env.OFOCUS_URL : env.OFOCUS_URL + "/";
  return { base, user: env.WEBDAV_USER, pass: env.WEBDAV_PASS };
}

export async function listTransactions(cfg) {
  const res = await davFetch(cfg, cfg.base, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: PROPFIND_BODY,
  });
  if (res.status === 401 || res.status === 403) {
    const asks = res.headers.get("WWW-Authenticate");
    const scheme = asks ? asks.trim().split(/\s+/)[0] : null;
    let hint = ` Tried ${res.davAuth ?? "Basic"}.`;
    if (cfg.base !== res.davUrl) hint += ` (OFOCUS_URL redirected to ${res.davUrl}.)`;
    if (scheme && !["basic", "digest"].includes(scheme.toLowerCase())) {
      hint += ` The server asks for ${scheme} authentication, which this connector does not support.`;
    } else {
      hint += " Check WEBDAV_USER, WEBDAV_PASS and OFOCUS_URL.";
    }
    throw new UserError(`The WebDAV server rejected the username or password (HTTP ${res.status}).${hint}`);
  }
  if (res.status === 404) throw new UserError("No OmniFocus.ofocus folder was found at OFOCUS_URL (HTTP 404).");
  if (!res.ok) throw new UserError(`Listing the WebDAV folder failed (HTTP ${res.status}).`);

  const doc = davParser.parse(await res.text());
  const files = [];
  const others = [];
  for (const r of doc?.multistatus?.response ?? []) {
    const href = typeof r.href === "string" ? r.href : r.href?.["#text"];
    if (!href) continue;
    const url = new URL(href, res.davUrl ?? cfg.base);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    let name;
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
    if (TRANSACTION.test(name)) files.push({ name, url: url.toString() });
    else if (url.toString() !== (res.davUrl ?? cfg.base)) others.push(name + (url.pathname.endsWith("/") ? "/" : ""));
  }
  files.others = others;
  files.listedUrl = res.davUrl ?? cfg.base;
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}

// Downloads one file and returns its bytes, decrypted if the database is.
export async function fetchFile(cfg, url, name, docKey) {
  const res = await davFetch(cfg, url);
  if (!res.ok) throw new UserError(`Downloading ${name} failed (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return docKey && isEncryptedFile(bytes) ? decryptFile(name, bytes, docKey) : bytes;
}

// Everything needed to read or add raw files: WebDAV config, the current
// transaction listing, and the unlocked key slots (null if not encrypted).
export async function syncContext(env) {
  const cfg = config(env);
  const files = await listTransactions(cfg);
  const encrypted = files.others.includes("encrypted");
  const docKey = encrypted ? await documentKey(cfg, env, files.listedUrl) : null;
  return { cfg, files, docKey, encrypted };
}

async function download(cfg, file, docKey) {
  const res = await davFetch(cfg, file.url);
  if (!res.ok) throw new UserError(`Downloading ${file.name} failed (HTTP ${res.status}).`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (docKey) bytes = await decryptFile(file.name, bytes, docKey);
  else if (isEncryptedFile(bytes)) throw new UserError(`${file.name} is encrypted, but the folder has no "encrypted" key file.`);
  return readContentsXml(bytes);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Unlocks the database's file keys. PBKDF2 is slow on purpose, so the result
// is kept in memory and (if bound) in KV, keyed by a hash of the "encrypted"
// file; a password change rewrites that file and so forces a fresh unlock.
async function documentKey(cfg, env, listedUrl) {
  const dir = listedUrl.endsWith("/") ? listedUrl : listedUrl + "/";
  const res = await davFetch(cfg, new URL("encrypted", dir).toString());
  if (!res.ok) throw new UserError(`Downloading the "encrypted" key file failed (HTTP ${res.status}).`);
  const meta = new Uint8Array(await res.arrayBuffer());
  const id = hex(await crypto.subtle.digest("SHA-256", meta));
  if (docKeyMemo?.id === id) return docKeyMemo.slots;
  const kvKey = `dockey-v1:${id}`;
  let slots = null;
  if (env.OF_CACHE) {
    const saved = await env.OF_CACHE.get(kvKey);
    if (saved) slots = unb64(saved);
  }
  if (!slots) {
    slots = await unlockDocumentKey(meta, env.OF_PASSPHRASE || env.WEBDAV_PASS);
    if (env.OF_CACHE) await env.OF_CACHE.put(kvKey, b64(slots));
  }
  docKeyMemo = { id, slots };
  return slots;
}

// Runs fn over items with at most `limit` running at once (Workers allows
// six simultaneous outgoing connections per request).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const isPrefix = (a, b) => a.length <= b.length && a.every((n, i) => b[i] === n);

// Loads run one at a time, so a slow first load is not repeated by requests
// arriving meanwhile; they then reuse its result.
let inflight = null;
export async function loadModel(env, ctx) {
  while (inflight) await inflight.catch(() => {});
  inflight = loadOnce(env, ctx);
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function loadOnce(env, ctx) {
  const cfg = config(env);
  const files = await listTransactions(cfg);
  if (!files.length) {
    const seen = files.others;
    let hint = seen.length
      ? ` It contains ${seen.length} other entr${seen.length === 1 ? "y" : "ies"}: ${seen.slice(0, 15).join(", ")}${seen.length > 15 ? ", …" : ""}.`
      : " It is empty.";
    if (seen.some((n) => /\.ofocus\/?$/i.test(n))) hint += " OFOCUS_URL should end with that .ofocus folder.";
    throw new UserError(`No transaction files (like 20261101000000=abc+def.zip) were found at ${files.listedUrl}.${hint}`);
  }
  const names = files.map((f) => f.name);
  const encrypted = files.others.includes("encrypted");

  let base = memo;
  let source = "memory cache";
  if (!base && env.OF_CACHE) {
    base = await env.OF_CACHE.get(CACHE_KEY, "json");
    source = "KV cache";
  }

  let pending = files;
  let model = newModel();
  if (base && isPrefix(base.files, names)) {
    pending = files.slice(base.files.length);
    model = base.model;
  } else {
    base = null;
  }

  if (pending.length) {
    const docKey = encrypted ? await documentKey(cfg, env, files.listedUrl) : null;
    const xmls = await mapLimit(pending, 6, (f) => download(cfg, f, docKey));
    try {
      for (const xml of xmls) applyTransaction(model, xml);
    } catch (e) {
      memo = null; // the model may be half-updated; start over next time
      throw e;
    }
    source = base ? `${source} + ${pending.length} new file(s)` : `full load of ${pending.length} file(s)`;
    memo = { files: names, model, builtAt: new Date().toISOString() };
    if (env.OF_CACHE) {
      const write = env.OF_CACHE.put(CACHE_KEY, JSON.stringify(memo));
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
  } else {
    memo = base;
  }

  return { model: memo.model, files: names, source, builtAt: memo.builtAt, encrypted };
}

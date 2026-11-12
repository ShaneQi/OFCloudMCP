// Loads the OmniFocus database from WebDAV, applying only new transaction
// files when a cached copy (in memory or KV) is still valid.
import { XMLParser } from "fast-xml-parser";
import { UserError } from "./errors.js";
import { newModel, applyTransaction, readContentsXml } from "./ofocus.js";
import { davFetch, resetDigest } from "./dav.js";
import { isEncryptedFile, unlockStep, decryptFile } from "./crypto.js";

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

// Unlocks the database's file keys. PBKDF2 is slow on purpose (OmniFocus
// uses over a million rounds), so it runs at most PBKDF2_ROUNDS_PER_RUN
// rounds per call and saves its progress; the result is kept in memory and
// KV, keyed by a hash of the "encrypted" file, so a password change (which
// rewrites that file) forces a fresh unlock. Returns the slots, or
// { pending: message } while unlocking is still in progress.
async function documentKey(cfg, env, listedUrl) {
  const dir = listedUrl.endsWith("/") ? listedUrl : listedUrl + "/";
  const res = await davFetch(cfg, new URL("encrypted", dir).toString());
  if (!res.ok) throw new UserError(`Downloading the "encrypted" key file failed (HTTP ${res.status}).`);
  const meta = new Uint8Array(await res.arrayBuffer());
  const id = hex(await crypto.subtle.digest("SHA-256", meta));
  if (docKeyMemo?.id === id && docKeyMemo.slots) return { slots: docKeyMemo.slots };
  const kvKey = `dockey-v1:${id}`;
  const progressKey = `unlock-v1:${id}`;
  if (env.OF_CACHE) {
    const saved = await env.OF_CACHE.get(kvKey);
    if (saved) {
      docKeyMemo = { id, slots: unb64(saved) };
      return { slots: docKeyMemo.slots };
    }
  }
  let state = docKeyMemo?.id === id ? docKeyMemo.state : null;
  if (!state && env.OF_CACHE) state = await env.OF_CACHE.get(progressKey, "json");

  const budget = Number(env.PBKDF2_ROUNDS_PER_RUN ?? 10000);
  let r;
  try {
    r = await unlockStep(meta, env.OF_PASSPHRASE || env.WEBDAV_PASS, state, budget);
  } catch (e) {
    docKeyMemo = null;
    if (env.OF_CACHE) await env.OF_CACHE.delete(progressKey);
    throw e;
  }
  if (r.slots) {
    docKeyMemo = { id, slots: r.slots };
    if (env.OF_CACHE) {
      await env.OF_CACHE.put(kvKey, b64(r.slots));
      await env.OF_CACHE.delete(progressKey);
    }
    return { slots: r.slots };
  }
  docKeyMemo = { id, state: r.state };
  if (env.OF_CACHE) await env.OF_CACHE.put(progressKey, JSON.stringify(r.state));
  const runs = Math.ceil((r.rounds - r.done) / budget);
  return {
    pending:
      `Unlocking your encrypted OmniFocus database: ${Math.floor((100 * r.done) / r.rounds)}% ` +
      `(${r.done.toLocaleString("en-US")} of ${r.rounds.toLocaleString("en-US")} key-derivation rounds, ` +
      `${budget.toLocaleString("en-US")} per run). ` +
      (env.OF_CACHE
        ? `This continues in the background every minute; about ${runs} more run(s). ` +
          "On the Workers Paid plan, raise PBKDF2_ROUNDS_PER_RUN to 2000000 to finish in one request."
        : "Bind the OF_CACHE KV namespace so progress is kept between requests."),
  };
}

const isPrefix = (a, b) => a.length <= b.length && a.every((n, i) => b[i] === n);

const STATUS_KEY = "status-v1";
const MINUTE = 60_000;

async function readCache(env) {
  if (memo) return { base: memo, source: "memory cache" };
  if (env.OF_CACHE) {
    const base = await env.OF_CACHE.get(CACHE_KEY, "json");
    if (base) return { base, source: "KV cache" };
  }
  return { base: null, source: null };
}

async function writeCache(env, ctx, wait) {
  if (!env.OF_CACHE) return;
  const status = { files: memo.files.length, complete: memo.complete, checkedAt: memo.checkedAt };
  const writes = Promise.all([
    env.OF_CACHE.put(CACHE_KEY, JSON.stringify(memo)),
    env.OF_CACHE.put(STATUS_KEY, JSON.stringify(status)),
  ]);
  if (wait || !ctx?.waitUntil) await writes;
  else ctx.waitUntil(writes);
}

// Loads the model, downloading at most MAX_FETCH new transaction files per
// call. A large database is therefore read over several calls; progress is
// kept in memory and KV, and the scheduled handler keeps it moving.
// With background=true (cron), it never throws for an unfinished load.
export async function loadModel(env, ctx, { background = false } = {}) {
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

  let { base, source } = await readCache(env);
  let model = newModel();
  let done = 0;
  if (base && isPrefix(base.files, names)) {
    model = base.model;
    done = base.files.length;
  } else {
    base = null;
  }

  const max = Number(env.MAX_FETCH ?? 40);
  const batch = files.slice(done, done + max);
  const now = new Date().toISOString();
  if (batch.length) {
    let docKey = null;
    if (encrypted) {
      const k = await documentKey(cfg, env, files.listedUrl);
      if (k.pending) {
        if (background) return { partial: true, message: k.pending };
        throw new UserError(k.pending);
      }
      docKey = k.slots;
    }
    const xmls = await Promise.all(batch.map((f) => download(cfg, f, docKey)));
    try {
      for (const xml of xmls) applyTransaction(model, xml);
    } catch (e) {
      memo = null; // the model may be half-updated; start over next time
      throw e;
    }
    done += batch.length;
    source = base ? `${source} + ${batch.length} new file(s)` : `fresh load of ${batch.length} file(s)`;
    memo = {
      files: names.slice(0, done), model, complete: done === names.length,
      builtAt: done === names.length ? now : base?.builtAt ?? now, checkedAt: now,
    };
    await writeCache(env, ctx, background || !memo.complete);
  } else {
    memo = { ...base, complete: true, checkedAt: now };
    if (background && env.OF_CACHE) {
      await env.OF_CACHE.put(STATUS_KEY, JSON.stringify({ files: done, complete: true, checkedAt: now }));
    }
  }

  if (!memo.complete) {
    const left = names.length - done;
    const msg =
      `Still loading your OmniFocus database: ${done} of ${names.length} transaction files read ` +
      `(${max} per request). ` +
      (env.OF_CACHE
        ? `It keeps loading in the background every minute; it should be ready in about ${Math.ceil(left / max)} minute(s).`
        : "Bind the OF_CACHE KV namespace so progress is kept between requests.");
    if (background) return { partial: true, message: msg };
    throw new UserError(msg);
  }
  return { model: memo.model, files: names, source, builtAt: memo.builtAt, encrypted };
}

// Cron: finish a large first load, then keep the cache fresh so tool calls
// rarely have to download anything. Skips WebDAV while the cache is complete
// and was checked recently.
export async function backgroundSync(env, ctx) {
  if (!env.OF_CACHE) return "no KV namespace bound; nothing to do";
  const status = memo
    ? { complete: memo.complete, checkedAt: memo.checkedAt }
    : await env.OF_CACHE.get(STATUS_KEY, "json");
  const freshFor = Number(env.REFRESH_MINUTES ?? 15) * MINUTE;
  if (status?.complete && Date.now() - Date.parse(status.checkedAt) < freshFor) return "cache is fresh";
  const r = await loadModel(env, ctx, { background: true });
  return r.partial ? r.message : `up to date (${r.files.length} files)`;
}

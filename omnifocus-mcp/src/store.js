// Loads the OmniFocus database from WebDAV, applying only new transaction
// files when a cached copy (in memory or KV) is still valid.
import { XMLParser } from "fast-xml-parser";
import { UserError } from "./errors.js";
import { newModel, applyTransaction, readContentsXml } from "./ofocus.js";
import { davFetch, resetDigest } from "./dav.js";

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

export function resetCache() {
  memo = null;
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
    let hint = "";
    if (scheme && !["basic", "digest"].includes(scheme.toLowerCase())) {
      hint = ` The server asks for ${scheme} authentication, which this connector does not support.`;
    } else if (scheme) {
      hint = ` The server uses ${scheme} authentication, so check WEBDAV_USER, WEBDAV_PASS and OFOCUS_URL.`;
    }
    throw new UserError(`The WebDAV server rejected the username or password (HTTP ${res.status}).${hint}`);
  }
  if (res.status === 404) throw new UserError("No OmniFocus.ofocus folder was found at OFOCUS_URL (HTTP 404).");
  if (!res.ok) throw new UserError(`Listing the WebDAV folder failed (HTTP ${res.status}).`);

  const doc = davParser.parse(await res.text());
  const files = [];
  for (const r of doc?.multistatus?.response ?? []) {
    const href = typeof r.href === "string" ? r.href : r.href?.["#text"];
    if (!href) continue;
    const url = new URL(href, cfg.base);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    let name;
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
    if (TRANSACTION.test(name)) files.push({ name, url: url.toString() });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}

async function download(cfg, file) {
  const res = await davFetch(cfg, file.url);
  if (!res.ok) throw new UserError(`Downloading ${file.name} failed (HTTP ${res.status}).`);
  return readContentsXml(new Uint8Array(await res.arrayBuffer()));
}

const isPrefix = (a, b) => a.length <= b.length && a.every((n, i) => b[i] === n);

export async function loadModel(env, ctx) {
  const cfg = config(env);
  const files = await listTransactions(cfg);
  if (!files.length) throw new UserError("The OmniFocus.ofocus folder has no transaction files.");
  const names = files.map((f) => f.name);

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

  const max = Number(env.MAX_FETCH ?? 45);
  if (pending.length > max) {
    throw new UserError(
      `${pending.length} transaction files need downloading, more than MAX_FETCH (${max}). ` +
        "Raise MAX_FETCH (a paid Workers plan allows more outgoing requests), " +
        "or let OmniFocus compact its database and try again."
    );
  }

  if (pending.length) {
    const xmls = await Promise.all(pending.map((f) => download(cfg, f)));
    for (const xml of xmls) applyTransaction(model, xml);
    source = base ? `${source} + ${pending.length} new file(s)` : `full rebuild from ${pending.length} file(s)`;
    memo = { files: names, model, builtAt: new Date().toISOString() };
    if (env.OF_CACHE) {
      const write = env.OF_CACHE.put(CACHE_KEY, JSON.stringify(memo));
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
  } else {
    memo = base;
  }

  return { model: memo.model, files: names, source, builtAt: memo.builtAt };
}

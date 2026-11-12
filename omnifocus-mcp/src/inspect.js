// Read-only diagnostics of the sync folder, to check the file formats against
// a real database before anything writes to it.
import { syncContext, fetchFile } from "./store.js";
import { analyzeChain, analyzeChainOwnFirst } from "./chain.js";
import { parsePlist, keyInfo } from "./crypto.js";
import { readContentsXml } from "./ofocus.js";
import { davFetch } from "./dav.js";
import { isEncryptedFile } from "./crypto.js";

const SLOT_NAMES = {
  1: "ActiveAESWRAP", 2: "RetiredAESWRAP", 3: "ActiveAES_CTR_HMAC",
  4: "RetiredAES_CTR_HMAC", 5: "PlaintextMask", 6: "RetiredPlaintextMask",
};

function show(v, depth = 0) {
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return `[${v.map((x) => show(x, depth + 1)).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${show(x, depth + 1)}`).join(", ")} }`;
  }
  const s = String(v);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

// Elements of the newest transaction whose XML matches `pattern` (a regex),
// e.g. "<due>2" or "task-to-tag". Returns up to `limit` whole elements.
async function findElements(env, pattern, limit, xml_chars) {
  const { cfg, files, docKey } = await syncContext(env);
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return `Invalid pattern: ${e.message}`;
  }
  const out = [];
  for (const f of [...files].reverse()) {
    const xml = readContentsXml(await fetchFile(cfg, f.url, f.name, docKey));
    const el = /<(task|context|folder|task-to-tag|perspective|setting|attachment|alarm)\s[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g;
    let m;
    while ((m = el.exec(xml)) && out.length < limit) {
      if (re.test(m[0])) out.push(`(${f.name})\n${m[0].replace(/<preview-image>[^<]*<\/preview-image>/g, "<preview-image>…</preview-image>")}`);
    }
    if (out.length >= limit) break;
  }
  const text = out.length ? out.join("\n\n") : `No element matches /${pattern}/.`;
  return text.length > xml_chars ? text.slice(0, xml_chars) + "\n…(truncated)" : text;
}

export async function inspectSync(env, { xml_chars = 6000, find = null, limit = 3 } = {}) {
  if (find) return findElements(env, find, limit, xml_chars);
  const { cfg, files, docKey, encrypted } = await syncContext(env);
  const names = files.map((f) => f.name);
  const out = [];
  out.push(`Folder: ${files.listedUrl}`);
  out.push(`Transaction files: ${names.length}`);
  for (const n of names.slice(-15)) out.push(`  ${n}`);
  if (names.length > 15) out.push(`  (… ${names.length - 15} older)`);

  const a = analyzeChain(names);
  const b = analyzeChainOwnFirst(names);
  out.push("", "Chain, reading names as parents…+own id:");
  out.push(`  consistent: ${a.consistent}; heads: ${a.heads.join(", ") || "none"}`);
  for (const p of a.problems.slice(0, 5)) out.push(`  problem: ${p}`);
  out.push("Chain, reading names as own id+parents…:");
  out.push(`  consistent: ${b.consistent}; heads: ${b.heads.join(", ") || "none"}`);
  for (const p of b.problems.slice(0, 5)) out.push(`  problem: ${p}`);

  out.push("", `Other entries: ${files.others.join(", ")}`);
  if (encrypted) {
    out.push(`Key slots: ${keyInfo(docKey).map((s) => `${SLOT_NAMES[s.type] ?? s.type}#${s.id} (${s.bytes} bytes)`).join(", ")}`);
  }

  if (files.others.includes("data/")) {
    try {
      const dataUrl = new URL("data/", files.listedUrl).toString();
      const res = await davFetch(cfg, dataUrl, {
        method: "PROPFIND",
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
      });
      const xml = await res.text();
      const entries = [...xml.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => decodeURIComponent(m[1].split("/").filter(Boolean).pop()));
      const items = entries.filter((n) => n !== "data");
      out.push("", `data/ folder: ${items.length} entries (HTTP ${res.status})`);
      for (const n of items.slice(0, 8)) out.push(`  ${n}`);
      const first = items.find((n) => /^data-[0-9a-f]{64}\.zip$/.test(n));
      if (first) {
        const r = await davFetch(cfg, new URL(encodeURIComponent(first), dataUrl).toString());
        const raw = new Uint8Array(await r.arrayBuffer());
        const enc = isEncryptedFile(raw);
        let plain = raw;
        if (enc && docKey) plain = await (await import("./crypto.js")).decryptFile(first, raw, docKey);
        const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", plain))].map((b) => b.toString(16).padStart(2, "0")).join("");
        out.push(`  first file: ${raw.length} bytes, ${enc ? "encrypted" : "not encrypted"}, plaintext ${plain.length} bytes, sha256 ${sha}`);
        out.push(`  plaintext starts: ${[...plain.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
        try {
          const { unzipSync } = await import("fflate");
          const entries = unzipSync(plain);
          for (const [n, b] of Object.entries(entries)) {
            const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
            out.push(`  zip entry ${JSON.stringify(n)}: ${b.length} bytes, sha256 ${h}`);
          }
        } catch (e) {
          out.push(`  not a readable zip: ${e.message}`);
        }
      }
    } catch (e) {
      out.push("", `data/ folder: could not list (${e.message})`);
    }
  }

  const clients = files.others.filter((n) => n.endsWith(".client"));
  for (const c of clients) {
    try {
      const url = new URL(encodeURIComponent(c), files.listedUrl).toString();
      const bytes = await fetchFile(cfg, url, c, docKey);
      out.push("", `Client ${c}:`, `  ${show(parsePlist(bytes))}`);
    } catch (e) {
      out.push("", `Client ${c}: could not read (${e.message})`);
    }
  }

  // Raw XML: the newest transaction, and one task insert as OmniFocus writes it.
  const newest = files.at(-1);
  const newestXml = readContentsXml(await fetchFile(cfg, newest.url, newest.name, docKey));
  out.push("", `Newest transaction ${newest.name} (contents.xml, first ${xml_chars} chars):`, newestXml.slice(0, xml_chars));

  let sample = null;
  for (const f of [...files].reverse().slice(0, 6)) {
    const xml = f === newest ? newestXml : readContentsXml(await fetchFile(cfg, f.url, f.name, docKey));
    const m = /<task id="[^"]+">[\s\S]*?<\/task>(?=\s*<(?:task|context|folder|task-to-tag|perspective|setting|\/omnifocus))/.exec(xml);
    if (m) {
      sample = { from: f.name, xml: m[0] };
      break;
    }
  }
  if (sample) out.push("", `A task insert as OmniFocus wrote it (from ${sample.from}):`, sample.xml.slice(0, xml_chars));
  const link = /<task-to-tag[^>]*>[\s\S]*?<\/task-to-tag>/.exec(newestXml);
  if (link) out.push("", "A task-to-tag element:", link[0]);
  return out.join("\n");
}

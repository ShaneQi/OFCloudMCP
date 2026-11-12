// Read-only diagnostics of the sync folder, to check the file formats against
// a real database before anything writes to it.
import { syncContext, fetchFile } from "./store.js";
import { analyzeChain, analyzeChainOwnFirst } from "./chain.js";
import { parsePlist, keyInfo } from "./crypto.js";
import { readContentsXml } from "./ofocus.js";

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

export async function inspectSync(env, { xml_chars = 6000 } = {}) {
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

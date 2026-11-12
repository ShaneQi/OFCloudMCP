#!/usr/bin/env node
// Debug tool: reads a real OmniFocus.ofocus folder (over WebDAV, or a local
// copy), replays it with the connector's own parser, and writes a report that
// shows what the XML really contains, so parser mismatches are easy to spot.
//
//   OFOCUS_URL=… WEBDAV_USER=… WEBDAV_PASS=… node scripts/dump.mjs [--out dir]
//   node scripts/dump.mjs --dir path/to/OmniFocus.ofocus [--out dir]
//
// Options:
//   --out DIR     where to write results (default ./dump)
//   --dir DIR     read transaction files from a local folder instead of WebDAV
//   --tz ZONE     time zone (default $TIMEZONE or America/Chicago)
//
// Downloaded files are kept in DIR/files and reused on the next run.
// It only reads: it sends PROPFIND and GET requests and nothing else.
//
// Writes:
//   report.txt   element/field inventory, value samples, date shapes, timings
//   model.json   the replayed model
//   tools.txt    the output of each read tool, as Claude would see it
// None of these leave your computer. They contain your task data.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { XMLParser } from "fast-xml-parser";
import { config, listTransactions } from "../src/store.js";
import { davFetch } from "../src/dav.js";
import { newModel, applyTransaction, readContentsXml } from "../src/ofocus.js";
import { makeIndex, TOOLS } from "../src/query.js";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = path.resolve(opt("--out", "dump"));
const localDir = opt("--dir", null);
const tz = opt("--tz", process.env.TIMEZONE || "America/Chicago");
const filesDir = path.join(outDir, "files");
fs.mkdirSync(filesDir, { recursive: true });

const TRANSACTION = /^\d{14}=.+\.zip$/;
const log = (...a) => console.error(...a);

// ---------- 1. get the transaction files ----------
let names;
if (localDir) {
  names = fs.readdirSync(localDir).filter((n) => TRANSACTION.test(n)).sort();
  for (const n of names) fs.copyFileSync(path.join(localDir, n), path.join(filesDir, n));
  log(`Found ${names.length} transaction files in ${localDir}`);
} else {
  const cfg = config(process.env);
  const t0 = performance.now();
  const list = await listTransactions(cfg);
  log(`PROPFIND: ${list.length} transaction files (${(performance.now() - t0).toFixed(0)} ms)`);
  names = list.map((f) => f.name);
  let fetched = 0;
  for (const f of list) {
    const dest = path.join(filesDir, f.name);
    if (fs.existsSync(dest)) continue;
    const res = await davFetch(cfg, f.url);
    if (!res.ok) throw new Error(`GET ${f.name}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  log(`Downloaded ${fetched} new file(s), ${list.length - fetched} already cached`);
  for (const n of fs.readdirSync(filesDir)) if (!names.includes(n)) fs.unlinkSync(path.join(filesDir, n));
}
if (!names.length) throw new Error("No transaction files found.");

// ---------- 2. inventory of what the XML contains ----------
const raw = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  removeNSPrefix: true,
  stopNodes: ["*.note"],
  isArray: (_n, jpath) => jpath.split(".").length === 2,
});

const inv = {}; // "task op=update" -> { count, children: {name: count}, attrs }
const samples = {}; // "task/project/status" -> Map(value -> count)
const dateShapes = {}; // "task/due" -> {Z: n, floating: n, other: n, examples}
const rootAttrs = new Map();
const SAMPLE_FIELDS = new Set([
  "task/project/status", "task/project/singleton", "task/inbox", "task/flagged", "task/order",
  "task/hidden", "task/completed-by-children", "task/repetition-method", "task/repetition-rule",
  "context/hidden", "context/prohibits-next-action", "context/active", "context/status",
  "folder/hidden", "task/project/review-interval",
]);
const DATE_FIELD = /^(added|modified|start|due|completed|hidden|planned|last-review|next-review|completed-by-children)$/;

function shape(v) {
  if (/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)) return "Z";
  if (/^\d{4}-\d\d-\d\dT[\d:.]+[+-]\d\d:?\d\d$/.test(v)) return "offset";
  if (/^\d{4}-\d\d-\d\dT[\d:.]+$/.test(v)) return "floating";
  if (/^\d{4}-\d\d-\d\d$/.test(v)) return "date-only";
  return "other";
}
const value = (v) => (v == null ? "" : typeof v === "object" ? v["#text"] ?? (Object.keys(v).length ? "{…}" : "") : String(v));
function sample(key, v) {
  (samples[key] ??= new Map()).set(v, (samples[key].get(v) ?? 0) + 1);
}

function walkFields(type, el, prefix) {
  for (const [k, v] of Object.entries(el)) {
    if (k.startsWith("@_") || k === "#text") continue;
    const key = `${prefix}/${k}`;
    for (const item of Array.isArray(v) ? v : [v]) {
      const val = value(item);
      if (SAMPLE_FIELDS.has(key)) sample(key, val.length > 40 ? val.slice(0, 40) + "…" : val);
      if (DATE_FIELD.test(k) && val && val !== "{…}") {
        const d = (dateShapes[key] ??= { counts: {}, examples: {} });
        const s = shape(val);
        d.counts[s] = (d.counts[s] ?? 0) + 1;
        d.examples[s] ??= val;
      }
      if (k === "project" && item && typeof item === "object") walkFields(type, item, key);
    }
  }
}

const perFile = [];
let tUnzip = 0, tParse = 0, tReplay = 0, xmlBytes = 0;
const model = newModel();
for (const n of names) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(filesDir, n)));
  let t = performance.now();
  const xml = readContentsXml(bytes);
  tUnzip += performance.now() - t;
  xmlBytes += xml.length;

  const doc = raw.parse(xml).omnifocus ?? {};
  const counts = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith("@_")) {
      rootAttrs.set(`${k.slice(2)}=${v}`, (rootAttrs.get(`${k.slice(2)}=${v}`) ?? 0) + 1);
      continue;
    }
    for (const el of Array.isArray(v) ? v : [v]) {
      if (!el || typeof el !== "object") continue;
      const op = el["@_op"] ?? "insert";
      const label = `${k} op=${op}`;
      counts[label] = (counts[label] ?? 0) + 1;
      const e = (inv[label] ??= { count: 0, children: {}, attrs: {} });
      e.count++;
      for (const ck of Object.keys(el)) {
        if (ck.startsWith("@_")) e.attrs[ck.slice(2)] = (e.attrs[ck.slice(2)] ?? 0) + 1;
        else e.children[ck] = (e.children[ck] ?? 0) + 1;
      }
      walkFields(k, el, k);
    }
  }
  perFile.push({ name: n, zipBytes: bytes.length, xmlBytes: xml.length, counts });

  t = performance.now();
  // time the connector's own parse + replay (the Worker does exactly this)
  applyTransaction(model, xml);
  tReplay += performance.now() - t;
}

// Partial-update check: do op=update elements carry every field an insert has?
const partial = [];
for (const [label, e] of Object.entries(inv)) {
  if (!label.endsWith("op=update")) continue;
  const ins = inv[label.replace("op=update", "op=insert")];
  if (!ins) continue;
  const missing = Object.keys(ins.children).filter((c) => (e.children[c] ?? 0) < e.count * 0.9);
  partial.push(`${label}: ${e.count} elements; fields often missing vs insert: ${missing.join(", ") || "none (looks like full records)"}`);
}

// File-name chain check: NAME = timestamp=prev+this or timestamp=this
const chain = names.map((n) => {
  const [, ts, ids] = /^(\d{14})=(.+)\.zip$/.exec(n);
  return { n, ts, ids: ids.split("+") };
});
const known = new Set();
const chainIssues = [];
for (const c of chain) {
  if (c.ids.length > 1 && !c.ids.slice(0, -1).every((id) => id.split(",").every((x) => known.has(x)))) {
    chainIssues.push(`${c.n}: refers to an id not seen in an earlier file (by name order)`);
  }
  c.ids.forEach((id) => id.split(",").forEach((x) => known.add(x)));
}

// ---------- 3. write outputs ----------
const ix = makeIndex(model, tz, Date.now());
const modelJson = JSON.stringify(model);
let tJson = performance.now();
JSON.parse(modelJson);
tJson = performance.now() - tJson;

const fmtMap = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${JSON.stringify(v)}×${c}`).join(", ");
const r = [];
r.push(`Files: ${names.length}  (first ${names[0]}, last ${names.at(-1)})`);
r.push(`Root attributes: ${fmtMap(rootAttrs)}`);
r.push(`Total zip ${(perFile.reduce((a, f) => a + f.zipBytes, 0) / 1e6).toFixed(2)} MB, XML ${(xmlBytes / 1e6).toFixed(2)} MB, model JSON ${(modelJson.length / 1e6).toFixed(2)} MB`);
r.push(`Timings on this machine (the Worker's CPU is similar or a bit slower):`);
r.push(`  unzip ${tUnzip.toFixed(0)} ms, parse+replay ${tReplay.toFixed(0)} ms, JSON.parse of cached model ${tJson.toFixed(0)} ms`);
r.push("", "== Elements (name op=…: count; child fields with counts) ==");
for (const [label, e] of Object.entries(inv).sort()) {
  r.push(`${label}: ${e.count}`);
  r.push(`  attrs: ${Object.entries(e.attrs).map(([k, c]) => `${k}×${c}`).join(", ")}`);
  r.push(`  fields: ${Object.entries(e.children).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}×${c}`).join(", ")}`);
}
r.push("", "== Updates: full or partial records? ==", ...(partial.length ? partial : ["no op=update elements"]));
r.push("", "== Value samples ==");
for (const [k, m] of Object.entries(samples).sort()) r.push(`${k}: ${fmtMap(m)}`);
r.push("", "== Date formats ==");
for (const [k, d] of Object.entries(dateShapes).sort()) {
  r.push(`${k}: ${Object.entries(d.counts).map(([s, c]) => `${s}×${c}`).join(", ")}  e.g. ${Object.entries(d.examples).map(([s, v]) => `${s}: ${v}`).join("; ")}`);
}
r.push("", "== File-name order check ==", ...(chainIssues.length ? chainIssues.slice(0, 50) : ["name order is consistent with the prev+this ids"]));
r.push("", "== Model totals ==");
r.push(`tasks ${Object.keys(model.tasks).length}, contexts ${Object.keys(model.contexts).length}, folders ${Object.keys(model.folders).length}, task-to-tag ${Object.keys(model.taskToTag).length}`);
const orphans = Object.values(model.tasks).filter((t) => t.parent && !model.tasks[t.parent]).length;
const badTags = Object.values(model.taskToTag).filter((l) => !model.tasks[l.task] || !model.contexts[l.context]).length;
r.push(`tasks whose parent is missing: ${orphans}; task-to-tag links to missing items: ${badTags}`);
r.push("", "== Per file ==");
for (const f of perFile) r.push(`${f.name}  zip ${f.zipBytes}  xml ${f.xmlBytes}  ${Object.entries(f.counts).map(([k, c]) => `${k}×${c}`).join(", ")}`);

fs.writeFileSync(path.join(outDir, "report.txt"), r.join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "model.json"), JSON.stringify(model, null, 1));

const meta = { files: names, source: localDir ? "local folder" : "WebDAV (dump script)", builtAt: new Date().toISOString() };
const runs = [
  ["sync_status", {}], ["list_inbox", {}], ["list_due", { days: 14 }], ["list_flagged", {}],
  ["list_projects", { status: "all" }], ["list_tags", {}],
];
const out = [];
for (const [name, a] of runs) {
  const tool = TOOLS.find((t) => t.name === name);
  let text;
  try { text = tool.run(ix, a, meta); } catch (e) { text = `ERROR: ${e.message}`; }
  out.push(`######## ${name} ${JSON.stringify(a)}\n${text}\n`);
}
fs.writeFileSync(path.join(outDir, "tools.txt"), out.join("\n"));
log(`Wrote ${path.join(outDir, "report.txt")}, model.json, tools.txt`);

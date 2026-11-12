// Writing to the OmniFocus database: each change is one new transaction file,
// formatted the way OmniFocus 4 writes them (checked against a real database
// with inspect_sync), chained after the current head, encrypted with the
// database's active key, verified by reading it back, then uploaded under a
// temporary name and moved into place so no device sees a partial file.
//
//   name:    YYYYMMDDHHMMSS=<head id>+<new transaction id>.zip   (UTC time)
//   insert:  <task id="…"> with every field, in OmniFocus' order
//   update:  <task id="…" op="update"> with <added>, <modified> and only the
//            changed fields (the database's "delta_transactions" capability)
//   dates:   due/defer/planned as floating local time "YYYY-MM-DDTHH:MM:SS.000";
//            added/modified/completed/hidden in UTC with "Z"
import { zipSync, strToU8 } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { UserError } from "./errors.js";
import { syncContext, loadModel } from "./store.js";
import { davFetch } from "./dav.js";
import { analyzeChain } from "./chain.js";
import { encryptFile, decryptFile } from "./crypto.js";
import { readContentsXml, applyTransaction } from "./ofocus.js";

export const writeMode = (env) => {
  const v = String(env.ALLOW_WRITES ?? "").toLowerCase();
  return v === "true" ? "on" : "off";
};

// ---------- ids, times, escaping ----------
const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
export function newId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(11));
  // OmniFocus ids start with a letter
  return [...bytes].map((b, i) => (i === 0 ? ID_CHARS[b % 52] : ID_CHARS[b % 64])).join("");
}

export const utcStamp = (ms) => new Date(ms).toISOString(); // 2026-11-12T20:40:08.427Z

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // characters XML 1.0 cannot carry
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");

function noteXml(note) {
  if (note == null || note === "") return "<note/>";
  const paras = String(note).replace(/\r\n?/g, "\n").split("\n")
    .map((line) => (line ? `<p><run><lit>${esc(line)}</lit></run></p>` : "<p/>"));
  return `<note><text>${paras.join("")}</text></note>`;
}

// ---------- dates ----------
function wallParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const v = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") v[p.type] = p.value;
  return v;
}

// User input -> floating local "YYYY-MM-DDTHH:MM:SS.000" (or null to clear).
//   "2026-11-20"            -> that day at the default time (setting)
//   "2026-11-20 14:30", "2026-11-20T14:30[:00]" -> local wall time
//   "2026-11-20T20:30:00Z" / with offset -> converted to local wall time
export function floatingDate(input, tz, defaultTime, what) {
  if (input === null) return null;
  const s = String(input).trim();
  if (s === "") return null;
  let m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
  if (m) return `${s}T${(defaultTime || "17:00:00").slice(0, 8).padEnd(8, ":00")}.000`;
  m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}.000`;
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/i.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) {
      const v = wallParts(ms, tz);
      return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}.000`;
    }
  }
  throw new UserError(`"${what}" must look like 2026-11-20, 2026-11-20 14:30, or an ISO time; got "${input}".`);
}

// ---------- ranks ----------
const INT32_MAX = 2147483647;
export function rankAfter(ranks) {
  const nums = ranks.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  const max = Math.max(...nums);
  if (max + 65536 <= INT32_MAX) return max + 65536;
  return max + Math.floor((INT32_MAX - max) / 2) || max;
}

// rank-in-task strings ("0001", "aeba"): next string that sorts after all given.
const RANK_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
export function linkRankAfter(ranks) {
  const max = ranks.filter(Boolean).sort().at(-1);
  if (!max) return "0001";
  const last = max.at(-1);
  const i = RANK_CHARS.indexOf(last);
  if (i >= 0 && i < RANK_CHARS.length - 1) return max.slice(0, -1) + RANK_CHARS[i + 1];
  return max + "1";
}

// ---------- XML builders ----------
// Field order of a task as OmniFocus 4.10 writes it.
const TASK_FIELDS = [
  "project", "inbox", "task", "added", "name", "note", "rank", "hidden", "context", "start", "planned",
  "due", "completed", "estimated-minutes", "order", "flagged", "completed-by-children", "repetition-rule",
  "repetition-method", "repetition-schedule-type", "repetition-anchor-date", "catch-up-automatically",
  "next-clone-identifier", "due-date-alarm-policy", "defer-date-alarm-policy",
  "latest-time-to-start-alarm-policy", "planned-date-alarm-policy", "modified",
];

const leaf = (tag, v) => (v == null || v === "" ? `<${tag}/>` : `<${tag}>${esc(v)}</${tag}>`);
const idref = (tag, id) => (id ? `<${tag} idref="${esc(id)}"/>` : `<${tag}/>`);

function fieldXml(tag, v) {
  switch (tag) {
    case "project": return "<project/>"; // actions only
    case "task": return idref("task", v);
    case "context": return idref("context", v);
    case "note": return noteXml(v);
    default: return leaf(tag, v);
  }
}

export function taskInsertXml(f) {
  const vals = {
    project: null, inbox: f.inbox ? "true" : "false", task: f.parent ?? null, added: f.added,
    name: f.name, note: f.note ?? null, rank: String(f.rank), hidden: null, context: f.context ?? null,
    start: f.start ?? null, planned: f.planned ?? null, due: f.due ?? null, completed: null,
    "estimated-minutes": f.estimate ?? null, order: "parallel", flagged: f.flagged ? "true" : "false",
    "completed-by-children": "false", "repetition-rule": null, "repetition-method": null,
    "repetition-schedule-type": null, "repetition-anchor-date": null, "catch-up-automatically": "false",
    "next-clone-identifier": "0", "due-date-alarm-policy": null, "defer-date-alarm-policy": null,
    "latest-time-to-start-alarm-policy": null, "planned-date-alarm-policy": null, modified: f.modified,
  };
  const body = TASK_FIELDS.map((t) => "    " + fieldXml(t, vals[t])).join("\n");
  return `  <task id="${esc(f.id)}">\n${body}\n  </task>`;
}

// changes: { field: value } using XML field names. OmniFocus writes the
// structural fields first, then added and modified, then the rest.
export function taskUpdateXml(id, added, modified, changes, { isProject = false } = {}) {
  const parts = [];
  const order = TASK_FIELDS.filter((t) => t !== "added" && t !== "modified");
  const early = ["project", "inbox", "task"];
  for (const t of early) if (t in changes && !(t === "project" && isProject)) parts.push(fieldXml(t, changes[t]));
  parts.push(leaf("added", added), leaf("modified", modified));
  for (const t of order) if (!early.includes(t) && t in changes) parts.push(fieldXml(t, changes[t]));
  return `  <task id="${esc(id)}" op="update">${parts.join("")}</task>`;
}

export function linkInsertXml(taskId, tagId, rankInTask, added) {
  return (
    `  <task-to-tag id="${esc(taskId)}.${esc(tagId)}">\n` +
    `    ${leaf("added", added)}\n    ${idref("task", taskId)}\n    ${idref("context", tagId)}\n` +
    `    ${leaf("rank-in-task", rankInTask)}\n    <rank-in-tag/>\n  </task-to-tag>`
  );
}
export const linkDeleteXml = (linkId) => `  <task-to-tag id="${esc(linkId)}" op="delete"/>`;

const ROOT =
  '<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2" app-id="com.omnigroup.OmniFocus4" ' +
  'app-version="190.2.0" os-name="Linux" os-version="omnifocus-mcp" machine-model="omnifocus-mcp">';

export function transactionXml(elements) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${ROOT}\n${elements.join("\n")}\n</omnifocus>\n`;
}

// ---------- committing ----------
function nameStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function bumpStamp(ts) {
  // ts "YYYYMMDDHHMMSS" + 1 second
  const d = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14));
  return nameStamp(d + 1000);
}

// Builds, verifies and (unless dryRun) uploads one transaction.
//   build(model, now) -> { elements: [...xml], check(model) -> string|null, summary }
// check runs on a copy of the model with the transaction applied and returns
// an error message if the result is not what was intended.
export async function commit(env, ctx, build, { dryRun }) {
  const now = Date.now();
  const sc = await syncContext(env);
  const { files, docKey, cfg } = sc;
  const names = files.map((f) => f.name);
  const chain = analyzeChain(names);
  if (!chain.consistent) {
    throw new UserError(`Not writing: the sync folder's transaction chain looks unusual (${chain.problems[0]}).`);
  }
  if (chain.heads.length !== 1) {
    throw new UserError(
      `Not writing: the database has ${chain.heads.length} unmerged sync branches (${chain.heads.join(", ")}). ` +
        "Let OmniFocus sync on a device to merge them, then try again."
    );
  }
  const head = chain.heads[0];
  const newest = chain.files.at(-1);
  if (newest.own !== head) throw new UserError("Not writing: the newest transaction is not the chain's head.");

  const data = await loadModel(env, ctx);
  const plan = build(data.model, now);
  const xml = transactionXml(plan.elements);
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Generated XML is invalid: ${valid.err?.msg}`);

  let ts = nameStamp(now);
  if (ts <= newest.ts) ts = bumpStamp(newest.ts);
  const txId = newId();
  const name = `${ts}=${head}+${txId}.zip`;

  // Package and verify by reading it back exactly as a reader would.
  const zip = zipSync({ "contents.xml": strToU8(xml) }, { level: 6 });
  const bytes = docKey ? await encryptFile(zip, docKey) : zip;
  const back = docKey ? await decryptFile(name, bytes, docKey) : bytes;
  const xmlBack = readContentsXml(back);
  if (xmlBack !== xml) throw new Error("Verification failed: the packaged transaction does not read back identically.");
  const copy = structuredClone(data.model);
  applyTransaction(copy, xmlBack);
  const problem = plan.check(copy);
  if (problem) throw new Error(`Verification failed: ${problem}`);

  const report = [plan.summary, `Transaction: ${name}${docKey ? " (encrypted)" : ""}, ${bytes.length} bytes.`];
  if (dryRun || writeMode(env) !== "on") {
    report.unshift(
      dryRun
        ? "DRY RUN: nothing was written. This is the transaction that would be added:"
        : "NOT WRITTEN: writing is disabled on this server (set ALLOW_WRITES=true to enable). Preview:"
    );
    report.push("", xml);
    return report.join("\n");
  }

  // Upload under a temporary name, then move into place.
  const dir = files.listedUrl.endsWith("/") ? files.listedUrl : files.listedUrl + "/";
  const finalUrl = new URL(encodeURIComponent(name), dir).toString();
  const tmpName = `${name}-write-in-progress-${newId()}`;
  const tmpUrl = new URL(encodeURIComponent(tmpName), dir).toString();
  let res = await davFetch(cfg, tmpUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" },
    body: bytes,
  });
  if (!res.ok) throw new UserError(`Uploading the transaction failed (HTTP ${res.status}). Nothing was changed.`);
  res = await davFetch(cfg, tmpUrl, { method: "MOVE", headers: { Destination: finalUrl, Overwrite: "F" } });
  if (!res.ok) {
    await davFetch(cfg, tmpUrl, { method: "DELETE" }).catch(() => {});
    throw new UserError(`Moving the transaction into place failed (HTTP ${res.status}). Nothing was changed.`);
  }

  // Read the database again and confirm the change is there.
  const after = await loadModel(env, ctx);
  if (!after.files.includes(name)) throw new Error(`Uploaded ${name}, but it is not in the folder listing.`);
  const problemAfter = plan.check(after.model);
  report.unshift(problemAfter ? `Written, but reading it back shows: ${problemAfter}` : "Done.");
  return report.join("\n");
}

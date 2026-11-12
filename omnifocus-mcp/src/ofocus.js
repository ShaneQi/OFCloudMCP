// Parses OmniFocus transaction files (.zip containing contents.xml) and
// replays them into a plain-object model:
//   { tasks, contexts, folders, taskToTag } — each a map of id -> record.
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const TOP_LEVEL = new Set(["task", "context", "folder", "task-to-tag", "perspective", "setting", "attachment"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  // keep rich-text notes as raw XML (parsed by noteText); skip attachment previews
  stopNodes: ["*.note", "*.preview-image"],
  isArray: (name, jpath) => TOP_LEVEL.has(name) && jpath === `omnifocus.${name}`,
});

export function newModel() {
  return { tasks: {}, contexts: {}, folders: {}, taskToTag: {}, settings: {}, attachments: {} };
}

export function readContentsXml(bytes) {
  const files = unzipSync(bytes, {
    filter: (f) => f.name === "contents.xml" || f.name.endsWith("/contents.xml"),
  });
  const key = Object.keys(files)[0];
  if (!key) throw new Error("contents.xml not found in transaction file");
  return strFromU8(files[key]);
}

export function applyTransaction(model, xml) {
  const root = parser.parse(xml).omnifocus;
  if (!root || typeof root !== "object") throw new Error("Not an OmniFocus transaction");
  for (const el of root.folder ?? []) applyOp(model.folders, el, normFolder);
  for (const el of root.context ?? []) applyOp(model.contexts, el, normContext);
  for (const el of root.task ?? []) applyOp(model.tasks, el, normTask);
  for (const el of root["task-to-tag"] ?? []) applyOp(model.taskToTag, el, normLink);
  model.attachments ??= {};
  for (const el of root.attachment ?? []) applyOp(model.attachments, el, normAttachment);
  model.settings ??= {};
  for (const el of root.setting ?? []) {
    const id = el?.["@_id"];
    if (!id) continue;
    if (el["@_op"] === "delete") delete model.settings[id];
    else {
      const v = el.plist && typeof el.plist === "object" ? el.plist.string ?? el.plist.integer ?? null : null;
      if (v != null) model.settings[id] = txt(v);
    }
  }
  return model;
}

function applyOp(map, el, norm) {
  if (!el || typeof el !== "object") return;
  const id = el["@_id"];
  if (!id) return;
  const op = el["@_op"];
  if (op === "delete") {
    delete map[id];
    return;
  }
  const fields = norm(el);
  if (op) map[id] = { ...(map[id] ?? {}), ...fields, id }; // update: merge
  else map[id] = { ...fields, id }; // insert
}

const has = (el, key) => Object.prototype.hasOwnProperty.call(el, key);

function txt(v) {
  if (v == null) return null;
  if (typeof v === "object") v = v["#text"] ?? "";
  v = String(v);
  return v === "" ? null : v;
}
const ref = (v) => (v && typeof v === "object" ? v["@_idref"] ?? null : null);
const bool = (v) => txt(v) === "true";
// Dates or flags where "false"/empty means "not set" (e.g. <hidden>false</hidden>).
const flagOrDate = (v) => {
  const t = txt(v);
  return t == null || t === "false" || t === "0" ? null : t;
};

function pick(el, out, key, xmlKey, conv) {
  if (has(el, xmlKey)) out[key] = conv(el[xmlKey]);
}

function normTask(el) {
  const o = {};
  pick(el, o, "name", "name", txt);
  pick(el, o, "note", "note", noteText);
  pick(el, o, "noteXml", "note", rawNote); // original rich text, for copies
  pick(el, o, "parent", "task", ref);
  pick(el, o, "context", "context", ref);
  pick(el, o, "inbox", "inbox", bool);
  pick(el, o, "flagged", "flagged", bool);
  pick(el, o, "start", "start", txt);
  pick(el, o, "due", "due", txt);
  pick(el, o, "completed", "completed", flagOrDate);
  pick(el, o, "hidden", "hidden", flagOrDate); // drop date
  pick(el, o, "added", "added", txt);
  pick(el, o, "modified", "modified", txt);
  pick(el, o, "estimate", "estimated-minutes", txt);
  pick(el, o, "planned", "planned", txt);
  pick(el, o, "rank", "rank", txt);
  pick(el, o, "order", "order", txt);
  pick(el, o, "repeat", "repetition-rule", txt);
  pick(el, o, "repeatMethod", "repetition-method", txt);
  pick(el, o, "repeatSchedule", "repetition-schedule-type", txt);
  pick(el, o, "repeatAnchor", "repetition-anchor-date", txt);
  pick(el, o, "catchUp", "catch-up-automatically", bool);
  pick(el, o, "nextClone", "next-clone-identifier", txt);
  pick(el, o, "completedByChildren", "completed-by-children", bool);
  for (const [k, x] of [["dueAlarm", "due-date-alarm-policy"], ["deferAlarm", "defer-date-alarm-policy"],
    ["latestAlarm", "latest-time-to-start-alarm-policy"], ["plannedAlarm", "planned-date-alarm-policy"]]) pick(el, o, k, x, txt);
  if (has(el, "project")) o.project = normProject(el.project);
  return o;
}

function normProject(v) {
  if (!v || typeof v !== "object" || Object.keys(v).length === 0) return null;
  return {
    folder: ref(v.folder),
    status: txt(v.status) ?? "active", // active | inactive (on hold) | done | dropped
    singleton: bool(v.singleton),
    lastReview: txt(v["last-review"]),
    nextReview: txt(v["next-review"]),
    reviewInterval: txt(v["review-interval"]),
  };
}

function rawNote(v) {
  if (v == null) return null;
  const raw = typeof v === "string" ? v : String(v["#text"] ?? "");
  return raw.trim() ? raw.trim() : null;
}

function normAttachment(el) {
  const o = {};
  pick(el, o, "task", "task", ref);
  pick(el, o, "name", "name", txt);
  pick(el, o, "dataId", "data-identifier", txt);
  pick(el, o, "added", "added", txt);
  return o;
}

function normContext(el) {
  const o = {};
  pick(el, o, "name", "name", txt);
  pick(el, o, "parent", "context", ref);
  pick(el, o, "hidden", "hidden", flagOrDate);
  pick(el, o, "onHold", "prohibits-next-action", bool);
  pick(el, o, "rank", "rank", txt);
  return o;
}

function normFolder(el) {
  const o = {};
  pick(el, o, "name", "name", txt);
  pick(el, o, "parent", "folder", ref);
  pick(el, o, "hidden", "hidden", flagOrDate);
  pick(el, o, "rank", "rank", txt);
  return o;
}

function normLink(el) {
  const o = {};
  pick(el, o, "task", "task", ref);
  pick(el, o, "context", "context", ref);
  pick(el, o, "rankInTask", "rank-in-task", txt);
  return o;
}

// Rich text: <text><p><run><style>…</style><lit>words</lit></run></p>…</text>
export function noteText(v) {
  if (v == null) return null;
  const raw = typeof v === "string" ? v : String(v["#text"] ?? "");
  if (!raw.trim()) return null;
  if (!raw.includes("<")) return decodeEntities(raw).trim() || null;
  const lines = raw
    .replace(/<p\s*\/>/g, "<p></p>") // empty paragraph = empty line
    .split(/<\/p>/)
    .map((p) => [...p.matchAll(/<lit>([\s\S]*?)<\/lit>/g)].map((m) => decodeEntities(m[1])).join(""));
  return lines.join("\n").trim() || null;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

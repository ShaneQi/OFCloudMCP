// Read-only queries over the replayed model, formatted as plain text.
import { UserError } from "./errors.js";
import { inspectSync } from "./inspect.js";

const DAY = 86_400_000;

// ---------- dates ----------
const displayFormats = new Map();
const partsFormats = new Map();

export function fmtDate(ms, tz) {
  if (!displayFormats.has(tz)) {
    displayFormats.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, weekday: "short", month: "short", day: "numeric",
        year: "numeric", hour: "numeric", minute: "2-digit",
      })
    );
  }
  return displayFormats.get(tz).format(new Date(ms));
}

function tzOffset(ms, tz) {
  if (!partsFormats.has(tz)) {
    partsFormats.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
        day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      })
    );
  }
  const v = {};
  for (const p of partsFormats.get(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// OmniFocus stores UTC ("…Z") or floating local times (no zone).
export function parseDate(s, tz) {
  if (!s) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map((x) => Number(x ?? 0));
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

const minOf = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxOf = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

// ---------- index ----------
const byRank = (a, b) =>
  (Number(a.rank) || 0) - (Number(b.rank) || 0) || (a.name ?? "").localeCompare(b.name ?? "");

export function makeIndex(model, tz, now) {
  const { tasks, contexts, folders, taskToTag } = model;
  const all = Object.values(tasks);

  const kids = new Map();
  for (const t of all) {
    const p = t.parent && tasks[t.parent] ? t.parent : "";
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  for (const list of kids.values()) list.sort(byRank);

  const tagSets = new Map();
  const addTag = (tid, cid) => {
    if (!tid || !cid || !contexts[cid]) return;
    if (!tagSets.has(tid)) tagSets.set(tid, new Set());
    tagSets.get(tid).add(cid);
  };
  for (const t of all) addTag(t.id, t.context);
  for (const l of Object.values(taskToTag)) addTag(l.task, l.context);

  const chain = (map, id) => {
    const out = [];
    const seen = new Set();
    while (id && map[id] && !seen.has(id)) {
      seen.add(id);
      out.unshift(map[id]);
      id = map[id].parent;
    }
    return out;
  };
  const folderPath = (id) => chain(folders, id).map((f) => f.name ?? "(untitled)").join(" / ");
  const folderDropped = (id) => chain(folders, id).some((f) => f.hidden);
  const tagPath = (id) => chain(contexts, id).map((c) => c.name ?? "(untitled)").join(" : ");
  const tagNames = (id) => [...(tagSets.get(id) ?? [])].map((c) => contexts[c].name ?? "?").sort();

  const cache = new Map();
  const visiting = new Set();
  function info(t) {
    if (cache.has(t.id)) return cache.get(t.id);
    visiting.add(t.id);
    const parent = t.parent && tasks[t.parent] && !visiting.has(t.parent) ? tasks[t.parent] : null;
    const pi = parent ? info(parent) : null;
    visiting.delete(t.id);
    const isProject = !!t.project;
    const status = isProject ? t.project.status : null;
    const r = {
      isProject,
      project: isProject ? t : pi?.project ?? null,
      inbox: !!t.inbox || !!pi?.inbox,
      closed:
        !!t.completed || !!t.hidden || status === "done" || status === "dropped" ||
        (isProject && folderDropped(t.project.folder)) || !!pi?.closed,
      onHold: status === "inactive" || !!pi?.onHold,
      effDue: minOf(parseDate(t.due, tz), pi?.effDue ?? null),
      effStart: maxOf(parseDate(t.start, tz), pi?.effStart ?? null),
      effFlagged: !!t.flagged || !!pi?.effFlagged,
    };
    cache.set(t.id, r);
    return r;
  }

  return {
    model, tz, now, all, info, tagSets, tagNames, tagPath, folderPath,
    children: (id) => kids.get(id) ?? [],
    date: (s) => parseDate(s, tz),
    fmt: (ms) => fmtDate(ms, tz),
  };
}

// ---------- formatting ----------
function closedLabel(ix, t) {
  if (t.completed) return `completed ${fmtMaybe(ix, t.completed)}`;
  if (t.hidden || t.project?.status === "dropped") return "dropped";
  if (t.project?.status === "done") return "completed";
  return "closed (its project or parent is finished)";
}

function fmtMaybe(ix, s) {
  const ms = ix.date(s);
  return ms == null ? s : ix.fmt(ms);
}

function line(ix, t, { showProject = true, indent = 0 } = {}) {
  const i = ix.info(t);
  const bits = [t.name || "(untitled)"];
  if (i.isProject) bits.push("project");
  else if (showProject) {
    if (i.project) bits.push(`in ${i.project.name || "(untitled project)"}`);
    else if (i.inbox) bits.push("in Inbox");
  }
  const due = ix.date(t.due);
  if (due != null) bits.push(`due ${ix.fmt(due)}${!i.closed && due < ix.now ? " (overdue)" : ""}`);
  const start = ix.date(t.start);
  if (start != null && start > ix.now && !i.closed) bits.push(`deferred until ${ix.fmt(start)}`);
  if (t.flagged) bits.push("flagged");
  if (i.onHold && !i.closed) bits.push("on hold");
  if (i.closed) bits.push(closedLabel(ix, t));
  const tags = ix.tagNames(t.id);
  if (tags.length) bits.push(`tags: ${tags.join(", ")}`);
  return `${"  ".repeat(indent)}- ${bits.join(" · ")} [id:${t.id}]`;
}

function listOut(title, lines, extra = "") {
  if (!lines.length) return `${title}: none.`;
  return `${title} (${lines.length}):\n${lines.join("\n")}${extra}`;
}

// ---------- argument helpers ----------
const OBJ = (properties = {}, required = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

function argStr(v, name, required = false) {
  if (v == null || v === "") {
    if (required) throw new UserError(`"${name}" is required.`);
    return null;
  }
  if (typeof v !== "string") throw new UserError(`"${name}" must be a string.`);
  return v.trim();
}
function argInt(v, def, min, max) {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserError("Expected a number.");
  return Math.min(max, Math.max(min, Math.round(n)));
}
const argBool = (v, def) => (typeof v === "boolean" ? v : def);

function resolve(items, query, display, kind) {
  const q = query.toLowerCase();
  const byId = items.find((t) => t.id === query);
  if (byId) return byId;
  const exact = items.filter((t) => (display(t) ?? "").toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const matches = exact.length ? exact : items.filter((t) => (display(t) ?? "").toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new UserError(`No ${kind} matches "${query}".`);
  const list = matches.slice(0, 15).map((t) => `- ${display(t)} [id:${t.id}]`).join("\n");
  throw new UserError(`"${query}" matches ${matches.length} ${kind}s. Use an id:\n${list}`);
}

function projectStatus(ix, p) {
  if (p.completed || p.project.status === "done") return "completed";
  if (ix.info(p).closed) return "dropped";
  if (p.project.status === "inactive") return "on_hold";
  return "active";
}

const STATUS_TEXT = { active: "active", on_hold: "on hold", completed: "completed", dropped: "dropped" };

const sortByDue = (ix) => (a, b) =>
  (ix.date(a.due) ?? Infinity) - (ix.date(b.due) ?? Infinity) || (a.name ?? "").localeCompare(b.name ?? "");

// ---------- tools ----------
export const TOOLS = [
  {
    name: "list_inbox",
    title: "List inbox",
    description: "List the remaining (not completed or dropped) items in the OmniFocus inbox, oldest first.",
    inputSchema: OBJ(),
    run(ix) {
      const items = ix.all
        .filter((t) => {
          const i = ix.info(t);
          return i.inbox && !i.closed && !i.isProject;
        })
        .sort((a, b) => (ix.date(a.added) ?? 0) - (ix.date(b.added) ?? 0));
      return listOut("Inbox", items.map((t) => line(ix, t, { showProject: false })));
    },
  },
  {
    name: "list_due",
    title: "List due items",
    description:
      "List remaining OmniFocus actions and projects whose own due date falls within the next N days, " +
      "optionally including overdue items. Sorted by due date.",
    inputSchema: OBJ({
      days: { type: "integer", minimum: 0, maximum: 365, description: "Days ahead to include (default 7)." },
      include_overdue: { type: "boolean", description: "Include items already overdue (default true)." },
    }),
    run(ix, a) {
      const days = argInt(a.days, 7, 0, 365);
      const overdue = argBool(a.include_overdue, true);
      const end = ix.now + days * DAY;
      const items = ix.all
        .filter((t) => {
          if (ix.info(t).closed) return false;
          const d = ix.date(t.due);
          return d != null && d <= end && (overdue || d >= ix.now);
        })
        .sort(sortByDue(ix));
      const title = `Due in the next ${days} day(s)${overdue ? ", plus overdue" : ""}`;
      return listOut(title, items.map((t) => line(ix, t)));
    },
  },
  {
    name: "list_flagged",
    title: "List flagged items",
    description: "List remaining OmniFocus actions and projects that are flagged, sorted by due date.",
    inputSchema: OBJ(),
    run(ix) {
      const items = ix.all.filter((t) => t.flagged && !ix.info(t).closed).sort(sortByDue(ix));
      return listOut("Flagged", items.map((t) => line(ix, t)));
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "List OmniFocus projects with their folder, status, and number of remaining actions.",
    inputSchema: OBJ({
      status: {
        type: "string",
        enum: ["active", "on_hold", "completed", "dropped", "all"],
        description: "Which projects to include (default active).",
      },
      folder: { type: "string", description: "Only projects whose folder path contains this text." },
    }),
    run(ix, a) {
      const want = argStr(a.status, "status") ?? "active";
      if (!["active", "on_hold", "completed", "dropped", "all"].includes(want)) {
        throw new UserError('"status" must be active, on_hold, completed, dropped, or all.');
      }
      const folderQ = argStr(a.folder, "folder")?.toLowerCase();
      const counts = new Map();
      for (const t of ix.all) {
        const i = ix.info(t);
        if (!i.isProject && !i.closed && i.project) counts.set(i.project.id, (counts.get(i.project.id) ?? 0) + 1);
      }
      const projects = ix.all
        .filter((t) => t.project)
        .map((p) => ({ p, status: projectStatus(ix, p), path: ix.folderPath(p.project.folder) }))
        .filter((x) => want === "all" || x.status === want)
        .filter((x) => !folderQ || x.path.toLowerCase().includes(folderQ))
        .sort((x, y) => x.path.localeCompare(y.path) || byRank(x.p, y.p));
      const lines = projects.map(({ p, status, path }) => {
        const bits = [`${path ? path + " / " : ""}${p.name || "(untitled)"}`, STATUS_TEXT[status]];
        bits.push(`${counts.get(p.id) ?? 0} remaining`);
        const due = ix.date(p.due);
        if (due != null) bits.push(`due ${ix.fmt(due)}`);
        if (p.flagged) bits.push("flagged");
        return `- ${bits.join(" · ")} [id:${p.id}]`;
      });
      return listOut(`Projects (${want.replace("_", " ")})`, lines);
    },
  },
  {
    name: "get_project",
    title: "Get project",
    description: "Show one OmniFocus project, by id or name, with its note and its actions as an outline.",
    inputSchema: OBJ(
      {
        project: { type: "string", description: "Project id or name (partial names work if unique)." },
        include_completed: { type: "boolean", description: "Include completed and dropped actions (default false)." },
      },
      ["project"]
    ),
    run(ix, a) {
      const query = argStr(a.project, "project", true);
      const all = argBool(a.include_completed, false);
      const p = resolve(ix.all.filter((t) => t.project), query, (t) => t.name, "project");
      const out = [`Project: ${p.name || "(untitled)"} [id:${p.id}]`];
      const path = ix.folderPath(p.project.folder);
      if (path) out.push(`Folder: ${path}`);
      out.push(`Status: ${STATUS_TEXT[projectStatus(ix, p)]}${p.project.singleton ? " (single-actions list)" : ""}`);
      if (p.order) out.push(`Order: ${p.order}`);
      const due = ix.date(p.due);
      if (due != null) out.push(`Due: ${ix.fmt(due)}`);
      const start = ix.date(p.start);
      if (start != null) out.push(`Defer until: ${ix.fmt(start)}`);
      if (p.flagged) out.push("Flagged: yes");
      const tags = ix.tagNames(p.id);
      if (tags.length) out.push(`Tags: ${tags.join(", ")}`);
      if (p.note) out.push(`Note:\n${p.note}`);
      const rows = [];
      const walk = (id, depth) => {
        for (const c of ix.children(id)) {
          if (!all && ix.info(c).closed) continue;
          rows.push(line(ix, c, { showProject: false, indent: depth }));
          walk(c.id, depth + 1);
        }
      };
      walk(p.id, 0);
      out.push("", rows.length ? `Actions${all ? "" : " (remaining)"}:\n${rows.join("\n")}` : "No remaining actions.");
      return out.join("\n");
    },
  },
  {
    name: "search_tasks",
    title: "Search",
    description:
      "Search OmniFocus actions and projects by words in their name, note, or tags. Every word must match.",
    inputSchema: OBJ(
      {
        query: { type: "string", description: "Words to search for." },
        include_completed: { type: "boolean", description: "Also search completed and dropped items (default false)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum results (default 50)." },
      },
      ["query"]
    ),
    run(ix, a) {
      const terms = argStr(a.query, "query", true).toLowerCase().split(/\s+/).filter(Boolean);
      const all = argBool(a.include_completed, false);
      const limit = argInt(a.limit, 50, 1, 200);
      const hits = ix.all
        .filter((t) => all || !ix.info(t).closed)
        .filter((t) => {
          const hay = `${t.name ?? ""}\n${t.note ?? ""}\n${ix.tagNames(t.id).join(" ")}`.toLowerCase();
          return terms.every((w) => hay.includes(w));
        })
        .sort((x, y) => Number(ix.info(x).closed) - Number(ix.info(y).closed) || sortByDue(ix)(x, y));
      const extra = hits.length > limit ? `\n…and ${hits.length - limit} more. Narrow the search to see them.` : "";
      return listOut(`Matches for "${a.query}"`, hits.slice(0, limit).map((t) => line(ix, t)), extra);
    },
  },
  {
    name: "list_tags",
    title: "List tags",
    description:
      "Without arguments, list OmniFocus tags with how many remaining items use each. " +
      "With a tag (id or name), list the remaining items that have it or one of its child tags.",
    inputSchema: OBJ({
      tag: { type: "string", description: "Tag id or name to list items for." },
      include_completed: { type: "boolean", description: "Include completed and dropped items (default false)." },
    }),
    run(ix, a) {
      const contexts = Object.values(ix.model.contexts);
      const query = argStr(a.tag, "tag");
      const all = argBool(a.include_completed, false);
      if (!query) {
        const counts = new Map();
        for (const [tid, set] of ix.tagSets) {
          const t = ix.model.tasks[tid];
          if (!t || ix.info(t).closed) continue;
          for (const c of set) counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        const lines = contexts
          .map((c) => ({ c, path: ix.tagPath(c.id) }))
          .sort((x, y) => x.path.localeCompare(y.path))
          .map(({ c, path }) => {
            const bits = [path, `${counts.get(c.id) ?? 0} remaining`];
            if (c.onHold) bits.push("on hold");
            if (c.hidden) bits.push("dropped");
            return `- ${bits.join(" · ")} [id:${c.id}]`;
          });
        return listOut("Tags", lines);
      }
      const tag = resolve(contexts, query, (c) => ix.tagPath(c.id), "tag");
      const under = (id) => {
        const seen = new Set();
        while (id && !seen.has(id)) {
          if (id === tag.id) return true;
          seen.add(id);
          id = ix.model.contexts[id]?.parent;
        }
        return false;
      };
      const items = [];
      for (const [tid, set] of ix.tagSets) {
        const t = ix.model.tasks[tid];
        if (!t || (!all && ix.info(t).closed)) continue;
        if ([...set].some(under)) items.push(t);
      }
      items.sort(sortByDue(ix));
      return listOut(`Items tagged ${ix.tagPath(tag.id)}`, items.map((t) => line(ix, t)));
    },
  },
  {
    name: "get_task",
    title: "Get item",
    description: "Show every detail of one OmniFocus action or project by id, including its full note.",
    inputSchema: OBJ({ id: { type: "string", description: "The id shown as [id:…] in other results." } }, ["id"]),
    run(ix, a) {
      const id = argStr(a.id, "id", true).replace(/^id:/, "");
      const t = ix.model.tasks[id];
      if (!t) throw new UserError(`No item has id ${id}.`);
      const i = ix.info(t);
      const out = [`Name: ${t.name || "(untitled)"} [id:${t.id}]`];
      out.push(`Type: ${i.isProject ? "project" : i.inbox ? "inbox item" : "action"}`);
      let status = i.closed ? closedLabel(ix, t) : "remaining";
      if (!i.closed && i.onHold) status += ", on hold";
      if (!i.closed && i.effStart != null && i.effStart > ix.now) status += ", deferred";
      out.push(`Status: ${status}`);
      if (i.isProject) {
        const path = ix.folderPath(t.project.folder);
        if (path) out.push(`Folder: ${path}`);
      } else if (i.project) out.push(`Project: ${i.project.name} [id:${i.project.id}]`);
      const parents = [];
      for (let p = t.parent && ix.model.tasks[t.parent]; p && !p.project && parents.length < 50; p = p.parent && ix.model.tasks[p.parent]) {
        parents.unshift(p.name || "(untitled)");
      }
      if (parents.length) out.push(`Inside: ${parents.join(" > ")}`);
      const tags = ix.tagNames(t.id);
      if (tags.length) out.push(`Tags: ${tags.join(", ")}`);
      const own = (s) => ix.date(s);
      const dateLine = (label, mine, eff) => {
        if (mine != null) out.push(`${label}: ${ix.fmt(mine)}`);
        else if (eff != null) out.push(`${label}: ${ix.fmt(eff)} (inherited)`);
      };
      dateLine("Defer until", own(t.start), i.effStart);
      dateLine("Due", own(t.due), i.effDue);
      if (own(t.planned) != null) out.push(`Planned: ${ix.fmt(own(t.planned))}`);
      if (t.repeat) out.push(`Repeats: ${t.repeat}`);
      if (t.flagged) out.push("Flagged: yes");
      else if (i.effFlagged) out.push("Flagged: inherited from a parent");
      if (t.estimate) out.push(`Estimate: ${t.estimate} min`);
      if (t.order) out.push(`Order: ${t.order}`);
      for (const [label, key] of [["Added", "added"], ["Modified", "modified"], ["Completed", "completed"], ["Dropped", "hidden"]]) {
        if (t[key]) out.push(`${label}: ${fmtMaybe(ix, t[key])}`);
      }
      const kids = ix.children(t.id);
      if (kids.length) {
        const open = kids.filter((k) => !ix.info(k).closed).length;
        out.push(`Sub-items: ${open} remaining of ${kids.length}`);
      }
      if (t.note) out.push(`Note:\n${t.note}`);
      return out.join("\n");
    },
  },
  {
    name: "sync_status",
    title: "Sync status",
    description: "Show how the connector read the OmniFocus database: file counts, cache use, and item totals.",
    inputSchema: OBJ(),
    run(ix, _a, meta) {
      const remaining = ix.all.filter((t) => !ix.info(t).closed);
      const projects = ix.all.filter((t) => t.project);
      return [
        `Transaction files: ${meta.files.length} (newest ${meta.files.at(-1)})`,
        `Loaded from: ${meta.source}`,
        `Encrypted: ${meta.encrypted ? "yes (decrypted by the connector)" : "no"}`,
        `Model built: ${meta.builtAt}`,
        `Actions: ${ix.all.length - projects.length} (${remaining.filter((t) => !t.project).length} remaining)`,
        `Projects: ${projects.length} (${projects.filter((p) => projectStatus(ix, p) === "active").length} active)`,
        `Tags: ${Object.keys(ix.model.contexts).length}`,
        `Folders: ${Object.keys(ix.model.folders).length}`,
        `Time zone: ${ix.tz}`,
      ].join("\n");
    },
  },
  {
    name: "inspect_sync",
    title: "Inspect sync folder",
    description:
      "Diagnostics: list the raw transaction files, how they chain, the devices' .client records, " +
      "the encryption key types, and raw transaction XML. For troubleshooting the connector.",
    inputSchema: OBJ({
      xml_chars: { type: "integer", minimum: 200, maximum: 50000, description: "Most XML characters to show (default 6000)." },
      find: { type: "string", description: "Instead of the overview, show raw elements (task, context, task-to-tag, …) whose XML matches this regular expression." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "With find: most elements to show (default 3)." },
    }),
    run(_ix, a, _data, { env }) {
      return inspectSync(env, {
        xml_chars: argInt(a.xml_chars, 6000, 200, 50000),
        find: argStr(a.find, "find"),
        limit: argInt(a.limit, 3, 1, 20),
      });
    },
  },
];

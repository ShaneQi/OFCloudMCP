// MCP tools that change the OmniFocus database. Each call writes one
// transaction (see write.js). Without ALLOW_WRITES=true, or with
// dry_run: true, they only show the transaction they would write.
import { UserError } from "./errors.js";
import { OBJ, argStr, argInt, argBool, line } from "./query.js";
import {
  commit, newId, utcStamp, floatingDate, rankAfter, linkRankAfter,
  taskInsertXml, taskUpdateXml, linkInsertXml, linkDeleteXml,
} from "./write.js";

const DRY = { type: "boolean", description: "Only show the transaction that would be written (default false)." };
const DATE = (what) => ({
  type: ["string", "null"],
  description:
    `${what}: "2026-11-20" (uses your default time), "2026-11-20 14:30" (local time), or an ISO time. ` +
    "Empty string or null clears it.",
});

// ---------- lookups (strict: ids or exact names only) ----------
function findTask(model, id) {
  const clean = String(id ?? "").trim().replace(/^\[?id:/, "").replace(/\]$/, "");
  const t = model.tasks[clean];
  if (!t) throw new UserError(`No item has id ${clean}. Use an id shown as [id:…] in other results.`);
  return t;
}

function findProject(ix, query) {
  const q = query.trim();
  const projects = ix.all.filter((t) => t.project && !ix.info(t).closed);
  const byId = projects.find((p) => p.id === q.replace(/^id:/, ""));
  if (byId) return byId;
  const exact = projects.filter((p) => (p.name ?? "").toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new UserError(`Several active projects are named "${q}"; use an id:\n${exact.map((p) => `- ${p.name} [id:${p.id}]`).join("\n")}`);
  }
  throw new UserError(`No active project is named "${q}". Use list_projects to find it.`);
}

function findTags(ix, list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new UserError("Tags must be a list of tag names or ids.");
  const contexts = Object.values(ix.model.contexts);
  const out = [];
  for (const raw of list) {
    const q = String(raw).trim();
    if (!q) continue;
    let c = ix.model.contexts[q.replace(/^id:/, "")];
    if (!c) {
      const lower = q.toLowerCase();
      const byPath = contexts.filter((x) => ix.tagPath(x.id).toLowerCase() === lower);
      const byName = contexts.filter((x) => (x.name ?? "").toLowerCase() === lower);
      const hits = byPath.length ? byPath : byName;
      if (hits.length > 1) {
        throw new UserError(`Several tags are named "${q}"; use an id or the full path:\n${hits.map((x) => `- ${ix.tagPath(x.id)} [id:${x.id}]`).join("\n")}`);
      }
      c = hits[0];
    }
    if (!c) throw new UserError(`No tag is named "${q}". Use list_tags to see tags (this tool does not create tags).`);
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}

const linksOf = (model, taskId) => Object.values(model.taskToTag).filter((l) => l.task === taskId);

function dateArg(a, key, tz, settingTime, label) {
  if (!(key in a)) return undefined;
  return floatingDate(a[key], tz, settingTime, label);
}

function estimateArg(a) {
  if (!("estimated_minutes" in a)) return undefined;
  if (a.estimated_minutes === null || a.estimated_minutes === "") return null;
  const n = Number(a.estimated_minutes);
  if (!Number.isInteger(n) || n < 0) throw new UserError('"estimated_minutes" must be a whole number of minutes.');
  return String(n);
}

const run = (fn) => async (ix, a, _data, { env, ctx }) => fn(ix, a, env, ctx);

function requireAction(t, verb) {
  if (t.project) throw new UserError(`${t.name} is a project; ${verb} projects in OmniFocus itself (this tool handles actions).`);
}

// ---------- tools ----------
export const WRITE_TOOLS = [
  {
    name: "add_task",
    write: true,
    destructive: false,
    title: "Add action",
    description:
      "Add a new action to OmniFocus: to the inbox, or to an active project. Optional note, tags (existing tags " +
      "only), defer/due/planned dates, flag and estimate. Writes to the user's synced database; " +
      "use dry_run to preview.",
    inputSchema: OBJ(
      {
        name: { type: "string", description: "The action's title." },
        note: { type: "string", description: "Plain-text note; new lines become paragraphs." },
        project: { type: "string", description: "Active project id or exact name. Omit for the inbox." },
        tags: { type: "array", items: { type: "string" }, description: "Existing tag names, paths (A : B) or ids." },
        due: DATE("Due date"),
        defer: DATE("Defer (start) date"),
        planned: DATE("Planned date"),
        flagged: { type: "boolean", description: "Flag it (default false)." },
        estimated_minutes: { type: ["integer", "null"], minimum: 0, description: "Estimated duration in minutes." },
        dry_run: DRY,
      },
      ["name"]
    ),
    run: run(async (ix, a, env, ctx) => {
      const name = argStr(a.name, "name", true);
      if (!name) throw new UserError('"name" is required.');
      const note = argStr(a.note, "note");
      const tz = env.TIMEZONE || "America/Chicago";
      const s = ix.model.settings ?? {};
      const due = dateArg(a, "due", tz, s.DefaultDueTime, "due") ?? null;
      const start = dateArg(a, "defer", tz, s.DefaultStartTime, "defer") ?? null;
      const planned = dateArg(a, "planned", tz, s.DefaultPlannedTime, "planned") ?? null;
      const estimate = estimateArg(a) ?? null;
      const flagged = argBool(a.flagged, false);
      const projectQ = argStr(a.project, "project");
      const project = projectQ ? findProject(ix, projectQ) : null;
      const tags = findTags(ix, a.tags);
      const where = project ? `project ${project.name}` : "the inbox";

      return commit(env, ctx, (model, now) => {
        const id = newId();
        const stamp = utcStamp(now);
        const siblings = Object.values(model.tasks).filter((t) =>
          project ? t.parent === project.id : t.inbox && !t.parent && !t.project
        );
        const elements = [
          taskInsertXml({
            id, name, note, inbox: !project, parent: project?.id ?? null, added: stamp, modified: stamp,
            rank: rankAfter(siblings.map((t) => t.rank)), context: tags[0] ?? null,
            start, planned, due, estimate, flagged,
          }),
        ];
        let r = null;
        for (const tag of tags) {
          r = linkRankAfter(r ? [r] : []);
          elements.push(linkInsertXml(id, tag, r, stamp));
        }
        return {
          elements,
          summary: `Add "${name}" to ${where}${tags.length ? ` with tags ${tags.map((t) => ix.tagPath(t)).join(", ")}` : ""}. New id: ${id}`,
          check(m) {
            const t = m.tasks[id];
            if (!t) return "the new action is missing";
            if (t.name !== name) return `name reads back as ${JSON.stringify(t.name)}`;
            if ((t.parent ?? null) !== (project?.id ?? null)) return "it is not in the intended project";
            if (!!t.inbox !== !project) return "its inbox flag is wrong";
            if ((t.due ?? null) !== due || (t.start ?? null) !== start || (t.planned ?? null) !== planned) return "a date reads back differently";
            if ((t.note ?? null) !== (note ? note.replace(/\r\n?/g, "\n").trim() : null)) return "the note reads back differently";
            const got = linksOf(m, id).map((l) => l.context).sort();
            if (got.join() !== [...tags].sort().join()) return "its tags read back differently";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "edit_task",
    write: true,
    destructive: true,
    title: "Edit action or project",
    description:
      "Change an existing OmniFocus action (or a project's name, note, dates, flag, estimate and tags) by id. " +
      "Only the fields given change. Dates and estimate accept null or \"\" to clear. tags replaces all tags; " +
      "add_tags/remove_tags change some. project moves an action (\"inbox\" for the inbox). Use dry_run to preview.",
    inputSchema: OBJ(
      {
        id: { type: "string", description: "The item's id, shown as [id:…]." },
        name: { type: "string" },
        note: { type: ["string", "null"], description: "Replaces the whole note; \"\" or null clears it." },
        due: DATE("Due date"),
        defer: DATE("Defer (start) date"),
        planned: DATE("Planned date"),
        flagged: { type: "boolean" },
        estimated_minutes: { type: ["integer", "null"], minimum: 0 },
        project: { type: "string", description: "Move the action to this active project (id or exact name), or \"inbox\"." },
        tags: { type: "array", items: { type: "string" }, description: "Replace all tags with these." },
        add_tags: { type: "array", items: { type: "string" } },
        remove_tags: { type: "array", items: { type: "string" } },
        dry_run: DRY,
      },
      ["id"]
    ),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      const isProject = !!t.project;
      const tz = env.TIMEZONE || "America/Chicago";
      const s = ix.model.settings ?? {};
      const changes = {};
      const want = {}; // model field -> expected value after the change
      if ("name" in a) {
        const v = argStr(a.name, "name", true);
        changes.name = v;
        want.name = v;
      }
      if ("note" in a) {
        const v = a.note == null ? null : String(a.note);
        changes.note = v || null;
        want.note = v ? v.replace(/\r\n?/g, "\n").trim() || null : null;
      }
      for (const [key, field, setting] of [["due", "due", "DefaultDueTime"], ["defer", "start", "DefaultStartTime"], ["planned", "planned", "DefaultPlannedTime"]]) {
        const v = dateArg(a, key, tz, s[setting], key);
        if (v !== undefined) {
          changes[field] = v;
          want[field] = v;
        }
      }
      if ("flagged" in a) {
        if (typeof a.flagged !== "boolean") throw new UserError('"flagged" must be true or false.');
        changes.flagged = a.flagged ? "true" : "false";
        want.flagged = a.flagged;
      }
      const est = estimateArg(a);
      if (est !== undefined) {
        changes["estimated-minutes"] = est;
        want.estimate = est;
      }
      let move = null;
      if ("project" in a && a.project != null && a.project !== "") {
        if (isProject) throw new UserError("Moving projects is not supported; edit_task moves actions only.");
        const q = argStr(a.project, "project");
        move = q.toLowerCase() === "inbox" ? { inbox: true, parent: null } : { inbox: false, parent: findProject(ix, q).id };
      }

      const current = linksOf(ix.model, t.id);
      let finalTags = current.map((l) => l.context);
      if ("tags" in a) finalTags = findTags(ix, a.tags);
      if ("add_tags" in a) for (const id of findTags(ix, a.add_tags)) if (!finalTags.includes(id)) finalTags.push(id);
      if ("remove_tags" in a) {
        const gone = findTags(ix, a.remove_tags);
        finalTags = finalTags.filter((id) => !gone.includes(id));
      }
      const tagsChanged = finalTags.slice().sort().join() !== current.map((l) => l.context).sort().join();
      if (tagsChanged) {
        const primary = finalTags.includes(t.context) ? t.context : finalTags[0] ?? null;
        changes.context = primary;
        want.context = primary;
      }
      if (!Object.keys(changes).length && !move) throw new UserError("Nothing to change: give at least one field to edit.");

      return commit(env, ctx, (model, now) => {
        const stamp = utcStamp(now);
        const ch = { ...changes };
        if (move) {
          const siblings = Object.values(model.tasks).filter((x) =>
            move.parent ? x.parent === move.parent : x.inbox && !x.parent && !x.project
          );
          Object.assign(ch, { project: null, inbox: move.inbox ? "true" : "false", task: move.parent, rank: String(rankAfter(siblings.map((x) => x.rank))) });
        }
        const elements = [taskUpdateXml(t.id, t.added ?? stamp, stamp, ch, { isProject })];
        if (tagsChanged) {
          const links = linksOf(model, t.id);
          for (const l of links) if (!finalTags.includes(l.context)) elements.push(linkDeleteXml(l.id));
          let ranks = links.filter((l) => finalTags.includes(l.context)).map((l) => l.rankInTask);
          for (const tag of finalTags) {
            if (links.some((l) => l.context === tag)) continue;
            const r = linkRankAfter(ranks);
            ranks = [...ranks, r];
            elements.push(linkInsertXml(t.id, tag, r, stamp));
          }
        }
        const what = [...Object.keys(changes).map((k) => (k === "start" ? "defer" : k === "context" ? "tags" : k)), ...(move ? ["project"] : [])];
        return {
          elements,
          summary: `Edit "${t.name}" [id:${t.id}]: ${[...new Set(what)].join(", ")}.`,
          check(m) {
            const x = m.tasks[t.id];
            if (!x) return "the item is missing";
            for (const [k, v] of Object.entries(want)) {
              const got = k === "flagged" ? !!x.flagged : x[k] ?? null;
              if (got !== v) return `${k} reads back as ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`;
            }
            if (move && ((x.parent ?? null) !== move.parent || !!x.inbox !== move.inbox)) return "it did not move";
            const got = linksOf(m, t.id).map((l) => l.context).sort().join();
            if (got !== finalTags.slice().sort().join()) return "its tags read back differently";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "complete_task",
    write: true,
    destructive: false,
    title: "Complete action",
    description:
      "Mark an OmniFocus action complete by id, or with undo: true mark it incomplete again. " +
      "Repeating actions and projects are not supported (complete those in OmniFocus). Use dry_run to preview.",
    inputSchema: OBJ({ id: { type: "string" }, undo: { type: "boolean", description: "Mark incomplete instead." }, dry_run: DRY }, ["id"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      requireAction(t, "complete");
      const undo = argBool(a.undo, false);
      if (!undo && t.repeat) {
        throw new UserError(`"${t.name}" repeats (${t.repeat}); complete repeating actions in OmniFocus so it can schedule the next one.`);
      }
      if (!undo && t.completed) throw new UserError(`"${t.name}" is already completed.`);
      if (undo && !t.completed) throw new UserError(`"${t.name}" is not completed.`);
      return commit(env, ctx, (_model, now) => {
        const stamp = utcStamp(now);
        const value = undo ? null : stamp;
        return {
          elements: [taskUpdateXml(t.id, t.added ?? stamp, stamp, { completed: value })],
          summary: `${undo ? "Mark incomplete" : "Complete"} "${t.name}" [id:${t.id}].`,
          check: (m) => ((m.tasks[t.id]?.completed ?? null) === value ? null : "completion date reads back differently"),
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "drop_task",
    write: true,
    destructive: false,
    title: "Drop action",
    description:
      "Drop an OmniFocus action by id (it stays in the database as dropped), or with undo: true restore it. " +
      "Projects are not supported. Use dry_run to preview.",
    inputSchema: OBJ({ id: { type: "string" }, undo: { type: "boolean", description: "Restore instead." }, dry_run: DRY }, ["id"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      requireAction(t, "drop");
      const undo = argBool(a.undo, false);
      if (!undo && t.hidden) throw new UserError(`"${t.name}" is already dropped.`);
      if (undo && !t.hidden) throw new UserError(`"${t.name}" is not dropped.`);
      return commit(env, ctx, (_model, now) => {
        const stamp = utcStamp(now);
        const value = undo ? null : stamp;
        return {
          elements: [taskUpdateXml(t.id, t.added ?? stamp, stamp, { hidden: value })],
          summary: `${undo ? "Restore" : "Drop"} "${t.name}" [id:${t.id}].`,
          check: (m) => ((m.tasks[t.id]?.hidden ?? null) === value ? null : "drop date reads back differently"),
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
];

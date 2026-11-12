// MCP tools that change the OmniFocus database. Each call writes one
// transaction (see write.js). Without ALLOW_WRITES=true, or with
// dry_run: true, they only show the transaction they would write.
import { UserError } from "./errors.js";
import { OBJ, argStr, argInt, argBool, line } from "./query.js";
import {
  commit, newId, utcStamp, floatingDate, rankAfter, linkRankAfter, wallParts,
  taskInsertXml, taskUpdateXml, linkInsertXml, linkDeleteXml, taskDeleteXml,
  contextInsertXml, contextUpdateXml, contextDeleteXml, attachmentInsertXml, attachmentDeleteXml, noteWithAttachment, noteWithoutAttachment,
} from "./write.js";
import { zipSync, unzipSync } from "fflate";
import { syncContext, fetchFile } from "./store.js";
import { nextDates, parseFloating, parseRule } from "./repeat.js";

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

const REPEAT_PROPS = {
  repeat_rule: {
    type: ["string", "null"],
    description: 'iCalendar repeat rule, e.g. "FREQ=WEEKLY;BYDAY=MO", "FREQ=MONTHLY;INTERVAL=3", "FREQ=DAILY". null or "" stops repeating.',
  },
  repeat_method: {
    type: "string",
    enum: ["fixed", "due-after-completion", "start-after-completion"],
    description: "fixed: on the schedule; due-/start-after-completion: counted from when it is completed. Default fixed.",
  },
};

// -> undefined (not given), null (stop repeating) or the XML fields to set.
function repeatArgs(a, dates) {
  if (!("repeat_rule" in a) && !("repeat_method" in a)) return undefined;
  const rule = a.repeat_rule == null ? null : String(a.repeat_rule).trim().replace(/^RRULE:/i, "");
  if ("repeat_rule" in a && !rule) {
    return { "repetition-rule": null, "repetition-method": null, "repetition-schedule-type": null, "repetition-anchor-date": null };
  }
  if (!rule) throw new UserError('Give "repeat_rule" along with "repeat_method".');
  parseRule(rule); // refuses rules this connector cannot schedule
  const method = a.repeat_method ?? "fixed";
  if (!["fixed", "due-after-completion", "start-after-completion"].includes(method)) {
    throw new UserError('"repeat_method" must be fixed, due-after-completion or start-after-completion.');
  }
  const anchor = method === "start-after-completion" ? "start" : method === "due-after-completion" ? "due" : dates.due ? "due" : "start";
  if (!dates[anchor]) {
    throw new UserError(`A repeating action needs a ${anchor === "due" ? "due" : "defer"} date to repeat from.`);
  }
  return {
    "repetition-rule": rule,
    "repetition-method": method,
    "repetition-schedule-type": method === "fixed" ? "from-assigned" : "from-completion",
    "repetition-anchor-date": anchor === "due" ? "dateDue" : "dateToStart",
  };
}

const run = (fn) => async (ix, a, _data, { env, ctx }) => fn(ix, a, env, ctx);

function requireAction(t, verb, alternative = "set_project_status") {
  if (t.project) throw new UserError(`${t.name} is a project; to ${verb} a project use ${alternative}.`);
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
        ...REPEAT_PROPS,
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
      const repeat = repeatArgs(a, { due, start }) ?? null;
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
            start, planned, due, estimate, flagged, extra: repeat ?? {},
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
            if ((t.repeat ?? null) !== (repeat?.["repetition-rule"] ?? null)) return "the repeat rule reads back differently";
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
        ...REPEAT_PROPS,
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
      const rep = repeatArgs(a, {
        due: "due" in changes ? changes.due : t.due ?? null,
        start: "start" in changes ? changes.start : t.start ?? null,
      });
      if (rep !== undefined) {
        Object.assign(changes, rep);
        want.repeat = rep["repetition-rule"];
        want.repeatMethod = rep["repetition-method"];
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
        const elements = [taskUpdateXml(t.id, t.added ?? stamp, stamp, ch)];
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
        const what = [...Object.keys(changes).map((k) => (k === "start" ? "defer" : k === "context" ? "tags" : k.startsWith("repetition-") ? "repeat" : k)), ...(move ? ["project"] : [])];
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
      "Mark an OmniFocus action complete by id, or with undo: true mark it incomplete again. For a repeating " +
      "action it does what OmniFocus does: the action is completed and its next occurrence is created with " +
      "dates moved on by the repeat rule. Projects: use set_project_status. Use dry_run to preview.",
    inputSchema: OBJ({ id: { type: "string" }, undo: { type: "boolean", description: "Mark incomplete instead." }, dry_run: DRY }, ["id"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      requireAction(t, "complete", "set_project_status");
      const undo = argBool(a.undo, false);
      if (!undo && t.completed) throw new UserError(`"${t.name}" is already completed.`);
      if (undo && !t.completed) throw new UserError(`"${t.name}" is not completed.`);
      const tz = env.TIMEZONE || "America/Chicago";
      const repeating = !undo && !!t.repeat;
      if (repeating && ix.children(t.id).length) {
        throw new UserError(`"${t.name}" repeats and has sub-actions; complete it in OmniFocus.`);
      }
      return commit(env, ctx, (model, now) => {
        const stamp = utcStamp(now);
        const value = undo ? null : stamp;
        if (!repeating) {
          return {
            elements: [taskUpdateXml(t.id, t.added ?? stamp, stamp, { completed: value })],
            summary: `${undo ? "Mark incomplete" : "Complete"} "${t.name}" [id:${t.id}].`,
            check: (m) => ((m.tasks[t.id]?.completed ?? null) === value ? null : "completion date reads back differently"),
          };
        }
        // Repeating: complete this one; the next occurrence is a copy with id
        // "<id>.<next-clone-identifier>" and the dates moved on.
        const w = wallParts(now, tz);
        const wall = parseFloating(`${w.year}-${w.month}-${w.day}T${w.hour}:${w.minute}:${w.second}`);
        const next = nextDates(t, wall, wall);
        const n = Number.parseInt(t.nextClone ?? "0", 10) || 0;
        const elements = [taskUpdateXml(t.id, t.added ?? stamp, stamp, { completed: stamp, "next-clone-identifier": String(n + 1) })];
        let cloneId = null;
        if (next) {
          cloneId = `${t.id}.${n}`;
          if (model.tasks[cloneId]) throw new UserError(`An item with id ${cloneId} already exists; complete "${t.name}" in OmniFocus.`);
          elements.push(taskInsertXml({
            id: cloneId, name: t.name, noteRaw: t.noteXml ?? null, inbox: !!t.inbox, parent: t.parent ?? null,
            added: stamp, modified: stamp, rank: t.rank ?? 0, context: t.context ?? null,
            start: next.start, planned: next.planned, due: next.due, estimate: t.estimate ?? null,
            flagged: !!t.flagged, order: t.order ?? "parallel",
            extra: {
              "completed-by-children": t.completedByChildren ? "true" : "false",
              "repetition-rule": t.repeat, "repetition-method": t.repeatMethod ?? null,
              "repetition-schedule-type": t.repeatSchedule ?? null, "repetition-anchor-date": t.repeatAnchor ?? null,
              "catch-up-automatically": t.catchUp ? "true" : "false", "next-clone-identifier": "0",
              "due-date-alarm-policy": t.dueAlarm ?? null, "defer-date-alarm-policy": t.deferAlarm ?? null,
              "latest-time-to-start-alarm-policy": t.latestAlarm ?? null, "planned-date-alarm-policy": t.plannedAlarm ?? null,
            },
          }));
          for (const l of linksOf(model, t.id)) elements.push(linkInsertXml(cloneId, l.context, l.rankInTask ?? "0001", stamp));
        }
        const when = next ? [next.start && `defer ${next.start}`, next.due && `due ${next.due}`, next.planned && `planned ${next.planned}`].filter(Boolean).join(", ") : null;
        return {
          elements,
          summary: `Complete repeating "${t.name}" [id:${t.id}] (${t.repeat}, ${t.repeatMethod ?? "fixed"}).` +
            (next ? ` Next occurrence [id:${cloneId}]: ${when}.` : " The repeat has ended, so there is no next occurrence."),
          check(m) {
            if (!m.tasks[t.id]?.completed) return "the action did not read back as completed";
            if (!next) return null;
            const c = m.tasks[cloneId];
            if (!c) return "the next occurrence is missing";
            if (c.completed) return "the next occurrence reads back as completed";
            if ((c.due ?? null) !== next.due || (c.start ?? null) !== next.start) return "the next occurrence's dates read back differently";
            if (c.repeat !== t.repeat) return "the next occurrence lost its repeat rule";
            const tags = (id) => linksOf(m, id).map((l) => l.context).sort().join();
            if (tags(cloneId) !== tags(t.id)) return "the next occurrence's tags differ";
            return null;
          },
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
      "Projects: use set_project_status. Use dry_run to preview.",
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
  {
    name: "add_tag",
    write: true,
    destructive: false,
    title: "Add tag",
    description: "Create a new OmniFocus tag, optionally inside a parent tag. Use dry_run to preview.",
    inputSchema: OBJ({
      name: { type: "string" },
      parent: { type: "string", description: "Parent tag name, path or id (omit for a top-level tag)." },
      on_hold: { type: "boolean", description: "Create it on hold (its actions are not available)." },
      dry_run: DRY,
    }, ["name"]),
    run: run(async (ix, a, env, ctx) => {
      const name = argStr(a.name, "name", true);
      const parent = a.parent ? findTags(ix, [a.parent])[0] : null;
      const clash = Object.values(ix.model.contexts).find((c) => (c.parent ?? null) === parent && (c.name ?? "").toLowerCase() === name.toLowerCase());
      if (clash) throw new UserError(`A tag "${ix.tagPath(clash.id)}" already exists [id:${clash.id}].`);
      return commit(env, ctx, (model, now) => {
        const id = newId();
        const stamp = utcStamp(now);
        const siblings = Object.values(model.contexts).filter((c) => (c.parent ?? null) === parent);
        return {
          elements: [contextInsertXml({ id, parent, name, added: stamp, modified: stamp, rank: rankAfter(siblings.map((c) => c.rank)), onHold: argBool(a.on_hold, false) })],
          summary: `Add tag "${parent ? ix.tagPath(parent) + " : " : ""}${name}". New id: ${id}`,
          check: (m) => (m.contexts[id]?.name === name && (m.contexts[id].parent ?? null) === parent ? null : "the new tag reads back differently"),
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "add_project",
    write: true,
    destructive: false,
    title: "Add project",
    description:
      "Create a new OmniFocus project: parallel, sequential, or a single-action list, optionally in a folder, " +
      "with note, tags, dates and flag. Use add_task to add its actions. Use dry_run to preview.",
    inputSchema: OBJ({
      name: { type: "string" },
      note: { type: "string" },
      folder: { type: "string", description: "Folder name or id (omit for top level)." },
      type: { type: "string", enum: ["parallel", "sequential", "single_actions"], description: "Default parallel." },
      status: { type: "string", enum: ["active", "on_hold"], description: "Default active." },
      tags: { type: "array", items: { type: "string" } },
      due: DATE("Due date"),
      defer: DATE("Defer (start) date"),
      flagged: { type: "boolean" },
      dry_run: DRY,
    }, ["name"]),
    run: run(async (ix, a, env, ctx) => {
      const name = argStr(a.name, "name", true);
      const note = argStr(a.note, "note");
      const type = argStr(a.type, "type") ?? "parallel";
      if (!["parallel", "sequential", "single_actions"].includes(type)) throw new UserError('"type" must be parallel, sequential or single_actions.');
      const status = argStr(a.status, "status") ?? "active";
      if (!["active", "on_hold"].includes(status)) throw new UserError('"status" must be active or on_hold.');
      let folder = null;
      if (a.folder) {
        const q = String(a.folder).trim();
        const folders = Object.values(ix.model.folders).filter((f) => !f.hidden);
        const hits = ix.model.folders[q] ? [ix.model.folders[q]] : folders.filter((f) => ix.folderPath(f.id).toLowerCase() === q.toLowerCase() || (f.name ?? "").toLowerCase() === q.toLowerCase());
        if (hits.length !== 1) throw new UserError(hits.length ? `Several folders match "${q}"; use an id.` : `No folder is named "${q}".`);
        folder = hits[0].id;
      }
      const tz = env.TIMEZONE || "America/Chicago";
      const s = ix.model.settings ?? {};
      const due = dateArg(a, "due", tz, s.DefaultDueTime, "due") ?? null;
      const start = dateArg(a, "defer", tz, s.DefaultStartTime, "defer") ?? null;
      const tags = findTags(ix, a.tags);
      return commit(env, ctx, (model, now) => {
        const id = newId();
        const stamp = utcStamp(now);
        const w = wallParts(now, tz);
        // last review: today at local midnight, in UTC (as OmniFocus stores it)
        const midnight = new Date(Date.UTC(+w.year, +w.month - 1, +w.day)).getTime();
        const offset = Date.UTC(+w.year, +w.month - 1, +w.day, +w.hour, +w.minute, +w.second) - Math.floor(now / 1000) * 1000;
        const lastReview = utcStamp(midnight - offset);
        const block = {
          folder, singleton: type === "single_actions", lastReview, nextReview: null,
          reviewInterval: s.ProjectInfoReviewRepetitionString ?? "@1w", status: status === "on_hold" ? "inactive" : "active",
        };
        const siblings = Object.values(model.tasks).filter((t) => t.project && (t.project.folder ?? null) === folder);
        const elements = [taskInsertXml({
          id, name, note, inbox: false, parent: null, added: stamp, modified: stamp,
          rank: rankAfter(siblings.map((t) => t.rank)), context: tags[0] ?? null, start, due,
          flagged: argBool(a.flagged, false), order: type === "sequential" ? "sequential" : "parallel", project: block,
        })];
        let r = null;
        for (const tag of tags) {
          r = linkRankAfter(r ? [r] : []);
          elements.push(linkInsertXml(id, tag, r, stamp));
        }
        return {
          elements,
          summary: `Add ${type.replace("_", "-")} project "${name}"${folder ? ` in ${ix.folderPath(folder)}` : ""} (${status.replace("_", " ")}). New id: ${id}`,
          check(m) {
            const t = m.tasks[id];
            if (!t?.project) return "the new project is missing or not a project";
            if (t.name !== name || (t.project.folder ?? null) !== folder) return "the new project reads back differently";
            if (t.project.status !== block.status || t.project.singleton !== block.singleton) return "its status or type reads back differently";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "set_project_status",
    write: true,
    destructive: false,
    title: "Set project status",
    description: "Set an OmniFocus project's status by id: active, on_hold, completed or dropped. Use dry_run to preview.",
    inputSchema: OBJ({
      id: { type: "string" },
      status: { type: "string", enum: ["active", "on_hold", "completed", "dropped"] },
      dry_run: DRY,
    }, ["id", "status"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      if (!t.project) throw new UserError(`"${t.name}" is an action, not a project; use complete_task or drop_task.`);
      const status = argStr(a.status, "status", true);
      const xmlStatus = { active: "active", on_hold: "inactive", completed: "done", dropped: "dropped" }[status];
      if (!xmlStatus) throw new UserError('"status" must be active, on_hold, completed or dropped.');
      if (t.project.repeat || t.repeat) {
        if (status === "completed") throw new UserError(`"${t.name}" is a repeating project; complete it in OmniFocus.`);
      }
      return commit(env, ctx, (_model, now) => {
        const stamp = utcStamp(now);
        const completed = status === "completed" ? t.completed ?? stamp : null;
        const hidden = status === "dropped" ? t.hidden ?? stamp : null;
        const block = { ...t.project, status: xmlStatus };
        const ch = { project: block, completed, hidden };
        return {
          elements: [taskUpdateXml(t.id, t.added ?? stamp, stamp, ch)],
          summary: `Set project "${t.name}" [id:${t.id}] to ${status.replace("_", " ")}.`,
          check(m) {
            const x = m.tasks[t.id];
            if (x?.project?.status !== xmlStatus) return "the status reads back differently";
            if ((x.completed ?? null) !== completed || (x.hidden ?? null) !== hidden) return "the completed/dropped dates read back differently";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "delete_task",
    write: true,
    destructive: true,
    title: "Delete action or project",
    description:
      "Permanently delete an OmniFocus action or project by id, with all its sub-actions, tag links and " +
      "attachments. Prefer drop_task or set_project_status (reversible) unless the user asks to delete. " +
      "Use dry_run to preview what would be deleted.",
    inputSchema: OBJ({ id: { type: "string" }, dry_run: DRY }, ["id"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      return commit(env, ctx, (model) => {
        const ids = [];
        const walk = (id) => {
          for (const c of Object.values(model.tasks).filter((x) => x.parent === id)) walk(c.id);
          ids.push(id);
        };
        walk(t.id); // children before parents
        const gone = new Set(ids);
        const links = Object.values(model.taskToTag).filter((l) => gone.has(l.task));
        const atts = Object.values(model.attachments ?? {}).filter((x) => gone.has(x.task));
        const elements = [
          ...links.map((l) => linkDeleteXml(l.id)),
          ...atts.map((x) => attachmentDeleteXml(x.id)),
          ...ids.map(taskDeleteXml),
        ];
        return {
          elements,
          summary: `Delete ${t.project ? "project" : "action"} "${t.name}" [id:${t.id}]` +
            (ids.length > 1 ? ` and ${ids.length - 1} sub-item(s)` : "") +
            (atts.length ? `, ${atts.length} attachment(s)` : "") + ".",
          check(m) {
            if (ids.some((id) => m.tasks[id])) return "an item is still there";
            if (Object.values(m.taskToTag).some((l) => gone.has(l.task))) return "a tag link is still there";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "add_attachment",
    write: true,
    destructive: false,
    title: "Add attachment",
    description:
      "Attach a file to an OmniFocus action or project: give text content, or base64 for binary files. " +
      "It is added at the end of the item's note, where OmniFocus shows attachments. Use dry_run to preview.",
    inputSchema: OBJ({
      id: { type: "string", description: "The action or project id." },
      filename: { type: "string", description: "File name shown in OmniFocus, e.g. notes.txt." },
      text: { type: "string", description: "Text content (UTF-8)." },
      base64: { type: "string", description: "Binary content, base64-encoded (instead of text)." },
      dry_run: DRY,
    }, ["id", "filename"]),
    run: run(async (ix, a, env, ctx) => {
      const t = findTask(ix.model, a.id);
      const filename = argStr(a.filename, "filename", true).replace(/[/\\]/g, "_");
      let bytes;
      if (typeof a.text === "string") bytes = new TextEncoder().encode(a.text);
      else if (typeof a.base64 === "string") {
        try {
          bytes = Uint8Array.from(atob(a.base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
        } catch {
          throw new UserError('"base64" is not valid base64.');
        }
      } else throw new UserError('Give the content as "text" or "base64".');
      if (bytes.length > 10 * 1024 * 1024) throw new UserError("Attachments over 10 MB are not supported here.");
      const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const dataId = `data-${sha}`;
      const zip = zipSync({ [filename]: bytes }, { level: 6 });
      return commit(env, ctx, (_model, now) => {
        const id = newId();
        const stamp = utcStamp(now);
        const note = noteWithAttachment(t.noteXml ?? null, id, filename);
        return {
          uploads: [{ path: `data/${dataId}.zip`, bytes: zip }],
          elements: [
            attachmentInsertXml({ id, task: t.id, name: filename, added: stamp, dataId }),
            taskUpdateXml(t.id, t.added ?? stamp, stamp, { note: { raw: note } }),
          ],
          summary: `Attach "${filename}" (${bytes.length} bytes) to "${t.name}" [id:${t.id}]. New attachment id: ${id}`,
          check: (m) => {
            if (m.attachments?.[id]?.dataId !== dataId || m.attachments[id].task !== t.id) return "the attachment reads back differently";
            if (!(m.tasks[t.id]?.noteXml ?? "").includes(`refid="${id}"`)) return "the note does not show the attachment";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "delete_attachment",
    write: true,
    destructive: true,
    title: "Delete attachment",
    description: "Remove an attachment from its OmniFocus item, by attachment id (see get_task). Use dry_run to preview.",
    inputSchema: OBJ({ id: { type: "string", description: "The attachment id." }, dry_run: DRY }, ["id"]),
    run: run(async (ix, a, env, ctx) => {
      const id = argStr(a.id, "id", true);
      const att = ix.model.attachments?.[id];
      if (!att) throw new UserError(`No attachment has id ${id}.`);
      const owner = ix.model.tasks[att.task];
      return commit(env, ctx, (_model, now) => ({
        elements: [
          attachmentDeleteXml(id),
          ...(owner && (owner.noteXml ?? "").includes(`refid="${id}"`)
            ? [taskUpdateXml(owner.id, owner.added ?? utcStamp(now), utcStamp(now), { note: { raw: noteWithoutAttachment(owner.noteXml, id) } })]
            : []),
        ],
        summary: `Remove attachment "${att.name}" [id:${id}] from "${ix.model.tasks[att.task]?.name ?? att.task}".`,
        check: (m) => (m.attachments?.[id] ? "the attachment is still there"
          : (m.tasks[att.task]?.noteXml ?? "").includes(`refid="${id}"`) ? "the note still shows it" : null),
      }), { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "edit_tag",
    write: true,
    destructive: false,
    title: "Edit tag",
    description:
      "Rename an OmniFocus tag, move it under another tag (parent \"\" for top level), or set its status: " +
      "active, on_hold (its actions are unavailable) or dropped. Use dry_run to preview.",
    inputSchema: OBJ({
      tag: { type: "string", description: "Tag name, path (A : B) or id." },
      name: { type: "string" },
      parent: { type: "string", description: "New parent tag, or \"\" for top level." },
      status: { type: "string", enum: ["active", "on_hold", "dropped"] },
      dry_run: DRY,
    }, ["tag"]),
    run: run(async (ix, a, env, ctx) => {
      const id = findTags(ix, [a.tag])[0];
      if (!id) throw new UserError('"tag" is required.');
      const c = ix.model.contexts[id];
      const changes = {};
      if ("name" in a) changes.name = argStr(a.name, "name", true);
      let parent = c.parent ?? null;
      if ("parent" in a) {
        parent = a.parent ? findTags(ix, [a.parent])[0] : null;
        for (let p = parent; p; p = ix.model.contexts[p]?.parent) {
          if (p === id) throw new UserError("A tag cannot be moved inside itself.");
        }
        changes.context = parent;
      }
      const status = argStr(a.status, "status");
      if (status && !["active", "on_hold", "dropped"].includes(status)) throw new UserError('"status" must be active, on_hold or dropped.');
      if (!Object.keys(changes).length && !status) throw new UserError("Nothing to change: give name, parent or status.");
      return commit(env, ctx, (model, now) => {
        const stamp = utcStamp(now);
        const ch = { ...changes };
        if (status) {
          ch["prohibits-next-action"] = status === "on_hold" ? "true" : "false";
          ch.hidden = status === "dropped" ? c.hidden ?? stamp : null;
        }
        if ("context" in ch && (ch.context ?? null) !== (c.parent ?? null)) {
          ch.rank = String(rankAfter(Object.values(model.contexts).filter((x) => (x.parent ?? null) === parent).map((x) => x.rank)));
        }
        const name = ch.name ?? c.name;
        return {
          elements: [contextUpdateXml(id, c.added ?? stamp, stamp, ch)],
          summary: `Edit tag "${ix.tagPath(id)}" [id:${id}]: ${[...Object.keys(changes).map((k) => (k === "context" ? "parent" : k)), ...(status ? [`status ${status}`] : [])].join(", ")}.`,
          check(m) {
            const x = m.contexts[id];
            if (!x || x.name !== name || (x.parent ?? null) !== parent) return "the tag reads back differently";
            if (status && (!!x.onHold !== (status === "on_hold") || !!x.hidden !== (status === "dropped"))) return "its status reads back differently";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
  {
    name: "delete_tag",
    write: true,
    destructive: true,
    title: "Delete tag",
    description:
      "Permanently delete an OmniFocus tag and the tags inside it. Actions keep existing; they just lose those " +
      "tags. Prefer edit_tag with status dropped unless the user asks to delete. Use dry_run to preview.",
    inputSchema: OBJ({ tag: { type: "string", description: "Tag name, path (A : B) or id." }, dry_run: DRY }, ["tag"]),
    run: run(async (ix, a, env, ctx) => {
      const id = findTags(ix, [a.tag])[0];
      if (!id) throw new UserError('"tag" is required.');
      return commit(env, ctx, (model, now) => {
        const stamp = utcStamp(now);
        const ids = [];
        const walk = (cid) => {
          for (const c of Object.values(model.contexts).filter((x) => x.parent === cid)) walk(c.id);
          ids.push(cid);
        };
        walk(id); // children before parents
        const gone = new Set(ids);
        const links = Object.values(model.taskToTag).filter((l) => gone.has(l.context));
        // Actions whose first tag is going get their next remaining tag (or none) as the first tag.
        const updates = Object.values(model.tasks)
          .filter((t) => t.context && gone.has(t.context))
          .map((t) => {
            const rest = linksOf(model, t.id).filter((l) => !gone.has(l.context)).sort((x, y) => String(x.rankInTask ?? "").localeCompare(String(y.rankInTask ?? "")));
            return { t, primary: rest[0]?.context ?? null };
          });
        const affected = new Set(links.map((l) => l.task));
        return {
          elements: [
            ...links.map((l) => linkDeleteXml(l.id)),
            ...updates.map(({ t, primary }) => taskUpdateXml(t.id, t.added ?? stamp, stamp, { context: primary })),
            ...ids.map(contextDeleteXml),
          ],
          summary: `Delete tag "${ix.tagPath(id)}" [id:${id}]` + (ids.length > 1 ? ` and ${ids.length - 1} tag(s) inside it` : "") +
            `; ${affected.size} item(s) lose it.`,
          check(m) {
            if (ids.some((x) => m.contexts[x])) return "a tag is still there";
            if (Object.values(m.taskToTag).some((l) => gone.has(l.context))) return "an item still has the tag";
            if (Object.values(m.tasks).some((t) => t.context && gone.has(t.context))) return "an item still has it as its first tag";
            return null;
          },
        };
      }, { dryRun: argBool(a.dry_run, false) });
    }),
  },
];

// ---------- reading attachments ----------
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", pdf: "application/pdf" };

export const ATTACHMENT_READ_TOOL = {
  name: "get_attachment",
  title: "Get attachment",
  description:
    "Read an attachment of an OmniFocus item by attachment id (get_task lists them). Text files are returned as " +
    "text and common images as images; other files are described.",
  inputSchema: OBJ({ id: { type: "string", description: "The attachment id." } }, ["id"]),
  async run(ix, a, _data, { env }) {
    const id = argStr(a.id, "id", true);
    const att = ix.model.attachments?.[id];
    if (!att) throw new UserError(`No attachment has id ${id}.`);
    if (!att.dataId) throw new UserError(`Attachment ${att.name} has no stored data.`);
    const { cfg, files, docKey } = await syncContext(env);
    const dir = files.listedUrl.endsWith("/") ? files.listedUrl : files.listedUrl + "/";
    const path = `data/${att.dataId}.zip`;
    const zip = await fetchFile(cfg, new URL(`data/${encodeURIComponent(att.dataId)}.zip`, dir).toString(), path, docKey);
    const entries = unzipSync(zip);
    const [entryName, bytes] = Object.entries(entries)[0] ?? [];
    if (!bytes) throw new UserError(`Attachment ${att.name} is empty.`);
    const name = att.name ?? entryName;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    const header = `Attachment "${name}" [id:${id}] on "${ix.model.tasks[att.task]?.name ?? att.task}", ${bytes.length} bytes.`;
    const mime = MIME[ext];
    if (mime?.startsWith("image/") && bytes.length <= 5 * 1024 * 1024 && ext !== "heic") {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { content: [{ type: "text", text: header }, { type: "image", data: btoa(bin), mimeType: mime }] };
    }
    const text = new TextDecoder("utf-8", { fatal: true });
    try {
      const s = text.decode(bytes);
      if (!/[\u0000-\u0008\u000E-\u001F]/.test(s.slice(0, 4096))) {
        return `${header}\n\n${s.length > 100_000 ? s.slice(0, 100_000) + "\n…(truncated)" : s}`;
      }
    } catch {
      /* binary */
    }
    return `${header} It is a binary file${mime ? ` (${mime})` : ""}, which cannot be shown here.`;
  },
};
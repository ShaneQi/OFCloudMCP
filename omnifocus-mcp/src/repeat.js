// Next occurrence of a repeating OmniFocus action, as OmniFocus would
// schedule it when the action is completed.
//
// Dates are OmniFocus "floating" wall times ("YYYY-MM-DDTHH:MM:SS.000"); all
// arithmetic here is on wall-clock fields (treated as UTC internally), so
// daylight-saving changes do not shift the time of day.
//
// Rules are iCalendar RRULEs as OmniFocus stores them. Supported: FREQ
// (HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY (weekly day lists;
// monthly "2WE" / "-1FR"), BYMONTHDAY, BYMONTH (yearly), UNTIL, WKST.
// Others (COUNT, BYSETPOS, BYHOUR, …) are refused rather than guessed.
//
// Methods (repetition-method):
//   fixed                   next date follows the current one on the schedule
//   due-after-completion    next due = completion date + rule (keeps the time of day)
//   start-after-completion  same, for the defer date
// Other dates move by the same amount as the anchor date.
import { UserError } from "./errors.js";

const DAY = 86_400_000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseFloating(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(s ?? "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) : null;
}
export function formatFloating(ms) {
  return new Date(ms).toISOString().slice(0, 19) + ".000";
}

export function parseRule(rule) {
  const r = { interval: 1, byday: [], bymonthday: [], bymonth: [], until: null, wkst: 1 };
  for (const part of String(rule).split(";")) {
    const [k, v] = part.split("=");
    if (!k) continue;
    switch (k.toUpperCase()) {
      case "FREQ": r.freq = v.toUpperCase(); break;
      case "INTERVAL": r.interval = Math.max(1, parseInt(v, 10) || 1); break;
      case "BYDAY":
        r.byday = v.split(",").map((d) => {
          const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
          if (!m) throw new UserError(`Unsupported BYDAY value "${d}" in repeat rule ${rule}.`);
          return { n: m[1] ? parseInt(m[1], 10) : null, wd: WD[m[2].toUpperCase()] };
        });
        break;
      case "BYMONTHDAY": r.bymonthday = v.split(",").map((x) => parseInt(x, 10)); break;
      case "BYMONTH": r.bymonth = v.split(",").map((x) => parseInt(x, 10)); break;
      case "UNTIL": {
        const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d))?/.exec(v);
        r.until = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)) : null;
        break;
      }
      case "WKST": r.wkst = WD[v.toUpperCase()] ?? 1; break;
      default:
        throw new UserError(`The repeat rule ${rule} uses ${k}, which this connector does not schedule; complete it in OmniFocus.`);
    }
  }
  if (!["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq)) {
    throw new UserError(`The repeat rule ${rule} has an unsupported frequency; complete it in OmniFocus.`);
  }
  return r;
}

const ymd = (ms) => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), tod: ms - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) };
};
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const at = (y, m, d, tod) => Date.UTC(y, m, d) + tod;

// The nth weekday (n>0 from start, n<0 from end) of a month, or null.
function nthWeekday(y, m, wd, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= daysIn(y, m) ? d : null;
  }
  const lastD = daysIn(y, m);
  const lastWd = new Date(Date.UTC(y, m, lastD)).getUTCDay();
  const d = lastD - ((lastWd - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}

// Candidate days of month (y, m) for a monthly rule, sorted.
function monthDays(r, y, m, fallbackDay) {
  const days = new Set();
  for (const md of r.bymonthday) {
    const d = md > 0 ? md : daysIn(y, m) + md + 1;
    if (d >= 1 && d <= daysIn(y, m)) days.add(d);
  }
  for (const b of r.byday) {
    if (b.n != null) {
      const d = nthWeekday(y, m, b.wd, b.n);
      if (d) days.add(d);
    } else {
      for (let d = 1; d <= daysIn(y, m); d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === b.wd) days.add(d);
    }
  }
  if (!r.bymonthday.length && !r.byday.length) days.add(Math.min(fallbackDay, daysIn(y, m)));
  return [...days].sort((a, b) => a - b);
}

// First occurrence strictly after `from`, for a series whose reference date
// is `ref` (its time of day and, for intervals, its position).
export function nextOccurrence(r, ref, from) {
  const R = ymd(ref);
  switch (r.freq) {
    case "HOURLY": {
      const step = r.interval * 3_600_000;
      return ref + Math.max(1, Math.floor((from - ref) / step) + 1) * step;
    }
    case "DAILY": {
      const step = r.interval * DAY;
      return ref + Math.max(1, Math.floor((from - ref) / step) + 1) * step;
    }
    case "WEEKLY": {
      const days = r.byday.length ? r.byday.map((b) => b.wd) : [R.wd];
      // weeks counted from the week (starting WKST) containing ref
      const weekStart = (ms) => {
        const x = ymd(ms);
        return Date.UTC(x.y, x.m, x.d) - ((x.wd - r.wkst + 7) % 7) * DAY;
      };
      const refWeek = weekStart(ref);
      for (let w = 0; w < 2000; w++) {
        const ws = refWeek + w * 7 * DAY;
        if (w % r.interval !== 0) continue;
        const cands = days.map((wd) => ws + ((wd - r.wkst + 7) % 7) * DAY + R.tod).sort((a, b) => a - b);
        const hit = cands.find((c) => c > from && c >= ref);
        if (hit != null && hit > from) return hit;
      }
      break;
    }
    case "MONTHLY": {
      for (let k = 0; k < 2400; k += 1) {
        if (k % r.interval !== 0) continue;
        const y = R.y + Math.floor((R.m + k) / 12);
        const m = (R.m + k) % 12;
        const hit = monthDays(r, y, m, R.d).map((d) => at(y, m, d, R.tod)).find((c) => c > from);
        if (hit != null) return hit;
      }
      break;
    }
    case "YEARLY": {
      for (let k = 0; k < 400; k += r.interval) {
        const y = R.y + k;
        const months = r.bymonth.length ? r.bymonth.map((x) => x - 1) : [R.m];
        for (const m of months.sort((a, b) => a - b)) {
          const days = r.bymonthday.length || r.byday.length ? monthDays(r, y, m, R.d) : [Math.min(R.d, daysIn(y, m))];
          const hit = days.map((d) => at(y, m, d, R.tod)).find((c) => c > from);
          if (hit != null) return hit;
        }
      }
      break;
    }
  }
  throw new UserError("Could not find the next occurrence of this repeat rule.");
}

const FIELD = { dateDue: "due", dateToStart: "start", dateStart: "start", dateDefer: "start", datePlanned: "planned" };

// task: model task with repeat fields; completedWall: completion time as a
// floating wall time (ms). Returns { due, start, planned } (floating strings
// or null) for the next occurrence, or null when the repeat has ended.
export function nextDates(task, completedWall, nowWall = completedWall) {
  const r = parseRule(task.repeat);
  const method = task.repeatMethod ?? "fixed";
  const dates = { due: parseFloating(task.due), start: parseFloating(task.start), planned: parseFloating(task.planned) };
  let anchor;
  if (method === "due-after-completion") anchor = "due";
  else if (method === "start-after-completion") anchor = "start";
  else anchor = FIELD[task.repeatAnchor] ?? null;
  if (!anchor || dates[anchor] == null) anchor = ["due", "start", "planned"].find((k) => dates[k] != null);
  if (!anchor) throw new UserError("This repeating action has no due, defer or planned date to repeat from; complete it in OmniFocus.");

  const ref = dates[anchor];
  let next;
  if (method === "fixed") {
    next = nextOccurrence(r, ref, ref);
    if (task.catchUp) while (next <= nowWall) next = nextOccurrence(r, ref, next);
  } else {
    // From completion: the first occurrence after the completion day, keeping
    // the anchor's time of day; the series restarts at the completion date.
    const c = ymd(completedWall);
    const base = at(c.y, c.m, c.d, ymd(ref).tod);
    next = nextOccurrence(r, base, base);
  }
  if (r.until != null && next > r.until) return null;
  const delta = next - ref;
  const out = {};
  for (const k of ["due", "start", "planned"]) out[k] = dates[k] == null ? null : formatFloating(dates[k] + delta);
  return out;
}

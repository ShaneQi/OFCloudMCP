// Transaction file names: YYYYMMDDHHMMSS=ID+ID+….zip. OmniFocus chains
// transactions: each names the transaction(s) it follows and its own id.
// We read the ids as "parents…, own id last", and check that reading against
// the real folder: every parent must be another transaction's own id.
//
// Nothing here relies on the order of file names. Two linked transactions can
// be written in the same second, and then names sort by the parent id after
// "=", which can put a child before its parent.

const NAME = /^(\d{14})=(.+)\.zip$/;
const ROOT_TS = "00000000000000"; // the compacted base; what it follows is gone

export function parseName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const ids = m[2].split("+");
  return { name, ts: m[1], ids, own: ids.at(-1), parents: ids.slice(0, -1) };
}

const byStamp = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// names: transaction file names, in any order. Returns
// { consistent, heads, problems[], files: parsed[] }.
// files: in the order to apply them: parents before children, and otherwise
//   by timestamp, then file name. A parent is never stamped later than its
//   child in a consistent folder, so this is timestamp order with only the
//   files that share a timestamp arranged by their links. (A link that breaks
//   that rule is reported, and does not move anything.)
// heads: own ids that no file names as a parent.
// consistent: no id appears twice; every parent is in the folder (only the
//   root file, timestamp 00000000000000, may follow something that is gone);
//   no parent is stamped later than its child; parent links form no cycle.
export function analyzeChain(names) {
  const parsed = names.map(parseName).filter(Boolean).sort(byStamp);
  const problems = [];

  const byId = new Map();
  for (const f of parsed) {
    if (byId.has(f.own)) problems.push(`${f.name}: id ${f.own} appears twice (also ${byId.get(f.own).name})`);
    else byId.set(f.own, f);
  }

  const referenced = new Set();
  const children = new Map(); // parent file -> files that follow it
  const waiting = new Map(); // file -> same-second parents not yet placed
  for (const f of parsed) {
    let n = 0;
    for (const p of new Set(f.parents)) {
      referenced.add(p);
      const parent = byId.get(p);
      if (!parent) {
        if (f.ts !== ROOT_TS) problems.push(`${f.name}: parent ${p} is not in the folder`);
        continue;
      }
      if (parent.ts > f.ts) problems.push(`${f.name}: parent ${p} (${parent.name}) has a later timestamp`);
      if (parent.ts !== f.ts) continue; // an earlier parent already sorts first
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(f);
      n++;
    }
    waiting.set(f, n);
  }

  // Parents first; among files that are ready, the earliest stamp, then name.
  const ready = parsed.filter((f) => waiting.get(f) === 0);
  let files = [];
  const insert = (f) => {
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byStamp(ready[mid], f) < 0) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, f);
  };
  while (ready.length) {
    const f = ready.shift();
    files.push(f);
    for (const c of children.get(f) ?? []) {
      const n = waiting.get(c) - 1;
      waiting.set(c, n);
      if (n === 0) insert(c);
    }
  }
  if (files.length < parsed.length) {
    // Whatever is left follows itself, directly or through other files. (A
    // loop through files with different stamps has a later-stamped parent,
    // reported above.) There is no right order then; fall back to name order.
    const placed = new Set(files);
    const stuck = parsed.filter((f) => !placed.has(f));
    const inLoop = stuck.find((f) => follows(f, f, byId)) ?? stuck[0];
    problems.push(`${inLoop.name}: its parent links form a cycle`);
    files = parsed;
  }

  const heads = files.filter((f) => !referenced.has(f.own)).map((f) => f.own);
  return { consistent: problems.length === 0, heads, problems, files };
}

// Is `target` among the ancestors of `start`?
function follows(start, target, byId) {
  const seen = new Set();
  const stack = [...start.parents];
  while (stack.length) {
    const f = byId.get(stack.pop());
    if (!f || seen.has(f)) continue;
    if (f === target) return true;
    seen.add(f);
    stack.push(...f.parents);
  }
  return false;
}

// Same analysis with the opposite reading (own id first, then parents), to
// show which reading the real folder supports.
export function analyzeChainOwnFirst(names) {
  const flipped = names.map((n) => {
    const p = parseName(n);
    if (!p) return n;
    return `${p.ts}=${[...p.ids.slice(1), p.ids[0]].join("+")}.zip`;
  });
  return analyzeChain(flipped);
}

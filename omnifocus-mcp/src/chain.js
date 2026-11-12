// Transaction file names: YYYYMMDDHHMMSS=ID+ID+….zip. OmniFocus chains
// transactions: each names the transaction(s) it follows and its own id.
// We read the ids as "parents…, own id last", and check that reading against
// the real folder: every parent must be an earlier transaction's own id.

const NAME = /^(\d{14})=(.+)\.zip$/;

export function parseName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const ids = m[2].split("+");
  return { name, ts: m[1], ids, own: ids.at(-1), parents: ids.slice(0, -1) };
}

// names: sorted transaction file names. Returns
// { consistent, heads, problems[], files: parsed[] }.
// consistent: every parent is the own id of an earlier file, except the
// first file's parents (whatever came before the last compaction).
export function analyzeChain(names) {
  const files = names.map(parseName).filter(Boolean);
  const own = new Set();
  const referenced = new Set();
  const problems = [];
  files.forEach((f, i) => {
    for (const p of f.parents) {
      referenced.add(p);
      if (!own.has(p) && i > 0) problems.push(`${f.name}: parent ${p} is not an earlier transaction`);
    }
    if (own.has(f.own)) problems.push(`${f.name}: id ${f.own} appears twice`);
    own.add(f.own);
  });
  const heads = files.filter((f) => !referenced.has(f.own)).map((f) => f.own);
  return { consistent: problems.length === 0, heads, problems, files };
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

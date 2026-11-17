import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import worker from "../src/index.js";
import { resetCache } from "../src/store.js";
import { analyzeChain } from "../src/chain.js";
import { ACCESS_ENV, TOKEN } from "./helpers/access.js";

// From a real folder: two linked transactions written in the same second.
// Sorted by name, the child (…=fj8AGWkX5eB+dFGf2bLIWa7) comes before its parent.
const CHILD = "20261116110502=fj8AGWkX5eB+dFGf2bLIWa7.zip";
const PARENT = "20261116110502=mC1ZxDRACes+fj8AGWkX5eB.zip";
const NEXT = "20261116110503=dFGf2bLIWa7+dCoj9WHHVus.zip";
const ROOT = "00000000000000=gone+mC1ZxDRACes.zip";
const order = (names) => analyzeChain(names).files.map((f) => f.name);

test("a child that sorts before its same-second parent is consistent", () => {
  const names = [ROOT, CHILD, PARENT, NEXT];
  assert.deepEqual([...names].sort(), names); // the order that used to fail
  const c = analyzeChain(names);
  assert.deepEqual(c.problems, []);
  assert.equal(c.consistent, true);
  assert.deepEqual(c.heads, ["dCoj9WHHVus"]);
  assert.deepEqual(order(names), [ROOT, PARENT, CHILD, NEXT]);
  // the same whatever order the names arrive in
  assert.deepEqual(analyzeChain([NEXT, PARENT, ROOT, CHILD]), c);
});

test("the other same-second pair, where the parent happens to sort first", () => {
  const c = analyzeChain([
    "00000000000000=gone+dBWER_yN6Ok.zip",
    "20261116033229=dBWER_yN6Ok+iE3gwZk4AGj.zip",
    "20261116033229=iE3gwZk4AGj+f4imJhUrvrT.zip",
  ]);
  assert.equal(c.consistent, true);
  assert.deepEqual(c.heads, ["f4imJhUrvrT"]);
});

test("a parent that is not in the folder still fails", () => {
  // without the root file, mC1ZxDRACes is missing
  const c = analyzeChain([CHILD, PARENT, NEXT]);
  assert.equal(c.consistent, false);
  assert.deepEqual(c.problems, [`${PARENT}: parent mC1ZxDRACes is not in the folder`]);

  const d = analyzeChain([ROOT, PARENT, CHILD, "20261116110504=nowhere+zzz.zip"]);
  assert.equal(d.consistent, false);
  assert.match(d.problems[0], /20261116110504=nowhere\+zzz\.zip: parent nowhere is not in the folder/);
});

test("only the root file may follow something that is gone", () => {
  assert.equal(analyzeChain([ROOT]).consistent, true);
  assert.equal(analyzeChain(["20261101000000=aaa.zip", "20261102000000=aaa+bbb.zip"]).consistent, true); // no parent at all
  assert.equal(analyzeChain(["20261101000000=gone+aaa.zip", "20261102000000=aaa+bbb.zip"]).consistent, false);
});

test("a parent with a later timestamp still fails", () => {
  const c = analyzeChain([ROOT, "20261116110503=mC1ZxDRACes+fj8AGWkX5eB.zip", CHILD]);
  assert.equal(c.consistent, false);
  assert.deepEqual(c.problems, [`${CHILD}: parent fj8AGWkX5eB (20261116110503=mC1ZxDRACes+fj8AGWkX5eB.zip) has a later timestamp`]);
});

test("a merge with two parents, one sharing its timestamp, is consistent", () => {
  const names = [
    ROOT,
    "20261116110501=mC1ZxDRACes+sideBranch1.zip",
    "20261116110502=fj8AGWkX5eB+sideBranch1+aMergeOfTwo.zip", // sorts before its parent fj8AGWkX5eB
    PARENT,
    "20261116110503=aMergeOfTwo+dCoj9WHHVus.zip",
  ];
  const c = analyzeChain(names);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.heads, ["dCoj9WHHVus"]);
  assert.deepEqual(order(names), [names[0], names[1], names[3], names[2], names[4]]);
});

test("heads, repeated ids and cycles", () => {
  const fork = analyzeChain([ROOT, PARENT, CHILD, "20261116110502=fj8AGWkX5eB+otherBranch.zip"]);
  assert.equal(fork.consistent, true);
  assert.deepEqual(fork.heads, ["dFGf2bLIWa7", "otherBranch"]);

  const twice = analyzeChain([ROOT, PARENT, "20261116110509=mC1ZxDRACes+fj8AGWkX5eB.zip"]);
  assert.equal(twice.consistent, false);
  assert.match(twice.problems[0], /id fj8AGWkX5eB appears twice/);

  const loop = analyzeChain([ROOT, "20261116110502=b+a.zip", "20261116110502=a+b.zip", "20261116110503=b+c.zip"]);
  assert.equal(loop.consistent, false);
  assert.match(loop.problems.join("\n"), /20261116110502=(a\+b|b\+a)\.zip: its parent links form a cycle/);
  assert.equal(loop.files.length, 4); // nothing dropped
  assert.equal(analyzeChain(["20261116110502=a+a.zip"]).consistent, false);
  const longLoop = analyzeChain(["20261116110501=c+a.zip", "20261116110502=a+b.zip", "20261116110503=b+c.zip"]);
  assert.equal(longLoop.consistent, false);
  assert.match(longLoop.problems[0], /parent c .* has a later timestamp/);
});

test("a broken link does not reshuffle the files", () => {
  // read with the ids the wrong way round, every parent is stamped later
  const names = ["20261101000000=aaa.zip", "20261102000000=bbb+aaa.zip", "20261103000000=ccc+bbb.zip"];
  const c = analyzeChain(names);
  assert.equal(c.consistent, false);
  assert.deepEqual(c.files.map((f) => f.name), names);
});

test("unrelated files keep timestamp, then name, order", () => {
  const names = [ROOT, "20261116110502=mC1ZxDRACes+y.zip", "20261116110502=mC1ZxDRACes+x.zip", "20261116110501=mC1ZxDRACes+z.zip"];
  assert.deepEqual(order(names), [ROOT, names[3], names[2], names[1]]);
});

// ---------- through the server ----------
const NS = 'xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2"';
const zip = (body) => zipSync({ "contents.xml": strToU8(`<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<omnifocus ${NS} app-id="com.omnigroup.OmniFocus4">\n${body}\n</omnifocus>`) });
const FILES = {
  [ROOT]: zip('<task id="t1"><task/><project/><inbox>true</inbox><name>Original</name><added>2026-11-01T00:00:00.000Z</added><modified>2026-11-01T00:00:00.000Z</modified></task>'),
  // sorts first, but updates the task its same-second parent inserts
  [CHILD]: zip('<task id="t2" op="update"><added>2026-11-16T11:05:02.100Z</added><modified>2026-11-16T11:05:02.900Z</modified><name>Renamed</name></task>'),
  [PARENT]: zip('<task id="t2"><task/><project/><inbox>true</inbox><name>Created</name><added>2026-11-16T11:05:02.100Z</added><modified>2026-11-16T11:05:02.100Z</modified></task>'),
  [NEXT]: zip('<task id="t1" op="update"><added>2026-11-01T00:00:00.000Z</added><modified>2026-11-16T11:05:03.000Z</modified><flagged>true</flagged></task>'),
};
let puts;
function installDav() {
  puts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "PROPFIND") {
      const entries = ["", ...Object.keys(FILES).map(encodeURIComponent)].map((n) => `<d:response><d:href>/dav/OmniFocus.ofocus/${n}</d:href></d:response>`);
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207 });
    }
    if (init.method && init.method !== "GET") puts++;
    const name = decodeURIComponent(String(url).split("/").pop());
    return FILES[name] ? new Response(FILES[name]) : new Response("missing", { status: 404 });
  };
}
const ENV = {
  OFOCUS_URL: "https://dav.example.com/dav/OmniFocus.ofocus", WEBDAV_USER: "u", WEBDAV_PASS: "pw",
  ...ACCESS_ENV, TIMEZONE: "America/Chicago", ALLOW_WRITES: "true",
};
async function call(name, args = {}) {
  const res = await worker.fetch(new Request("https://w.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), ENV, { waitUntil() {} });
  return (await res.json()).result.content[0].text;
}

test("same-second transactions are applied parent first", async () => {
  resetCache();
  installDav();
  const inbox = await call("list_inbox");
  assert.match(inbox, /Renamed/);
  assert.doesNotMatch(inbox, /Created/);
  assert.match(await call("sync_status"), /Transaction files: 4 \(newest 20261116110503=dFGf2bLIWa7\+dCoj9WHHVus\.zip\)/);
});

test("a write chains after the head of a folder with same-second links", async () => {
  resetCache();
  installDav();
  const text = await call("edit_task", { id: "t2", name: "Again", dry_run: true });
  assert.match(text, /^DRY RUN/, text);
  assert.match(text, /Transaction: \d{14}=dCoj9WHHVus\+[\w-]{11}\.zip/);
  assert.equal(puts, 0);
});

test("inspect_sync lists every file name, or those matching a filter", async () => {
  resetCache();
  installDav();
  for (let i = 0; i < 20; i++) FILES[`202611161106${String(i).padStart(2, "0")}=${i ? `n${i - 1}` : "dCoj9WHHVus"}+n${i}.zip`] = FILES[NEXT];
  try {
    const brief = await call("inspect_sync", { xml_chars: 200 });
    assert.match(brief, /Transaction files: 24\n  \(… 9 applied earlier; all_files: true lists them\)/);
    assert.doesNotMatch(brief, /  20261116110502=/);
    assert.match(brief, /parents…\+own id:\n  consistent: true; heads: n19/);

    const all = await call("inspect_sync", { xml_chars: 200, all_files: true });
    assert.ok(all.includes(`Transaction files: 24\n  ${ROOT}\n  ${PARENT}\n  ${CHILD}\n  ${NEXT}\n`), all);
    assert.match(all, /Applied in a different order than the names sort \(2 file\(s\)/);

    const some = await call("inspect_sync", { xml_chars: 200, name_filter: "20261116110502" });
    assert.ok(some.includes(`  2 with "20261116110502" in the name, in the order applied:\n  ${PARENT}\n  ${CHILD}\n  Applied in a different order`), some);
  } finally {
    for (const n of Object.keys(FILES)) if (/=n\d+\.zip$|\+n\d+\.zip$/.test(n)) delete FILES[n];
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import worker from "../src/index.js";
import { resetCache } from "../src/store.js";
import { floatingDate, linkRankAfter, rankAfter } from "../src/write.js";

// In-memory WebDAV folder holding the encrypted fixture database (password "pw").
const FIXTURE = new URL("./fixtures/encrypted.ofocus/", import.meta.url);
let files;
let log;
function installDav() {
  files = {};
  for (const n of readdirSync(FIXTURE)) files[n] = new Uint8Array(readFileSync(new URL(n, FIXTURE)));
  log = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop());
    log.push(`${method} ${name}`);
    if (method === "PROPFIND") {
      const entries = ["<d:response><d:href>/dav/OmniFocus.ofocus/</d:href></d:response>"].concat(
        Object.keys(files).map((n) => `<d:response><d:href>/dav/OmniFocus.ofocus/${encodeURIComponent(n)}</d:href></d:response>`)
      );
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207 });
    }
    if (method === "PUT") {
      if (init.headers["If-None-Match"] === "*" && files[name]) return new Response("", { status: 412 });
      files[name] = new Uint8Array(init.body);
      return new Response("", { status: 201 });
    }
    if (method === "MOVE") {
      const dest = decodeURIComponent(new URL(init.headers.Destination).pathname.split("/").pop());
      if (!files[name]) return new Response("", { status: 404 });
      if (init.headers.Overwrite === "F" && files[dest]) return new Response("", { status: 412 });
      files[dest] = files[name];
      delete files[name];
      return new Response("", { status: 201 });
    }
    if (method === "DELETE") {
      delete files[name];
      return new Response("", { status: 204 });
    }
    return files[name] ? new Response(files[name]) : new Response("missing", { status: 404 });
  };
}

const BASE_ENV = {
  OFOCUS_URL: "https://dav.example.com/dav/OmniFocus.ofocus",
  WEBDAV_USER: "u", WEBDAV_PASS: "pw", ACCESS_TOKEN: "t", TIMEZONE: "America/Chicago",
};
const ON = { ...BASE_ENV, ALLOW_WRITES: "true" };
const ctx = { waitUntil() {} };

async function call(env, name, args = {}) {
  const res = await worker.fetch(new Request("https://w.example/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env, ctx);
  const r = (await res.json()).result;
  return { text: r.content[0].text, isError: !!r.isError };
}
const newFiles = () => Object.keys(files).filter((n) => !readdirSync(FIXTURE).includes(n));

test("date and rank helpers", () => {
  assert.equal(floatingDate("2026-11-20", "America/Chicago", "23:59:00", "due"), "2026-11-20T23:59:00.000");
  assert.equal(floatingDate("2026-11-20 14:30", "America/Chicago", null, "due"), "2026-11-20T14:30:00.000");
  assert.equal(floatingDate("2026-11-20T20:30:00Z", "America/Chicago", null, "due"), "2026-11-20T14:30:00.000");
  assert.equal(floatingDate("", "America/Chicago", null, "due"), null);
  assert.throws(() => floatingDate("next friday", "America/Chicago", null, "due"), /must look like/);
  assert.equal(linkRankAfter([]), "0001");
  assert.equal(linkRankAfter(["0001", "aeba"]), "aebb");
  assert.equal(linkRankAfter(["az"]), "az1");
  assert.equal(rankAfter([]), 0);
  assert.equal(rankAfter(["-5", "10"]), 65546);
  assert.ok(rankAfter(["2147483600"]) <= 2147483647);
});

test("without ALLOW_WRITES the write tools only preview", async () => {
  resetCache();
  installDav();
  const r = await call(BASE_ENV, "add_task", { name: "Test" });
  assert.match(r.text, /^NOT WRITTEN: writing is disabled/);
  assert.match(r.text, /<name>Test<\/name>/);
  assert.deepEqual(newFiles(), []);
  assert.ok(!log.some((l) => /^(PUT|MOVE|DELETE)/.test(l)));
});

test("dry_run previews even when writing is on", async () => {
  resetCache();
  installDav();
  const r = await call(ON, "add_task", { name: "Test", dry_run: true });
  assert.match(r.text, /^DRY RUN/);
  assert.match(r.text, /Transaction: \d{14}=ccc\+[A-Za-z0-9_-]{11}\.zip \(encrypted\)/);
  assert.deepEqual(newFiles(), []);
});

test("add_task writes one encrypted transaction that reads back", async () => {
  resetCache();
  installDav();
  const r = await call(ON, "add_task", {
    name: "Buy <brake> pads & cable", note: "Shop A\n\nor Shop B", project: "Bike",
    tags: ["Errands"], due: "2026-11-20", defer: "2026-11-18 08:00", flagged: true, estimated_minutes: 30,
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Done\./);
  const added = newFiles();
  assert.equal(added.length, 1, "one new file, no temp file left behind");
  assert.match(added[0], /^\d{14}=ccc\+[A-Za-z0-9_-]{11}\.zip$/);
  assert.ok(log.some((l) => /^PUT .*-write-in-progress-/.test(l)) && log.some((l) => /^MOVE /.test(l)));

  const id = /New id: ([A-Za-z0-9_-]{11})/.exec(r.text)[1];
  const detail = (await call(ON, "get_task", { id })).text;
  assert.match(detail, /Name: Buy <brake> pads & cable/);
  assert.match(detail, /Project: Bike/);
  assert.match(detail, /Tags: Errands/);
  assert.match(detail, /Due: Fri, Nov 20, 2026, 5:00 PM/); // fixture has no DefaultDueTime: 17:00
  assert.match(detail, /Defer until: Wed, Nov 18, 2026, 8:00 AM/);
  assert.match(detail, /Flagged: yes/);
  assert.match(detail, /Estimate: 30 min/);
  assert.match(detail, /Note:\nShop A\n\nor Shop B/);

  // A fresh instance (no cache) sees it too, and an independent decryptor
  // written from Omni's spec accepts the file.
  resetCache();
  assert.match((await call(ON, "get_project", { project: "Bike" })).text, /Buy <brake> pads & cable · due/);
  const dir = mkdtempSync(join(tmpdir(), "ofw-"));
  writeFileSync(join(dir, "t.zip"), files[added[0]]);
  const py = spawnSync("python3", ["-I", new URL("./fixtures/decrypt_ofocus.py", import.meta.url).pathname,
    new URL("encrypted", FIXTURE).pathname, "pw", join(dir, "t.zip")], { encoding: "utf8" });
  if (py.status === 0) {
    assert.match(py.stdout, /^OK t\.zip/);
    console.log("# independent decryptor:", py.stdout.trim());
  }
  else if (!/No module named|not found|ENOENT/.test(py.stderr + (py.error?.message ?? ""))) assert.fail(py.stderr);
});

test("edit_task, complete_task and drop_task", async () => {
  resetCache();
  installDav();
  const id = /New id: (\S+)/.exec((await call(ON, "add_task", { name: "Draft", tags: ["Errands"], due: "2026-11-20" })).text)[1];

  let r = await call(ON, "edit_task", { id, name: "Final", due: null, project: "Bike", tags: [], note: "n" });
  assert.match(r.text, /^Done\./, r.text);
  let d = (await call(ON, "get_task", { id })).text;
  assert.match(d, /Name: Final/);
  assert.match(d, /Project: Bike/);
  assert.doesNotMatch(d, /Tags:/);
  assert.match(d, /Due: .*\(inherited\)/); // own due cleared; the project's due date applies

  r = await call(ON, "edit_task", { id, add_tags: ["Errands"], project: "inbox" });
  assert.match(r.text, /^Done\./, r.text);
  d = (await call(ON, "get_task", { id })).text;
  assert.match(d, /Type: inbox item/);
  assert.match(d, /Tags: Errands/);

  assert.match((await call(ON, "complete_task", { id })).text, /^Done\./);
  assert.match((await call(ON, "get_task", { id })).text, /Status: completed/);
  assert.match((await call(ON, "complete_task", { id })).text, /already completed/);
  assert.match((await call(ON, "complete_task", { id, undo: true })).text, /^Done\./);
  assert.match((await call(ON, "drop_task", { id })).text, /^Done\./);
  assert.match((await call(ON, "get_task", { id })).text, /Status: dropped/);
  assert.match((await call(ON, "drop_task", { id, undo: true })).text, /^Done\./);
  assert.match((await call(ON, "get_task", { id })).text, /Status: remaining/);

  // Each write chained after the previous one.
  const names = newFiles().sort();
  assert.equal(names.length, 7);
  for (let i = 1; i < names.length; i++) {
    const prevOwn = names[i - 1].replace(/\.zip$/, "").split("+").at(-1);
    assert.equal(names[i].split("=")[1].split("+")[0], prevOwn);
  }

  assert.match((await call(ON, "edit_task", { id })).text, /Nothing to change/);
  assert.match((await call(ON, "complete_task", { id: "p1" })).text, /is a project/);
  assert.match((await call(ON, "add_task", { name: "x", tags: ["Nope"] })).text, /No tag is named "Nope"/);
  assert.match((await call(ON, "add_task", { name: "x", project: "Nope" })).text, /No active project/);
});

test("refuses to write when the sync chain has two heads", async () => {
  resetCache();
  installDav();
  files["20990101000000=bbb+zzz.zip"] = files["20261103000000=bbb+ccc.zip"]; // a fork from bbb
  const r = await call(ON, "add_task", { name: "x" });
  assert.match(r.text, /2 unmerged sync branches/);
  assert.ok(!log.some((l) => /^(PUT|MOVE)/.test(l)));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import worker from "../src/index.js";
import { resetCache } from "../src/store.js";
import { parseDate } from "../src/query.js";

const NS = 'xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2"';
const doc = (body) => `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<omnifocus ${NS} app-id="com.omnigroup.OmniFocus4">\n${body}\n</omnifocus>`;

const BASE = doc(`
  <folder id="f1"><folder/><name>Home</name><rank>1</rank></folder>
  <context id="c1"><context/><name>Errands</name></context>
  <context id="c2"><context idref="c1"/><name>Hardware store</name></context>
  <task id="p1"><task/><project><folder idref="f1"/><singleton>false</singleton><status>active</status></project>
    <name>Fix bike</name>
    <note><text><p><run><lit>Check </lit></run><run><style><value key="font-weight">bold</value></style><lit>brakes</lit></run></p><p><run><lit>and tires &amp; chain</lit></run></p></text></note>
    <due>2026-11-14T23:00:00.000Z</due><flagged>false</flagged></task>
  <task id="t1"><task idref="p1"/><project/><name>Buy tube</name><context idref="c2"/><due/><flagged>true</flagged><rank>1</rank></task>
  <task id="t2"><task idref="p1"/><project/><name>Pump tires</name><rank>2</rank><completed>2026-11-01T10:00:00.000Z</completed></task>
  <task id="t3"><task idref="p1"/><project/><name>Oil chain</name><rank>3</rank></task>
  <task id="i1"><task/><project/><inbox>true</inbox><name>Call dentist</name><added>2026-11-05T15:00:00.000Z</added><due>2026-11-13T17:00:00.000</due></task>
  <task id="p2"><task/><project><folder idref="f1"/><status>inactive</status></project><name>Paint fence</name></task>
`);

const UPDATE = doc(`
  <task id="t1" op="update"><name>Buy inner tube</name></task>
  <task id="t2" op="delete"/>
  <task-to-tag id="l1"><task idref="i1"/><context idref="c1"/></task-to-tag>
`);

const LATER = doc(`<task id="i2"><task/><project/><inbox>true</inbox><name>Renew passport</name><added>2026-11-06T15:00:00.000Z</added></task>`);

const zip = (xml) => zipSync({ "contents.xml": strToU8(xml) });

let files;
let gets;
function installFakeDav() {
  gets = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    assert.equal(init.headers.Authorization, "Basic " + btoa("shane:pw"));
    if (init.method === "PROPFIND") {
      const entries = ["<d:response><d:href>/dav/OmniFocus.ofocus/</d:href></d:response>"]
        .concat(Object.keys(files).map((n) => `<d:response><d:href>/dav/OmniFocus.ofocus/${n.replace("=", "%3D")}</d:href></d:response>`))
        .concat(["<d:response><d:href>/dav/OmniFocus.ofocus/abc.client</d:href></d:response>"]);
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207 });
    }
    const name = decodeURIComponent(u.split("/").pop());
    gets.push(name);
    return files[name] ? new Response(files[name]) : new Response("missing", { status: 404 });
  };
}

const ENV = {
  OFOCUS_URL: "https://dav.example.com/dav/OmniFocus.ofocus",
  WEBDAV_USER: "shane",
  WEBDAV_PASS: "pw",
  ACCESS_TOKEN: "secret-token",
  TIMEZONE: "America/Chicago",
};
const ctx = { waitUntil() {} };

async function rpc(method, params, token = "secret-token") {
  const req = new Request("https://w.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await worker.fetch(req, ENV, ctx);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
const call = async (name, args = {}) => {
  const { body } = await rpc("tools/call", { name, arguments: args });
  return body.result;
};

test("floating dates use the configured time zone", () => {
  assert.equal(new Date(parseDate("2026-11-13T17:00:00.000", "America/Chicago")).toISOString(), "2026-11-13T23:00:00.000Z");
  assert.equal(new Date(parseDate("2026-07-01T09:00:00", "America/Chicago")).toISOString(), "2026-07-01T14:00:00.000Z");
});

test("rejects a wrong token", async () => {
  const { status } = await rpc("ping", {}, "nope");
  assert.equal(status, 401);
});

test("initialize and tools/list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  const list = await rpc("tools/list", {});
  const names = list.body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_inbox", "list_due", "list_flagged", "list_projects", "get_project", "search_tasks", "list_tags", "get_task", "sync_status", "inspect_sync", "get_attachment", "add_task", "edit_task", "complete_task", "drop_task", "add_tag", "add_project", "set_project_status", "delete_task", "add_attachment", "delete_attachment"]);
  const writers = names.slice(names.indexOf("add_task"));
  assert.ok(list.body.result.tools.filter((t) => !writers.includes(t.name)).every((t) => t.annotations.readOnlyHint));
  assert.ok(list.body.result.tools.filter((t) => writers.includes(t.name)).every((t) => t.annotations.readOnlyHint === false));
});

test("replays transactions and answers queries", async () => {
  resetCache();
  files = { "20261101000000=aaa.zip": zip(BASE), "20261102000000=bbb+aaa.zip": zip(UPDATE) };
  installFakeDav();

  const inbox = await call("list_inbox");
  assert.match(inbox.content[0].text, /Call dentist/);
  assert.match(inbox.content[0].text, /tags: Errands/);
  assert.equal(gets.length, 2);

  const project = (await call("get_project", { project: "bike" })).content[0].text;
  assert.match(project, /Folder: Home/);
  assert.match(project, /Check brakes\nand tires & chain/);
  assert.match(project, /Buy inner tube · flagged · tags: Hardware store/);
  assert.doesNotMatch(project, /Pump tires/); // deleted in the update
  assert.ok(project.indexOf("Buy inner tube") < project.indexOf("Oil chain"));

  const flagged = (await call("list_flagged")).content[0].text;
  assert.match(flagged, /Buy inner tube · in Fix bike/);

  const projects = (await call("list_projects")).content[0].text;
  assert.match(projects, /Home \/ Fix bike · active · 2 remaining/);
  assert.doesNotMatch(projects, /Paint fence/);
  assert.match((await call("list_projects", { status: "on_hold" })).content[0].text, /Paint fence · on hold/);

  const tagged = (await call("list_tags", { tag: "Errands" })).content[0].text;
  assert.match(tagged, /Call dentist/);
  assert.match(tagged, /Buy inner tube/); // via child tag

  const task = (await call("get_task", { id: "t1" })).content[0].text;
  assert.match(task, /Project: Fix bike/);
  assert.match(task, /Due: .*Nov 14, 2026.* \(inherited\)/);

  const search = (await call("search_tasks", { query: "chain" })).content[0].text;
  assert.match(search, /Fix bike/);
  assert.match(search, /Oil chain/);

  assert.equal(gets.length, 2, "later calls reuse the cached model");
});

test("downloads only new transaction files", async () => {
  files["20261103000000=ccc+bbb.zip"] = zip(LATER);
  gets = [];
  const inbox = (await call("list_inbox")).content[0].text;
  assert.match(inbox, /Renew passport/);
  assert.deepEqual(gets, ["20261103000000=ccc+bbb.zip"]);
  const status = (await call("sync_status")).content[0].text;
  assert.match(status, /Transaction files: 3/);
});

test("rebuilds after OmniFocus compacts the database", async () => {
  files = { "20261104000000=zzz.zip": zip(BASE) };
  gets = [];
  const inbox = (await call("list_inbox")).content[0].text;
  assert.doesNotMatch(inbox, /Renew passport/);
  assert.deepEqual(gets, ["20261104000000=zzz.zip"]);
});

test("reports bad WebDAV credentials as a tool error", async () => {
  resetCache();
  globalThis.fetch = async () => new Response("no", { status: 401 });
  const r = await call("list_inbox");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /rejected the username or password/);
});

test('"false" in <hidden> or <completed> does not mark items dropped or done', async () => {
  resetCache();
  files = {
    "20261105000000=hhh.zip": zip(doc(`
      <folder id="f9"><folder/><name>Work</name><hidden>false</hidden></folder>
      <context id="c9"><context/><name>Office</name><hidden>false</hidden></context>
      <task id="p9"><task/><project><folder idref="f9"/><status>active</status></project><name>Report</name><hidden>false</hidden></task>
      <task id="t9"><task idref="p9"/><project/><name>Draft</name><context idref="c9"/><hidden>false</hidden><completed/></task>`)),
  };
  installFakeDav();
  const projects = (await call("list_projects")).content[0].text;
  assert.match(projects, /Work \/ Report · active · 1 remaining/);
  const tags = (await call("list_tags")).content[0].text;
  assert.match(tags, /Office · 1 remaining/);
  assert.doesNotMatch(tags, /dropped/);
});

async function callWith(env, name, args = {}) {
  const res = await worker.fetch(new Request("https://w.example/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env, ctx);
  return (await res.json()).result;
}

test("reads an encrypted database", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./fixtures/encrypted.ofocus/", import.meta.url); // 200,000 PBKDF2-SHA256 rounds
  resetCache();
  files = {};
  for (const n of readdirSync(dir)) files[n] = readFileSync(new URL(n, dir));
  installFakeDav();
  const status = (await callWith(ENV, "sync_status")).content[0].text;
  assert.match(status, /Encrypted: yes/);
  assert.match(status, /Transaction files: 3/);
  const inbox = (await callWith(ENV, "list_inbox")).content[0].text;
  assert.match(inbox, /Inbox \(1500\)/);
  assert.match(inbox, /Bulk item 1499/);

  resetCache();
  const bad = await callWith({ ...ENV, OF_PASSPHRASE: "wrong" }, "list_inbox");
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /passphrase is wrong/);
});

test("inspect_sync reports chain, keys and raw XML", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./fixtures/encrypted.ofocus/", import.meta.url);
  resetCache();
  files = {};
  for (const n of readdirSync(dir)) files[n] = readFileSync(new URL(n, dir));
  installFakeDav();
  const text = (await callWith(ENV, "inspect_sync", { xml_chars: 300 })).content[0].text;
  assert.match(text, /Transaction files: 3/);
  assert.match(text, /parents…\+own id:\n  consistent: true; heads: ccc/);
  assert.match(text, /Key slots: ActiveAES_CTR_HMAC#7/);
  assert.match(text, /A task insert as OmniFocus wrote it/);
});

test("inspect_sync find returns matching raw elements", async () => {
  const text = (await callWith(ENV, "inspect_sync", { find: "Bulk item 1499 ", limit: 2 })).content[0].text;
  assert.match(text, /<task id="big1499">/);
  assert.doesNotMatch(text, /big1498/);
});

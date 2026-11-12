import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { digestHeader, parseChallenges, davFetch, resetDigest } from "../src/dav.js";

test("Digest response matches the RFC 2617 example", () => {
  const h = digestHeader({
    user: "Mufasa", pass: "Circle Of Life", method: "GET", uri: "/dir/index.html", nc: 1, cnonce: "0a4f113b",
    challenge: { scheme: "digest", params: { realm: "testrealm@host.com", qop: "auth,auth-int", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque: "5ccc069c403ebaf9f0171e9517f40e41" } },
  });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /nc=00000001/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test("parses joined WWW-Authenticate challenges", () => {
  const c = parseChallenges('Basic realm="x", Digest realm="dav, home", nonce="abc", qop="auth", algorithm=MD5');
  assert.deepEqual(c.map((x) => x.scheme), ["basic", "digest"]);
  assert.equal(c[1].params.realm, "dav, home");
  assert.equal(c[1].params.algorithm, "MD5");
});

test("switches to Digest when the server asks for it, and reuses the challenge", async () => {
  resetDigest();
  const md5 = (s) => createHash("md5").update(s).digest("hex");
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const auth = init.headers.Authorization;
    seen.push(auth.split(" ")[0]);
    const challenge = new Response("", { status: 401, headers: { "WWW-Authenticate": 'Digest realm="r", nonce="n1", qop="auth"' } });
    if (!auth.startsWith("Digest ")) return challenge;
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));
    const ha1 = md5("u:r:pw"), ha2 = md5(`${init.method ?? "GET"}:${p.uri}`);
    const ok = p.response === md5(`${ha1}:n1:${p.nc}:${p.cnonce}:auth:${ha2}`) && p.uri === new URL(url).pathname;
    return ok ? new Response("hi") : challenge;
  };
  const cfg = { user: "u", pass: "pw" };
  const r1 = await davFetch(cfg, "https://dav.example.com/a/b.zip");
  assert.equal(await r1.text(), "hi");
  const r2 = await davFetch(cfg, "https://dav.example.com/a/c.zip", { method: "PROPFIND", body: "x" });
  assert.equal(r2.status, 200);
  assert.deepEqual(seen, ["Basic", "Digest", "Digest"]);
});

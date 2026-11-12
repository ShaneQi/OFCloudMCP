// WebDAV requests with HTTP Basic or Digest authentication (RFC 7616 / 2617).
// Sends Basic first; if the server answers 401 with a Digest challenge, it
// switches to Digest for this and later requests (the challenge is kept per
// Worker instance, with an increasing nonce count).
import { createHash, randomBytes } from "node:crypto";

const HASHES = { md5: "md5", "md5-sess": "md5", "sha-256": "sha256", "sha-256-sess": "sha256" };

// Digest challenges remembered across requests, keyed by user@origin.
const challenges = new Map();

export function resetDigest() {
  challenges.clear();
}

function basic(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

// Splits one or more WWW-Authenticate values (possibly joined with ", ")
// into [{ scheme, params }].
export function parseChallenges(header) {
  if (!header) return [];
  const out = [];
  const re = /([A-Za-z][\w-]*)\s*=\s*("((?:[^"\\]|\\.)*)"|[^\s,]+)|([A-Za-z][\w-]*)(?=\s+[A-Za-z][\w-]*\s*=)|,/g;
  let cur = null;
  let m;
  while ((m = re.exec(header))) {
    if (m[4]) {
      cur = { scheme: m[4].toLowerCase(), params: {} };
      out.push(cur);
    } else if (m[1] && cur) {
      cur.params[m[1].toLowerCase()] = m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : m[2];
    }
  }
  return out;
}

function pickDigest(header) {
  const digests = parseChallenges(header).filter((c) => c.scheme === "digest");
  // Prefer SHA-256 when offered alongside MD5.
  const known = digests.filter((c) => HASHES[(c.params.algorithm ?? "MD5").toLowerCase()]);
  return known.find((c) => (c.params.algorithm ?? "").toLowerCase().startsWith("sha-256")) ?? known[0] ?? null;
}

// Computes a Digest Authorization header value.
export function digestHeader({ user, pass, method, uri, challenge, nc, cnonce }) {
  const p = challenge.params;
  const alg = (p.algorithm ?? "MD5").toLowerCase();
  const H = (s) => createHash(HASHES[alg]).update(s, "utf8").digest("hex");
  let ha1 = H(`${user}:${p.realm}:${pass}`);
  if (alg.endsWith("-sess")) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qops = (p.qop ?? "").split(",").map((s) => s.trim().toLowerCase());
  const qop = qops.includes("auth") ? "auth" : null;
  const ncHex = nc.toString(16).padStart(8, "0");
  const response = qop ? H(`${ha1}:${p.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
  const q = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
  const parts = [
    `username=${q(user)}`, `realm=${q(p.realm)}`, `nonce=${q(p.nonce)}`, `uri=${q(uri)}`,
    `response=${q(response)}`,
  ];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (p.opaque != null) parts.push(`opaque=${q(p.opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce=${q(cnonce)}`);
  return "Digest " + parts.join(", ");
}

// fetch() with the WebDAV credentials in cfg ({ user, pass }).
export async function davFetch(cfg, url, init = {}) {
  const u = new URL(url);
  const key = `${cfg.user}@${u.origin}`;
  const method = (init.method ?? "GET").toUpperCase();
  const uri = u.pathname + u.search;

  const send = (auth) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: auth } });
  const withDigest = (state) => {
    state.nc += 1;
    return send(digestHeader({
      user: cfg.user, pass: cfg.pass, method, uri, challenge: state.challenge,
      nc: state.nc, cnonce: randomBytes(8).toString("hex"),
    }));
  };

  let state = challenges.get(key);
  let res = state ? await withDigest(state) : await send(basic(cfg.user, cfg.pass));
  if (res.status !== 401) return res;

  // New or expired challenge: answer the one in this 401, once.
  const challenge = pickDigest(res.headers.get("WWW-Authenticate"));
  if (!challenge) return res;
  state = { challenge, nc: 0 };
  challenges.set(key, state);
  await res.body?.cancel();
  res = await withDigest(state);
  if (res.status === 401) challenges.delete(key);
  return res;
}

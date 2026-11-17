// Cloudflare Access authentication. Access sits in front of the server and
// adds a signed JWT (Cf-Access-Jwt-Assertion) to every request it lets
// through; this module verifies it, so a request that reaches the origin
// directly (Cloud Run run.app URL, VPS IP, ...) without going through Access
// is refused. WebCrypto only, no dependencies.
//
// Configuration:
//   CF_ACCESS_TEAM_DOMAIN  "myteam.cloudflareaccess.com", "https://myteam.cloudflareaccess.com" or "myteam"
//   CF_ACCESS_AUD          the Access application's AUD tag (comma-separated for several)

const KEY_TTL_MS = 60 * 60_000; // re-fetch the team's keys after an hour
const MIN_REFETCH_MS = 60_000; // on an unknown kid, re-fetch at most once a minute
const LEEWAY_S = 60;
const FETCH_TIMEOUT_MS = 10_000; // give up on the key endpoint after 10 s
const keySets = new Map(); // issuer -> { keys: Map(kid -> CryptoKey), fetchedAt }
const refreshing = new Map(); // issuer -> Promise of the key fetch in progress

/** { issuer, audiences } from env, or null when either variable is missing. */
export function accessConfig(env) {
  let team = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const audiences = (env.CF_ACCESS_AUD ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!team || !audiences.length) return null;
  if (!/^https?:\/\//.test(team)) team = `https://${team.includes(".") ? team : `${team}.cloudflareaccess.com`}`;
  return { issuer: team, audiences };
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function importKeys(jwks) {
  const keys = new Map();
  for (const jwk of jwks?.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return keys;
}

// For tests: install a key set without fetching it.
export async function setAccessKeys(issuer, jwks) {
  keySets.set(issuer, { keys: await importKeys(jwks), fetchedAt: Date.now() });
}

// For tests: forget every cached key set.
export function clearAccessKeys() {
  keySets.clear();
  refreshing.clear();
}

async function refreshKeys(issuer) {
  const cached = keySets.get(issuer);
  try {
    const res = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    keySets.set(issuer, { keys: await importKeys(await res.json()), fetchedAt: Date.now() });
  } catch (e) {
    if (!cached) throw new Error(`could not fetch Cloudflare Access keys from ${issuer}: ${e?.message ?? e}`);
    console.warn(`Cloudflare Access key refresh failed, using cached keys: ${e?.message ?? e}`);
  }
}

async function keyFor(issuer, kid) {
  const set = keySets.get(issuer);
  const now = Date.now();
  const stale = !set || now - set.fetchedAt > KEY_TTL_MS;
  const unknown = set && !set.keys.has(kid) && now - set.fetchedAt > MIN_REFETCH_MS;
  if (stale || unknown) {
    // Requests that need new keys at the same time share one fetch.
    let pending = refreshing.get(issuer);
    if (!pending) {
      pending = refreshKeys(issuer).finally(() => refreshing.delete(issuer));
      refreshing.set(issuer, pending);
    }
    await pending;
  }
  return keySets.get(issuer).keys.get(kid);
}

/** Verifies a Cloudflare Access JWT; returns its payload or throws with the reason. */
export async function verifyAccessJwt(token, config, nowS = Date.now() / 1000) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new Error("malformed JWT");
  }
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  if (typeof header.kid !== "string" || !header.kid) throw new Error("missing kid");
  const key = await keyFor(config.issuer, header.kid);
  if (!key) throw new Error("unknown signing key");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad signature");
  if (payload.iss !== config.issuer) throw new Error("wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((a) => config.audiences.includes(a))) throw new Error("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < nowS) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > nowS) throw new Error("not yet valid");
  return payload;
}

/** The JWT from Cf-Access-Jwt-Assertion, else from Authorization: Bearer; null if neither. */
export function accessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  return m ? m[1] : null;
}

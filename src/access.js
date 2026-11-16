// Cloudflare Access authentication. Cloudflare Access sits in front of the
// connector and, for every request it lets through, adds a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. We verify that JWT ourselves, so a request
// that reaches the origin directly (e.g. the run.app URL) without going through
// Access is refused.
//
// Checks: RS256 signature against the team's published keys
// (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), issuer = the team
// domain, audience includes one of CF_ACCESS_AUD, and exp / nbf (60 s leeway).
//
// Configuration:
//   CF_ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com" (a full https URL
//                          or just "myteam" also work)
//   CF_ACCESS_AUD          the Access application's Audience (AUD) tag; several
//                          may be given, separated by commas

const KEY_TTL_MS = 60 * 60_000; // re-fetch the key set hourly
const MIN_REFETCH_MS = 60_000; // on an unknown key id, re-fetch at most once a minute
const LEEWAY_S = 60;

const keySets = new Map(); // issuer -> { keys: Map(kid -> CryptoKey), fetchedAt }

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
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  return keys;
}

// For tests: install a key set without fetching it.
export async function setAccessKeys(issuer, jwks) {
  keySets.set(issuer, { keys: await importKeys(jwks), fetchedAt: Date.now() });
}

async function keyFor(issuer, kid) {
  const now = Date.now();
  let set = keySets.get(issuer);
  const stale = !set || now - set.fetchedAt > KEY_TTL_MS;
  const unknown = set && !set.keys.has(kid) && now - set.fetchedAt > MIN_REFETCH_MS;
  if (stale || unknown) {
    try {
      const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set = { keys: await importKeys(await res.json()), fetchedAt: now };
      keySets.set(issuer, set);
    } catch (e) {
      if (!set) throw new Error(`could not fetch Cloudflare Access keys from ${issuer}: ${e?.message ?? e}`);
      console.warn(`Cloudflare Access key refresh failed, using cached keys: ${e?.message ?? e}`);
    }
  }
  return set.keys.get(kid);
}

// Returns the verified JWT payload, or throws with the reason.
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
  const key = await keyFor(config.issuer, header.kid);
  if (!key) throw new Error("unknown signing key");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("bad signature");
  if (payload.iss !== config.issuer) throw new Error("wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some((a) => config.audiences.includes(a))) throw new Error("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < nowS) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > nowS) throw new Error("not yet valid");
  return payload;
}

// The Access JWT from the request: the header Cloudflare adds, else a bearer
// token (for callers that send the Access token themselves).
export function accessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  return m ? m[1] : null;
}

// Test helper: a fake Cloudflare Access team with its own signing key.
import { setAccessKeys } from "../../src/access.js";

export const TEAM = "https://test-team.cloudflareaccess.com";
export const AUD = "test-aud-tag";
export const ACCESS_ENV = { CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com", CF_ACCESS_AUD: AUD };

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", publicKey);
await setAccessKeys(TEAM, { keys: [{ ...jwk, kid: "k1" }] });

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

export async function signToken(claims = {}, { kid = "k1", key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: TEAM, aud: [AUD], email: "me@example.com", iat: now, nbf: now, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

export const TOKEN = await signToken();

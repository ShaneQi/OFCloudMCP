// Cloudflare Worker entry point: checks the connector token, then serves MCP at /mcp.
import { handleMcp } from "./mcp.js";

function tokenMatches(request, env) {
  const expected = `Bearer ${env.ACCESS_TOKEN}`;
  const given = request.headers.get("Authorization") ?? "";
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("OmniFocus MCP connector. Use /mcp.\n");
    if (pathname !== "/mcp") return new Response("Not found\n", { status: 404 });
    if (!env.ACCESS_TOKEN) return new Response("Server is missing its ACCESS_TOKEN secret.\n", { status: 500 });
    if (!tokenMatches(request, env)) {
      return new Response("Unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    return handleMcp(request, env, ctx);
  },
};

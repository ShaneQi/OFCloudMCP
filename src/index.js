// HTTP handler (fetch-style Request -> Response): checks the Cloudflare Access
// JWT, then serves MCP at POST /mcp. src/server.js runs it as a Node HTTP server.
import { handleMcp } from "./mcp.js";
import { accessConfig, accessToken, verifyAccessJwt } from "./access.js";

const unauthorized = () =>
  new Response("Unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("OmniFocus MCP connector. Use /mcp.\n");
    if (pathname !== "/mcp") return new Response("Not found\n", { status: 404 });
    const config = accessConfig(env);
    if (!config) {
      return new Response("Server is missing its Cloudflare Access settings (CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD).\n", { status: 500 });
    }
    const token = accessToken(request);
    if (!token) {
      console.warn("access denied: no Cloudflare Access token");
      return unauthorized();
    }
    try {
      await verifyAccessJwt(token, config);
    } catch (e) {
      console.warn(`access denied: ${e?.message ?? e}`);
      return unauthorized();
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    return handleMcp(request, env, ctx);
  },
};

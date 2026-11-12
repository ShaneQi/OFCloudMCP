// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
import { UserError } from "./errors.js";
import { loadModel } from "./store.js";
import { TOOLS as READ_TOOLS, makeIndex } from "./query.js";
import { WRITE_TOOLS } from "./writetools.js";
import { writeMode } from "./write.js";

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleMcp(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(fail(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(body);
  const replies = [];
  for (const msg of batch ? body : [body]) {
    const reply = await handleMessage(msg, env, ctx);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

async function handleMessage(msg, env, ctx) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && typeof msg === "object" && "id" in msg ? fail(msg.id ?? null, -32600, "Invalid request") : null;
  }
  if (!("id" in msg)) return null; // notification

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omnifocus-webdav", title: "OmniFocus (read-only)", version: "0.1.0" },
        instructions:
          "Access to the user's OmniFocus database, synced over WebDAV. Read tools are safe; " +
          "add_task, edit_task, complete_task and drop_task change the user's real database (each call " +
          "writes one sync transaction), so only use them when the user asks for that change. " +
          "Results show ids as [id:…]; pass them to get_task or get_project for details.",
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, write, destructive }) => ({
          name, title, inputSchema,
          description: write && writeMode(env) !== "on"
            ? `${description} (Writing is currently disabled on this server, so this only previews.)`
            : description,
          annotations: write
            ? { title, readOnlyHint: false, destructiveHint: !!destructive, idempotentHint: false, openWorldHint: false }
            : { title, readOnlyHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      return ok(msg.id, await callTool(tool, msg.params.arguments ?? {}, env, ctx));
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(tool, args, env, ctx) {
  try {
    const data = await loadModel(env, ctx);
    const ix = makeIndex(data.model, env.TIMEZONE || "UTC", Date.now());
    const text = await tool.run(ix, args, data, { env, ctx });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const text = e instanceof UserError ? e.message : `Unexpected error: ${e?.message ?? e}`;
    if (!(e instanceof UserError)) console.error(e);
    return { content: [{ type: "text", text }], isError: true };
  }
}

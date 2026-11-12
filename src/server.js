// Node entry point: runs the connector as a plain-HTTP server (e.g. in a
// container behind an HTTPS reverse proxy). Routes:
//   POST /mcp  (Authorization: Bearer <ACCESS_TOKEN>)
//   GET  /health  (also /healthz; Cloud Run reserves paths ending in "z")
//
// Configuration (environment variables):
//   OFOCUS_URL, WEBDAV_USER, WEBDAV_PASS, ACCESS_TOKEN   required
//   OF_PASSPHRASE     database passphrase, if different from WEBDAV_PASS
//   TIMEZONE          default America/Chicago
//   PORT              default 8787
//   CACHE_DIR         where the parsed database and unlocked keys are kept
//                     between restarts (default /data; empty = memory only)
//   REFRESH_MINUTES   re-read new transactions in the background this often,
//                     so requests rarely wait for downloads (default 10; 0 = off)
//
// It runs behind your own HTTPS reverse proxy; it speaks plain HTTP.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import app from "./index.js";
import { loadModel } from "./store.js";

const PORT = Number(process.env.PORT || 8787);
const CACHE_DIR = process.env.CACHE_DIR ?? "/data";
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES ?? 10);

// A tiny file-backed key-value cache (get/put/delete), passed to the handler as env.OF_CACHE.
function fileKv(dir) {
  const file = (key) => path.join(dir, crypto.createHash("sha256").update(key).digest("hex"));
  return {
    async get(key, type) {
      try {
        const text = await fs.readFile(file(key), "utf8");
        return type === "json" ? JSON.parse(text) : text;
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async put(key, value) {
      const f = file(key);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, value, { mode: 0o600 });
      await fs.rename(tmp, f);
    },
    async delete(key) {
      await fs.rm(file(key), { force: true });
    },
  };
}

const env = { TIMEZONE: "America/Chicago", ...process.env };
for (const key of ["OFOCUS_URL", "WEBDAV_USER", "WEBDAV_PASS", "ACCESS_TOKEN"]) {
  if (!env[key]) console.warn(`warning: ${key} is not set`);
}
if (CACHE_DIR) {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  env.OF_CACHE = fileKv(CACHE_DIR);
}

const pending = new Set();
const ctx = {
  waitUntil(p) {
    const q = Promise.resolve(p).catch((e) => console.error("background task failed:", e?.message ?? e));
    pending.add(q);
    q.finally(() => pending.delete(q));
  },
  passThroughOnException() {},
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      return;
    }
    const host = req.headers.host ?? `localhost:${PORT}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(new URL(req.url, `http://${host}`), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const response = await app.fetch(request, env, ctx);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error\n");
  }
});

let refreshing = false;
async function refresh(reason) {
  if (refreshing) return;
  refreshing = true;
  const t = Date.now();
  try {
    const r = await loadModel(env, ctx);
    console.log(`${reason}: ${r.source}, ${r.files.length} files (${Date.now() - t} ms)`);
  } catch (e) {
    console.error(`${reason} failed: ${e?.message ?? e}`);
  } finally {
    refreshing = false;
  }
}

server.listen(PORT, () => {
  console.log(`OmniFocus MCP listening on :${PORT} (cache: ${CACHE_DIR || "memory only"})`);
  refresh("startup load");
  if (REFRESH_MINUTES > 0) setInterval(() => refresh("refresh"), REFRESH_MINUTES * 60_000).unref();
});

const shutdown = () => {
  console.log("shutting down");
  server.close(async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

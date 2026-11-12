# OmniFocus connector for Claude (read-only, Cloudflare Workers)

A remote MCP server that reads your OmniFocus database from your WebDAV sync
folder. It runs on Cloudflare Workers, so nothing runs on your own devices.
Your WebDAV password stays in Cloudflare's encrypted secrets; Claude only
holds a separate access token.

Tools: `list_inbox`, `list_due`, `list_flagged`, `list_projects`,
`get_project`, `search_tasks`, `list_tags`, `get_task`, `sync_status`.
Nothing writes to your database.

## One-time setup (any computer with Node.js 18+)

1. Unzip this folder, open a terminal in it, and run:

       npm install
       npx wrangler login

   The login opens a browser to sign in to (or create) a free Cloudflare account.

2. Optional but recommended, so each request doesn't re-read the whole database:

       npx wrangler kv namespace create OF_CACHE

   Paste the `id` it prints into `wrangler.toml` and uncomment the three
   `[[kv_namespaces]]` lines.

3. Check `TIMEZONE` in `wrangler.toml` (default `America/Chicago`).

4. Add the secrets. Each command asks for the value:

       npx wrangler secret put OFOCUS_URL
       npx wrangler secret put WEBDAV_USER
       npx wrangler secret put WEBDAV_PASS
       npx wrangler secret put ACCESS_TOKEN

   - `OFOCUS_URL` is the full URL of the `OmniFocus.ofocus` folder, e.g.
     `https://dav.example.com/omnifocus/OmniFocus.ofocus/`.
     It's your OmniFocus sync server address plus `OmniFocus.ofocus`.
   - `ACCESS_TOKEN` is a new random secret for Claude. Make one with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
     and keep a copy for step 7.

   (The first `secret put` may offer to create the Worker; say yes.)

5. Deploy:

       npx wrangler deploy

   It prints a URL like `https://omnifocus-mcp.<you>.workers.dev`.

6. Test it (replace the URL and token):

       curl -X POST https://omnifocus-mcp.<you>.workers.dev/mcp \
         -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
         -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync_status","arguments":{}}}'

7. In Claude: **Settings → Connectors → Add custom connector**.
   - URL: `https://omnifocus-mcp.<you>.workers.dev/mcp`
   - Under **Request headers**, add `Authorization` with the value
     `Bearer <ACCESS_TOKEN>`.

It then works in claude.ai (web, desktop, mobile), Cowork, and Claude Code.

## Limits and troubleshooting

- **CPU time:** the free Workers plan allows very little CPU time per request.
  Parsing a large database may exceed it ("exceeded CPU" / error 1102). The
  KV cache helps; if it still fails, the Workers Paid plan removes the problem.
- **Outgoing requests:** each request downloads only new transaction files,
  but a first load or a rebuild downloads them all. `MAX_FETCH` (default 45)
  stops before the free plan's request cap. If you hit it, raise `MAX_FETCH`
  on a paid plan, or let OmniFocus compact its database.
- **Wrong password / folder:** `sync_status` reports the WebDAV error.
- **Encrypted sync** is not supported. An `encrypted` file at the top of the
  `OmniFocus.ofocus` folder means the database is encrypted.
- **Rotating the token:** run `npx wrangler secret put ACCESS_TOKEN` again
  and update the header in Claude's connector settings.

## Development

    npm test          # unit tests with synthetic OmniFocus data
    npx wrangler dev  # local server; put secrets in a .dev.vars file

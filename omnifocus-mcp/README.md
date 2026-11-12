# OmniFocus connector for Claude (read-only, Cloudflare Workers)

A remote MCP server that reads your OmniFocus database from your WebDAV sync
folder. It runs on Cloudflare Workers, so nothing runs on your own devices.
Your WebDAV password stays in Cloudflare's encrypted secrets; Claude only
holds a separate access token.

Tools: `list_inbox`, `list_due`, `list_flagged`, `list_projects`,
`get_project`, `search_tasks`, `list_tags`, `get_task`, `sync_status`.
Nothing writes to your database.

## Setup with GitHub Actions (no computer needed)

`.github/workflows/deploy.yml` (at the repository root) runs the tests on every
push and pull request, and deploys the Worker on each push to `main` that
touches `omnifocus-mcp/`, or when run by hand from the Actions tab.

1. In Cloudflare: **My Profile → API Tokens → Create Token**, use the
   **Edit Cloudflare Workers** template, and pick your account. Copy the token.
   Your **Account ID** is on the Workers & Pages overview page.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Until both
   exist, the deploy job skips with a warning instead of failing.
3. Run the workflow (Actions → Deploy Worker → Run workflow) or push to `main`.
   The first run creates the Worker `omnifocus-mcp`.
4. In Cloudflare, open the Worker → **Settings → Variables and Secrets** and add
   four values of type **Secret**: `OFOCUS_URL`, `WEBDAV_USER`, `WEBDAV_PASS`,
   `ACCESS_TOKEN` (see step 4 of the terminal setup for what each is). They
   survive later deploys, and the WebDAV password never passes through GitHub.
   Until `ACCESS_TOKEN` is set, the Worker refuses every request.
5. Optional KV cache: **Storage & Databases → KV → Create** a namespace,
   put its id in `wrangler.toml` (uncomment the `[[kv_namespaces]]` lines) and
   push; the next deploy binds it.
6. Continue at step 6 of the terminal setup (test, then add the connector in Claude).

## Setup in the browser with Workers Builds (alternative)

This deploys straight from the GitHub repository with Cloudflare Workers Builds.

1. Sign in to the Cloudflare dashboard (a free account works to start).
2. **Workers & Pages → Create → Import a repository**. Connect GitHub, pick
   this repository, and set:
   - Project name: `omnifocus-mcp` (must match `name` in `wrangler.toml`)
   - Root directory: `omnifocus-mcp`
   - Build command: empty. Deploy command: `npx wrangler deploy` (the default)
3. After the first deploy, open the Worker → **Settings → Variables and Secrets**
   and add four values of type **Secret**: `OFOCUS_URL`, `WEBDAV_USER`,
   `WEBDAV_PASS`, `ACCESS_TOKEN` (see step 4 below for what each one is).
   Secrets survive later deploys.
4. Optional KV cache: **Storage & Databases → KV → Create** a namespace named
   `OF_CACHE`, copy its id into `wrangler.toml` (uncomment the three
   `[[kv_namespaces]]` lines) and push; the next build binds it.
5. Continue at step 6 below (test, then add the connector in Claude).

Every push to the production branch redeploys the Worker.

## One-time setup from a terminal (any computer with Node.js 18+)

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

- **CPU time:** the free Workers plan allows 10 ms of CPU per request.
  Parsing a large database may exceed it ("exceeded CPU" / error 1102), and
  even reading a large cached model from KV costs CPU. `npm run dump` prints
  the parse and JSON timings for your database, which tell you whether the
  free plan can work. The Workers Paid plan (30 s CPU) removes the problem.
- **Outgoing requests:** each request downloads only new transaction files,
  but a first load or a rebuild downloads them all. `MAX_FETCH` (default 45)
  stops before the free plan's request cap. If you hit it, raise `MAX_FETCH`
  on a paid plan, or let OmniFocus compact its database.
- **Wrong password / folder:** `sync_status` reports the WebDAV error.
- **Encrypted databases** (an `encrypted` file in `OmniFocus.ofocus`, the
  default on Omni Sync Server) are decrypted using Omni's published format.
  The passphrase is `WEBDAV_PASS` unless you set a separate `OF_PASSPHRASE`
  secret. Unlocking the key is deliberately slow (PBKDF2), so the unlocked
  file keys are kept in memory and, if bound, in the `OF_CACHE` KV namespace
  (which already holds the decrypted task data). Changing your password
  rewrites the `encrypted` file and forces a fresh unlock.
- **Omni Sync Server** works: use
  `https://sync.omnigroup.com/<account>/OmniFocus.ofocus/` as `OFOCUS_URL`
  and your Omni account name and password. Digest login and the redirect to
  a `syncN` host are handled.
- **Rotating the token:** run `npx wrangler secret put ACCESS_TOKEN` again
  and update the header in Claude's connector settings.

## Checking the parser against your real database

`scripts/dump.mjs` reads your real `OmniFocus.ofocus` folder (read-only:
PROPFIND and GET only), replays it with the connector's own parser, and
writes three files to `./dump` (git-ignored; they contain your task data):

- `report.txt`: which elements and fields the XML really has, value samples
  (project status, `hidden`, …), date formats (UTC vs floating), whether
  updates are full or partial records, file-name order, sizes and timings.
- `model.json`: the replayed model.
- `tools.txt`: what each read tool returns, to compare with OmniFocus.

Run it with the same values as the secrets:

    OFOCUS_URL=… WEBDAV_USER=… WEBDAV_PASS=… npm run dump

or on a local copy of the folder: `node scripts/dump.mjs --dir path/to/OmniFocus.ofocus`.

## Development

    npm test          # unit tests with synthetic OmniFocus data
    npx wrangler dev  # local server; put secrets in a .dev.vars file

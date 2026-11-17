# OmniFocus MCP connector

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude access
to an OmniFocus database through its sync folder (your own WebDAV server or
Omni Sync Server, encrypted or not). It runs as a small container on any VPS,
so nothing has to run on your Mac or phone, and it works from claude.ai on the
web, desktop and mobile, Claude Code and Cowork.

Requests are authenticated by [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/):
the connector only answers requests carrying a valid Access JWT, so Claude
never sees your sync password, which stays on the server.

- **Read tools:** `list_inbox`, `list_due`, `list_flagged`, `list_projects`,
  `get_project`, `search_tasks`, `list_tags`, `get_task`, `get_attachment`,
  `sync_status`, `inspect_sync` (diagnostics).
- **Write tools** (off unless `ALLOW_WRITES=true`; otherwise they only preview):
  `add_task`, `edit_task`, `complete_task`, `drop_task`, `add_project`,
  `set_project_status`, `delete_task`, `add_tag`, `edit_tag`, `delete_tag`,
  `add_attachment`, `delete_attachment`.

## How it works

OmniFocus syncs by writing small, append-only *transaction files* into an
`OmniFocus.ofocus` folder on the sync server. The connector:

1. lists that folder over WebDAV (Basic or Digest login, following redirects,
   e.g. Omni Sync Server's `sync.omnigroup.com` → `syncN.omnigroup.com`);
2. unlocks the database key if the folder is encrypted (Omni's published
   OmniFileStore format: PBKDF2 + AES key wrap, then AES-CTR + HMAC per file);
3. downloads the transaction files, unzips `contents.xml` from each and
   replays them in order into an in-memory model of tasks, projects, tags,
   folders and attachments;
4. answers MCP tool calls from that model. New transaction files are applied
   incrementally; if OmniFocus compacts the folder, the model is rebuilt.

Writes add one new transaction file per change, exactly as an OmniFocus
device would (see [Writing](#writing)).

## Running it on a VPS

You need Docker on a Linux server (amd64 or arm64) and an HTTPS reverse proxy
(Caddy, nginx, Traefik, a tunnel, …). The container speaks plain HTTP on port
8787.

### 1. Get the image

Every push to `main` publishes `ghcr.io/shaneqi/ofcloudmcp:latest` (also
`:sha-<commit>`, and the version on `v*` tags). GitHub makes new packages
private: either make it public (GitHub → profile → Packages → ofcloudmcp →
Package settings → Change visibility), or log in on the server with a token
that has `read:packages`:

    echo <token> | docker login ghcr.io -u <github-user> --password-stdin

Or build it yourself: `docker build -t omnifocus-mcp .`

### 2. Configure

Create `.env` next to your compose file and `chmod 600 .env`:

    # Required
    OFOCUS_URL=https://sync.omnigroup.com/<account>/OmniFocus.ofocus/
    WEBDAV_USER=<account>
    WEBDAV_PASS=<password>
    CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
    CF_ACCESS_AUD=<Access application's Audience (AUD) tag>

    # Optional
    # OF_PASSPHRASE=<database passphrase, if different from WEBDAV_PASS>
    # TIMEZONE=America/Chicago       (reads OmniFocus' floating dates; default America/Chicago)
    # REFRESH_MINUTES=10             (background re-read; 0 = only on requests)
    # ALLOW_WRITES=true              (enables the write tools)

- `OFOCUS_URL` is the folder that contains the transaction files: your sync
  server address plus `OmniFocus.ofocus/`. In OmniFocus: Settings → Sync. For
  Omni Sync Server use `https://sync.omnigroup.com/<account name>/OmniFocus.ofocus/`.
- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`: from the Cloudflare Access
  application in front of the connector (Zero Trust → Access → Applications →
  your app → Overview → *Application Audience (AUD) Tag*). See
  [Authentication](#authentication-cloudflare-access).

### 3. Start

    cp compose.example.yml compose.yml
    docker compose up -d
    docker logs -f omnifocus-mcp      # expect: "startup load: … files"

`compose.example.yml` binds `127.0.0.1:8787` (reachable only through your
proxy) and keeps the cache in the `omnifocus-cache` volume at `/data`.
Without compose:

    docker run -d --name omnifocus-mcp --restart unless-stopped \
      --env-file .env -p 127.0.0.1:8787:8787 -v omnifocus-cache:/data \
      ghcr.io/shaneqi/ofcloudmcp:latest

### 4. HTTPS and Cloudflare Access

Publish `127.0.0.1:8787` through Cloudflare (e.g. a Cloudflare Tunnel, or a
proxied hostname in front of your reverse proxy) as
`omnifocus.example.com`, and protect it with an Access self-hosted
application (see [Authentication](#authentication-cloudflare-access)).

Check it: `curl https://omnifocus.example.com/health` → `ok`, and, with an
Access service token allowed by the application's policy:

    curl -X POST https://omnifocus.example.com/mcp \
      -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync_status","arguments":{}}}'

### 5. Add it to Claude

claude.ai → Settings → Connectors → Add custom connector with the URL
`https://omnifocus.example.com/mcp` and whatever Access expects from Claude
(for a service-token policy, the request headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`).

It is then available in claude.ai (web, desktop, mobile), Cowork and Claude Code.

## Authentication (Cloudflare Access)

Cloudflare Access decides who gets in (service token, identity provider,
OAuth, …). For every request it lets through, it adds a signed JWT in the
`Cf-Access-Jwt-Assertion` header. The connector (`src/access.js`) verifies
that JWT on every `/mcp` request:

- RS256 signature against the team's keys at
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached for an
  hour; re-fetched when an unknown key id shows up, i.e. after key rotation);
- `iss` = `https://<CF_ACCESS_TEAM_DOMAIN>`, `aud` contains `CF_ACCESS_AUD`;
- `exp` / `nbf`, with 60 s leeway.

If the header is absent, an Access JWT sent as `Authorization: Bearer <jwt>`
is accepted too (same checks). Anything else gets `401` with
`WWW-Authenticate: Bearer`; the reason is only logged, as `access denied: …`.
The server exits at startup if either `CF_ACCESS_*` variable is missing.
Because the check
happens in the container, a request that reaches the origin directly (the
`run.app` URL, the VPS's IP) without going through Access is refused.
`/health` stays open.

### Updating

    docker compose pull && docker compose up -d

The parsed database and the unlocked file keys are kept in `/data`, so a
restart does not repeat the first full load. **That volume holds your
decrypted tasks**: keep it on the server and out of shared backups.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `OFOCUS_URL` | (required) | WebDAV URL of the `OmniFocus.ofocus` folder |
| `WEBDAV_USER`, `WEBDAV_PASS` | (required) | Sync login (Basic or Digest) |
| `CF_ACCESS_TEAM_DOMAIN` | (required) | Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | (required) | Access application's AUD tag (several: comma-separated). The server exits at startup if either is unset |
| `OF_PASSPHRASE` | `WEBDAV_PASS` | Passphrase of an encrypted database |
| `TIMEZONE` | `America/Chicago` | Zone for OmniFocus' floating (zone-less) dates |
| `ALLOW_WRITES` | off | `true` lets write tools change the database |
| `REFRESH_MINUTES` | `10` | Background refresh interval; `0` = off |
| `CACHE_DIR` | `/data` | Where the cache is kept; empty = memory only |
| `PORT` | `8787` | HTTP port |

Endpoints: `POST /mcp` (MCP, Streamable HTTP, JSON responses, stateless) and
`GET /health` (also `/healthz`).

## Writing

Each write tool call adds one transaction in the format OmniFocus 4.10 writes,
checked against a real database with `inspect_sync`:

- `add_task`: an action in the inbox or an active project, with note, tags,
  defer / due / planned dates, flag, estimate and repeat rule.
- `edit_task`: change name, note, dates, flag, estimate, tags or repeat rule,
  or move an action to another project or the inbox. Only given fields change.
- `complete_task` / `drop_task`: `undo: true` reverses. Completing a repeating
  action works like OmniFocus: the action is completed and its next occurrence
  (id `<id>.<n>`) is created with dates moved on by the rule, fixed or counted
  from completion. Supported rules: FREQ HOURLY/DAILY/WEEKLY/MONTHLY/YEARLY
  with INTERVAL, BYDAY (incl. `2WE`, `-1FR`), BYMONTHDAY, BYMONTH, UNTIL;
  others (e.g. COUNT) are refused.
- `add_project` (parallel, sequential or single-action list; folder; active or
  on hold) and `set_project_status` (active, on hold, completed, dropped).
- `add_tag`, `edit_tag` (rename, move, active / on hold / dropped), `delete_tag`
  (also its sub-tags; items just lose the tag).
- `delete_task`: an action or project with its sub-actions, tag links and
  attachments. Prefer dropping, which is reversible.
- `add_attachment` / `delete_attachment`: stored like OmniFocus does
  (`data/data-<sha256>.zip`, encrypted) and shown at the end of the item's note.

Dates given as `2026-11-20` use the database's default due / defer time;
`2026-11-20 14:30` is local time (`TIMEZONE`); ISO times with a zone are
converted.

**Safety:**

- Off unless `ALLOW_WRITES=true`; `dry_run: true` always only previews.
- Each transaction is chained after the current head, encrypted, then
  decrypted, unzipped and replayed by the connector's own reader before upload;
  if anything reads back differently, nothing is written.
- Refuses to write while the folder has more than one unmerged sync branch
  (OmniFocus merges them on its next sync) or an unexpected chain.
- Uploads under a temporary name and moves into place with WebDAV `MOVE`
  (no overwrite), so devices never see a partial file. Never writes `.client`
  files (that would hold back OmniFocus' compaction).

Before turning writes on, back up the database (OmniFocus on the Mac: File →
Back Up Database).

## Troubleshooting

`sync_status` shows how the database was read; errors are reported as text.

- **"rejected the username or password … Tried Digest at …"**: check
  `WEBDAV_USER` / `WEBDAV_PASS`; the message names the host after redirects.
- **"No transaction files … It contains …"**: `OFOCUS_URL` points at the
  wrong folder; the message lists what is there.
- **"the passphrase is wrong"**: set `OF_PASSPHRASE`.
- **"N unmerged sync branches"** (writes): wait for a device to sync, retry.
- The first load of a big, uncompacted database takes a while (one download
  per transaction file plus ~1.5 s to unlock an encrypted key); later loads
  only fetch new files.

## Continuous integration

`.github/workflows/container.yml`, on every push to `main` (Markdown-only
changes are skipped), on `v*` tags and pull requests:

1. `npm ci && npm test`;
2. builds the image for linux/amd64 and linux/arm64 and pushes it to GHCR
   (built-in `GITHUB_TOKEN`) and to Google Artifact Registry
   (`GCP_SA_KEY` secret; destination in the workflow's `env:`);
3. on `main`, updates the Google Cloud Run service `of-cloud-mcp` (in
   `env:`) to the new image (only the image; its settings are kept).

The service has to exist before the first deploy. Create it once, e.g.:

    gcloud run deploy of-cloud-mcp --project serverless-509006 --region us-south1 \
      --image us-south1-docker.pkg.dev/serverless-509006/images/omnifocus-mcp:latest \
      --allow-unauthenticated --port 8787 \
      --set-env-vars OFOCUS_URL=…,WEBDAV_USER=…,CF_ACCESS_TEAM_DOMAIN=…,CF_ACCESS_AUD=… \
      --set-secrets WEBDAV_PASS=<secret>:latest

`--allow-unauthenticated` only opens the service at the Cloud Run layer;
every `/mcp` request still needs a valid Cloudflare Access JWT.

Pull requests are built but not pushed. If you only use a VPS, delete the
Artifact Registry login, the `GAR_*` image line and the Cloud Run steps.

---

## Maintainer notes (for the next person or agent)

### Code map

| File | What it does |
|---|---|
| `src/server.js` | Node HTTP server; file-backed cache (`CACHE_DIR`); startup load and `REFRESH_MINUTES` refresh |
| `src/index.js` | fetch-style handler: Cloudflare Access check, routes `/mcp` |
| `src/access.js` | Cloudflare Access JWT verification (team keys, iss/aud/exp) |
| `src/mcp.js` | Stateless MCP over Streamable HTTP (initialize, ping, tools/list, tools/call); merges read and write tools; `writeMode` gates writes |
| `src/store.js` | `loadModel`: PROPFIND listing, incremental replay, rebuild on compaction, cache (key `model-v3`; bump when the model's shape changes), unlocked-key cache; `syncContext`/`fetchFile` for raw access |
| `src/dav.js` | WebDAV fetch with Basic→Digest (MD5/SHA-256, `-sess`), manual redirects |
| `src/crypto.js` | OmniFileStore encryption: `encrypted` plist (XML or binary), PBKDF2 + AES-KW, per-file AES-CTR + HMAC decrypt/encrypt |
| `src/pbkdf2.js` | Pure-JS PBKDF2 (SHA-1/256; SHA-512 via WebCrypto) for runtimes that cap rounds |
| `src/ofocus.js` | Unzip + parse `contents.xml`, replay ops into the model; rich-text notes to text |
| `src/query.js` | Read tools and formatting; floating-date handling |
| `src/chain.js` | Transaction-name chain analysis: apply order (parents first; file-name order is not enough when linked transactions share a second), heads, consistency |
| `src/write.js` | Transaction builders and `commit()` (chain checks, verify, temp upload + MOVE) |
| `src/writetools.js` | Write tools and `get_attachment` |
| `src/repeat.js` | RRULE next-occurrence engine for repeating actions |
| `src/inspect.js` | `inspect_sync` diagnostics (chain, `.client` files, key slots, `data/`, raw XML search) |
| `scripts/dump.mjs` | Local debug: download (or `--dir`), decrypt, replay, report fields/dates/timings |
| `test/` | `node --test`; in-memory WebDAV; `fixtures/encrypted.ofocus` made by `fixtures/encrypt_ofocus.py`, checked by `fixtures/decrypt_ofocus.py` (independent Python, needs `cryptography`; skipped if missing) |

### OmniFocus sync format, as verified on a real database (OmniFocus 4.10)

- Folder: `YYYYMMDDHHMMSS=<parent ids…>+<own id>.zip` transactions (ids are 11
  chars `[A-Za-z0-9_-]`; merges list two parents); after compaction one base
  file `00000000000000=<old>+<head>.zip`. `<client id>.client` plists per
  device with `tailIdentifiers` (the device's sync position); `*.capability`
  files (`delta_transactions`, `floating_time_zones`, `stable_repeats`,
  `v4_7_features`, …); `encrypted`; `data/` attachments.
- `contents.xml`: `<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2" app-id=… app-version=…>`
  with `task`, `context` (tags), `folder`, `task-to-tag`, `attachment`,
  `setting`, `perspective` elements. No `op` = insert (all fields, fixed
  order); `op="update"` = delta with `<added>`, `<modified>` and only the
  changed fields (structural fields `project`/`inbox`/`task` first);
  `op="delete"`; `op="reference"` with a `<reference-snapshot>` (OmniFocus
  writes these next to related changes; treat as no-op).
- Projects are tasks with a `<project>` block (`folder`, `singleton`,
  `last-review`, `next-review`, `review-interval`, `status`
  active/inactive/done/dropped). Dropped = `<hidden>` date.
- Dates: `due`/`start`/`planned` floating local (`2026-12-02T23:59:00.000`);
  `added`/`modified`/`completed`/`hidden` UTC with `Z`. Default times are
  settings `DefaultDueTime`, `DefaultStartTime`.
- Tags: the task's first tag is `<context idref>`; each tag is a
  `task-to-tag` with id `<task>.<tag>` and string `rank-in-task` (`0001`).
- Repeats: completing keeps the original id on the *completed* item and
  creates the next occurrence as `<id>.<next-clone-identifier>`; fields
  `repetition-rule` (RRULE), `repetition-method`
  (`fixed`/`due-after-completion`/`start-after-completion`),
  `repetition-schedule-type`, `repetition-anchor-date` (`dateDue` seen).
- Notes: `<text><p><run><lit>…</lit></run></p></text>`; an attachment is shown
  where the note has `<cell refid="<attachment id>" name="…"/>`.
- Attachments: `<attachment>` (task, name, `data-identifier` =
  `data-<sha256 of the file>`) and `data/data-<sha256>.zip` (encrypted zip with
  one entry, the original file name).
- Encryption: PBKDF2 with ~1.3 M rounds; key slots ActiveAES_CTR_HMAC +
  PlaintextMask (unencrypted `.client`, etc.). Attachments we add have no
  `<preview-image>`; OmniFocus shows them fine.

Tested end to end on the real database: every write tool, read back and
accepted by OmniFocus on a Mac (its `.client` tail moved past each
transaction; it merged a concurrent branch with ours).

**Not yet seen in real data (format assumed):** a tag inside a tag created by
OmniFocus, completed/dropped project status written by OmniFocus, deletions,
`repetition-anchor-date` for defer-based repeats (`dateToStart` assumed).

### Debugging against a real database

- `inspect_sync` (via MCP or curl): chain heads, devices' positions, key slots,
  `data/`; `{"all_files": true}` lists every transaction file name in the
  order applied (default: the newest 15), `{"name_filter": "20261116"}` only
  those containing that text; `{"find": "<regex>"}` returns raw matching elements, e.g.
  `{"find":"op=\"update\"","limit":5}` or `{"find":"<task id=\"ID\""}`.
- `scripts/dump.mjs`: `OFOCUS_URL=… WEBDAV_USER=… WEBDAV_PASS=… npm run dump`
  writes `dump/report.txt`, `model.json`, `tools.txt` (git-ignored; contains
  task data).
- After a write, a device has applied it when its `.client` `tailIdentifiers`
  shows the new id (or a later transaction names it as parent).

### Not supported yet / ideas

Creating or renaming folders, moving projects, completing repeating projects,
alarms, perspectives, RRULE `COUNT`/`BYSETPOS`, attachment preview images.
Old image versions accumulate in the registries (use a "keep most recent N"
policy, not "delete untagged": images are multi-arch indexes).

### Gotchas

- Bump `CACHE_KEY` in `src/store.js` whenever the model's shape changes.
- Some hosts reserve `/healthz`; use `/health`.
- Unknown fields are kept out of the model; to copy an item faithfully (as
  repeat completion does) keep the raw XML you need (e.g. `noteXml`).
- Never write `.client` files or overwrite existing transactions.

## Development

    npm ci
    npm test            # unit + end-to-end tests with an in-memory WebDAV server
    npm start           # local server on :8787 (set the env vars first)
    npm run dump        # see "Debugging against a real database"

# OmniFocus connector for Claude (read-only MCP server)

A remote MCP server that reads your OmniFocus database from your WebDAV sync
folder (including Omni Sync Server and encrypted databases). Run it as a
container on your own server (recommended), or on Cloudflare Workers. Your
WebDAV password stays on that server; Claude only holds a separate access
token.

Tools: `list_inbox`, `list_due`, `list_flagged`, `list_projects`,
`get_project`, `search_tasks`, `list_tags`, `get_task`, `sync_status`.
Nothing writes to your database.

## Running on a VPS (container)

The connector is also a plain-HTTP Node server in a container image, built
and pushed to GitHub Container Registry by `.github/workflows/container.yml`
on every push to `main`:

    ghcr.io/shaneqi/ofcloudmcp:latest      (also :sha-<commit>, amd64 + arm64)

The package is private by default; either make it public (GitHub → your
profile → Packages → ofcloudmcp → Package settings → Change visibility), or
log in on the VPS with a personal access token that has `read:packages`:
`echo <token> | docker login ghcr.io -u <github-user> --password-stdin`.

1. On the VPS, create `.env` (and `chmod 600 .env`):

       OFOCUS_URL=https://sync.omnigroup.com/<account>/OmniFocus.ofocus/
       WEBDAV_USER=<account>
       WEBDAV_PASS=<password>
       ACCESS_TOKEN=<random token>
       # optional:
       # OF_PASSPHRASE=<database passphrase, if not the account password>
       # TIMEZONE=America/Chicago
       # REFRESH_MINUTES=10

2. Start it with `compose.example.yml` (copy it to `compose.yml`), or:

       docker run -d --name omnifocus-mcp --restart unless-stopped \
         --env-file .env -p 127.0.0.1:8787:8787 -v omnifocus-cache:/data \
         ghcr.io/shaneqi/ofcloudmcp:latest

3. Point your HTTPS reverse proxy at `127.0.0.1:8787`. The connector URL in
   Claude is `https://<your-domain>/mcp`, with the request header
   `Authorization: Bearer <ACCESS_TOKEN>`. `GET /healthz` returns `ok`.

On start it loads (and, if encrypted, unlocks) the database in the
background; `docker logs omnifocus-mcp` shows `startup load: … files`. It
then re-reads new transactions every `REFRESH_MINUTES` (default 10), so
requests rarely wait. The parsed database and unlocked file keys are kept in
the `/data` volume (files readable only by the container user), so a restart
does not repeat the slow first load. That volume holds your decrypted task
data: keep it on the VPS and out of backups you share.

Update: `docker compose pull && docker compose up -d`.

## Publishing to Google Artifact Registry (optional)

`container.yml` also pushes the image to Artifact Registry when configured,
e.g. for Cloud Run (which cannot pull from GHCR). One-time setup, in Cloud
Shell (replace PROJECT_ID; region and names are examples):

    PROJECT_ID=my-project
    REGION=us-central1
    gcloud services enable artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT_ID
    gcloud artifacts repositories create containers --repository-format=docker \
      --location=$REGION --project $PROJECT_ID

    # A service account that may only push to that repository
    gcloud iam service-accounts create github-publisher --project $PROJECT_ID
    SA=github-publisher@$PROJECT_ID.iam.gserviceaccount.com
    gcloud artifacts repositories add-iam-policy-binding containers --location=$REGION \
      --project $PROJECT_ID --member=serviceAccount:$SA --role=roles/artifactregistry.writer

    # Workload Identity Federation: let only this GitHub repository act as it
    gcloud iam workload-identity-pools create github --location=global --project $PROJECT_ID
    gcloud iam workload-identity-pools providers create-oidc github --location=global \
      --workload-identity-pool=github --project $PROJECT_ID \
      --issuer-uri=https://token.actions.githubusercontent.com \
      --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
      --attribute-condition="assertion.repository=='ShaneQi/OFCloudMCP'"
    POOL=$(gcloud iam workload-identity-pools describe github --location=global --project $PROJECT_ID --format='value(name)')
    gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT_ID \
      --role=roles/iam.workloadIdentityUser \
      --member="principalSet://iam.googleapis.com/$POOL/attribute.repository/ShaneQi/OFCloudMCP"
    echo "GCP_WORKLOAD_IDENTITY_PROVIDER=$POOL/providers/github"
    echo "GCP_SERVICE_ACCOUNT=$SA"

Then in GitHub, **Settings → Secrets and variables → Actions → Variables**, add
`GCP_PROJECT_ID`, `GAR_LOCATION` (the region), `GAR_REPOSITORY` (`containers`),
and the two values printed above. Optionally `GAR_IMAGE` (default
`omnifocus-mcp`). The next push to `main` (or **Actions → Container image →
Run workflow**) also pushes
`REGION-docker.pkg.dev/PROJECT_ID/containers/omnifocus-mcp:latest`.

Instead of Workload Identity Federation you can store a service account key
as the secret `GCP_SA_KEY`, but a long-lived key is easier to leak.

## Cloudflare Workers (alternative; needs the Workers Paid plan)

### Setup in the browser with Workers Builds

This deploys straight from the GitHub repository with Cloudflare Workers Builds.

1. Sign in to the Cloudflare dashboard (Workers Paid plan; see Limits below).
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

### One-time setup from a terminal (any computer with Node.js 18+)

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

- **Plan limits:** a first load downloads every transaction file and, for an
  encrypted database, runs over a million PBKDF2 rounds (about 1.5 s of CPU).
  That needs the Workers Paid plan's limits; the free plan (10 ms CPU, 50
  outgoing requests per request) is not supported.
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

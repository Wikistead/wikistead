# Self-hosting Wikistead

This guide takes you from a clean machine to a running Wikistead instance — first a
single-host evaluation setup with Docker Compose, then a production deployment on
Kubernetes. It documents what the code in THIS repository actually does; where a
production hardening step is still tracked by an open ticket, the gap is called out
instead of glossed over.

## What you are deploying

Wikistead is three application processes over five infrastructure services:

| Component | Role | Image / source |
|---|---|---|
| `web` | Static SPA (Vite + React + CodeMirror) | built from `apps/web` |
| `server` | Fastify API — tenants, spaces/pages, search, share links, billing, MCP | built from `apps/server` |
| `collab` | Hocuspocus WebSocket server — real-time CRDT editing | built from `apps/collab` |
| Postgres 16 | App database (row-level-security tenant isolation) + OpenFGA datastore | `postgres:16` |
| Valkey | Collab scale-out + rate limiting + short-lived flow state | `valkey/valkey:8` |
| OpenFGA | Authorization (ReBAC) — **the** source of truth for permissions | `openfga/openfga` |
| Meilisearch | Full-text search (single index, tenant tokens) | `getmeili/meilisearch:v1.10` |
| SeaweedFS | Default S3-compatible object storage (attachments, revision snapshots) | `chrislusf/seaweedfs` — swappable for S3 / R2 |
| SMTP (optional) | Invitation / notification email | any relay; dev uses Mailpit |
| Kroki (optional) | Server-side PlantUML rendering | `yuzutech/kroki` |

Two invariants shape every deployment:

1. **One origin.** Web, `/api`, and `/collab` must be served from the same origin
   through a reverse proxy — the session cookie is a host-only BFF cookie and the
   collab WebSocket is same-host. Never expose `server:4000` or `collab:4100`
   directly.
2. **OpenFGA must run on a persistent datastore** (Postgres — never the in-memory
   engine: a restart would silently erase every permission in the system). The
   compose file wires this with a host volume; on Kubernetes that means a
   PVC-backed StatefulSet or a managed/operator database — a Postgres pod without
   a volume loses the app database AND every permission on restart.

## Requirements

- Docker + Docker Compose (evaluation) or a Kubernetes cluster with an nginx
  ingress controller + cert-manager (production).
- Node.js 22+ and pnpm only if you build images yourself. Running migrations does
  not need them — the server image carries the schema and can apply it.
- An OIDC identity provider for member login (anything spec-compliant: Authentik,
  Keycloak, Entra ID, Google, …). Guests via share links need no IdP.
- DNS: one host per deployment, plus per-tenant subdomains if you use them
  (wildcard TLS requires DNS-01 — see “TLS” below).

## Quickstart (single host, Docker Compose)

```bash
git clone <this-repo> wikistead && cd wikistead
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local   # web → API host wiring (tenant routing)
```

Edit `.env` — every value marked `change_me` must change. **Three of them are refusals, not advice**:
under `NODE_ENV=production` (which the `apps` profile pins) the server checks them against the values
published in this repository's fixtures and refuses to start on a match.

```bash
# 32-byte AES key for encrypting tenant OIDC client secrets at rest (server refuses to boot without it)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → OIDC_SECRET_ENC_KEY

# signs anonymous share-link tokens; keep the TTL short (it bounds the post-revoke window)
openssl rand -base64 32                                                        # → GUEST_TOKEN_SECRET

# the search master key. Set it BEFORE `pnpm dev:up`: the Meilisearch container takes it from this
# same file, so changing it afterwards leaves the server unable to authenticate to search.
openssl rand -base64 24                                                        # → MEILI_MASTER_KEY
```

Also set real values for `S3_ACCESS_KEY`/`S3_SECRET_KEY` (the compose file hands the same pair to
the bundled SeaweedFS at startup, so changing them in `.env` is the whole move — and production
refuses to boot on the published `wksadmin` fixture pair) and your IdP under the `OIDC_*` keys. `DATABASE_URL` is the restricted runtime role;
`DATABASE_ADMIN_URL` is used only by the migration runner — keep it out of app
processes.

Then:

```bash
pnpm install
pnpm dev:up          # docker compose up -d + first-run bootstrap (idempotent):
                     #   - builds the workspace packages (a fresh clone has no dist/)
                     #   - migrates + seeds the app database
                     #   - creates the OpenFGA store + authorization model
                     #   - pins OPENFGA_STORE_ID / OPENFGA_MODEL_ID into .env
docker compose --profile apps up -d --build   # web, server, collab and the reverse proxy
# optional: server-side PlantUML rendering
docker compose --profile diagrams up -d       # Kroki; set PLANTUML_RENDER_URL=http://localhost:8005
```

Open **https://dev.localhost**.

Three things about that URL, because each one is a way the stack silently does not work:

- **One origin, and the proxy is not optional.** The SPA calls a relative `/api`, so a web container
  on its own answers its own page to every API call. `--profile apps` starts a Caddy in front, and
  nothing else publishes a port.
- **HTTPS, and the browser will warn once.** The profile runs with `NODE_ENV=production`, which makes
  the session cookie `secure` — over plain `http://` the browser drops it and sign-in fails with no
  error at all. Caddy issues an internal certificate for a `.localhost` name without contacting a CA;
  `caddy trust` (on the host, from a Caddy install) adds it to your trust store and the warning goes.
- **A different host is one variable.** `SITE_HOST=app.example.com docker compose --profile apps up -d`
  serves that name and gets a real certificate over ACME instead — which needs the name to resolve to
  the machine from the public internet.

Nobody can sign in yet: the first administrator is made below.

The bootstrap (`scripts/dev-setup.mjs`) is safe to run repeatedly: on an existing
volume it detects the store and does nothing. Because OpenFGA persists to
Postgres, a plain restart never needs re-bootstrapping; only `docker compose down
-v` (volume wipe) re-triggers it.

`deploy/caddy/Caddyfile` is the proxy the `apps` profile runs, and it is also the reference for
running one yourself (`caddy run --config deploy/caddy/Caddyfile` with `SITE_HOST` / `*_UPSTREAM`
set). Its routes are checked against `infra/routes/origin-routes.mjs` on every commit, so this
stack and a production edge answer the same paths by construction — including `s3.<SITE_HOST>`, which
is how the browser reaches attachment uploads: a presigned URL's signature covers the host, so the
object store needs a public name of its own rather than a path on the app.

The same holds on Kubernetes: the base manifests and the Helm chart serve `s3.<host>` from a third
Ingress object (no rewrite — the path is part of what was signed) and the server signs with it
(`S3_PUBLIC_ENDPOINT`). If your certificate covers only one label (`*.example.com` behind a proxy
cannot serve `s3.app.example.com`), give the store a one-label name instead — the chart's
`seaweedfs.publicHost` — and the server, the Ingress and the gateway's allowed origins follow it. A
deployment that skips this signs every upload for a cluster-internal name, and pasting an image
silently does nothing.

## Production (Kubernetes)

Kubernetes manifests are not shipped: the compose file above is the reference
topology (the six services plus the two invariants), and any manifests that
express it work. What production needs beyond the compose defaults:

- **Secrets**: provide the runtime env (database URLs, `MEILI_MASTER_KEY`,
  S3 keys, `OIDC_SECRET_ENC_KEY`, `GUEST_TOKEN_SECRET`, SMTP, Stripe) through
  your cluster's secret tooling (Kubernetes Secrets, SOPS, sealed-secrets,
  an external manager — your choice). Never commit real credential values.
- **Postgres / OpenFGA**: run OpenFGA against Postgres (the persistent ENGINE is
  mandatory) on a PVC-backed StatefulSet or a managed/operator Postgres
  (CloudNativePG etc.) — never a volume-less Deployment. On first deploy, create
  the store + write `infra/openfga/model.fga`, then set
  `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` in the server/collab env. The server
  asserts the datastore/model at boot and refuses to start misconfigured.
- **Storage**: point `S3_*` at managed object storage (S3/R2), or at a SeaweedFS
  you give a PersistentVolume (keep `AWS_*_CHECKSUM_*=WHEN_REQUIRED` so browser
  presigned PUTs work).
- **Ingress / TLS**: route `/`, `/api`, and `/collab` on ONE host (the
  same-origin invariant), with WebSocket upgrade, sticky sessions and ≥1h
  read timeouts on `/collab`. Per-tenant subdomains ride the same services via
  the Host header; a wildcard cert needs DNS-01 — until then use explicit hosts.
- **Migrations**: apply them as a release step, before the new code serves
  traffic. Migrations are idempotent and ordered, and re-running is safe, so run
  them on every upgrade. **From the image** — no checkout needed:

  ```bash
  docker run --rm -e DATABASE_ADMIN_URL=postgres://... <server-image> node dist/migrate.js
  ```

  On Kubernetes the same command is a Job (or `kubectl exec` into a server pod)
  against the image the release is rolling out, so the schema and the code that
  expects it come from one artifact. From a checkout the equivalent is
  `pnpm --filter @wikistead/server migrate`. The SQL lives in
  `infra/db/migrations` and is copied into the image at `/app/migrations`; set
  `MIGRATIONS_DIR` if you keep it somewhere else. The runner needs the admin
  role (`DATABASE_ADMIN_URL`) — the runtime role deliberately cannot create
  tables.

## First tenant and sign-in

Members authenticate via **per-tenant OIDC**: each tenant registers its issuer /
client / JWKS in the admin console (`/admin` → Auth), and the server validates
against that tenant's registered configuration at request time. Auto-enrollment
policy (open / verified email domain / IdP groups / invite-only) is configured in
the same place; email-domain enrollment requires a DNS-TXT ownership challenge.

For evaluation, the compose bootstrap seeds a `dev` tenant (host `dev.localhost`)
wired to whatever IdP your `OIDC_*` env points at. Guests never touch the IdP —
share links mint short-lived app-signed tokens (`GUEST_TOKEN_SECRET`).

### Connecting an identity provider

What to register **on the IdP side**, before filling in the console:

| The IdP asks for | Give it |
|---|---|
| Redirect / callback URI | `https://<the workspace's host>/auth/callback` |
| Scopes | `openid email profile` (the default; the console can change it) |
| Response type / flow | Authorization code with PKCE |
| Client type | Confidential (a client secret) or public (no secret) — both work |

**The redirect URI is derived from the request**, not from configuration: the server
builds it as `<scheme>://<host>/auth/callback` for whichever host the browser used.
A workspace reached on two hosts (for example after moving to a custom domain) needs
**both** registered at the IdP. The console shows the URI for the host you are on;
that is the value to paste, and there is nothing to type back.

**A second redirect URI is needed for account-settings linking**: a
member adding this connection to an account they already have completes the round
trip at `<scheme>://<host>/auth/link-callback`, not `/auth/callback` — register
**both** on any IdP that allowlists redirect URIs (most do). Omitting the second one
does not break ordinary sign-in; it only breaks the "link this sign-in method" button
in account settings, which fails at the IdP before reaching this product's code.

**Discovery is required.** Only the issuer URL is configured, and the server fetches
`<issuer>/.well-known/openid-configuration` to find the authorization, token and JWKS
endpoints. There is no manual-endpoint mode. Enabling a connection **fails with a 400
if discovery fails** — deliberately, since a broken IdP that saves cleanly locks out
every future login.

That fetch is SSRF-hardened: **https only, no private or link-local addresses**, no
redirects, no credentials, a 5-second timeout and a 256 KiB cap. A self-hosted IdP on
a private network therefore needs the operator (not a tenant admin) to set
`OIDC_ALLOW_PRIVATE_ISSUER=1`.

**Claims the server reads** from the verified `id_token`

| Claim | Used for |
|---|---|
| `sub` | the member's identity (prefixed per connection — see the invite note below) |
| `email` | the member's address; `email_verified` gates domain auto-enrolment |
| `name` | the display name (the IdP is authoritative; the member may override it) |
| `picture` | the avatar shown on the collab cursor and member list |
| `groups` | group sync, when the connection trusts groups |

The groups claim's **name** is configurable per connection (blank means `groups`,
which is what Authentik and Keycloak emit; Entra ID and others often use `roles`).
Its **value must be a JSON array of strings** — a comma-separated string is not
accepted. Entries are trimmed, de-duplicated and bounded (at most 100 groups, 200
characters each); anything dropped is logged rather than silently ignored. Group sync
only happens when the connection is marked as trusting groups, because the claim
rides a token the IdP controls.

**Presets.** Google and Microsoft are offered as presets: the issuer and branding are
fixed by the product, so only the client id and secret are needed (Entra additionally
needs its directory GUID). Any other provider is configured with an issuer URL.

**Sign-out is local.** `POST /auth/logout` destroys the Wikistead session and clears
the cookie; it does not call the IdP's end-session endpoint, so a member who signs
out here is still signed in to the IdP and can return without re-entering
credentials. If your policy needs a full single sign-out, drive it from the IdP.

### Making the first admin of a new tenant

```
pnpm --filter @wikistead/server tenant:local-admin <tenant-slug> <email> --create [--plan=free] [--by=<you>] --origin=https://wiki.example.com
```

It creates the tenant, turns password sign-in on for it, and prints a **first-admin
invite link**. Hand that link to the person: they set a password, and they are the
tenant's administrator. From there they configure OIDC in the admin console and can
turn password sign-in back off.

**`--origin` is the address that goes into that link**, and on a single-host
deployment you have to pass it: the host you serve on is the only one that resolves,
and without it the command has nothing to compose an address from and refuses rather
than printing a link nobody can open. (A deployment that serves workspaces under a
wildcard can declare the shape once instead — `WKS_TENANT_URL_TEMPLATE`, in the
configuration reference — and then `--origin` is optional.)

**Name the workspace after the host's first label.** Serving one workspace at
`wiki.example.com` means calling it `wiki`: workspaces are resolved from the first
label of the hostname, so that address already works, with no wildcard DNS and no
second certificate.

⚠️ **Hosts whose first label is a reserved word are not supported today.** `docs`,
`app`, `www`, `api`, `help`, `blog`, `admin`, `status` and `dev` cannot be used as
workspace names, so `docs.example.com` — a likely address for a knowledge base —
has no way to reach a workspace at present. Registering it as a custom domain is not
a way around it either: that is done from the admin console, which is itself reached
through a host that already resolves. Serve on a host whose first label is not
reserved until this is addressed.

**Self-serve signup is not part of this profile.** The compose deployment ships
without a platform identity provider, so there is no "create your own workspace"
front door: workspaces are made with the command above. A deployment that does add
one must also declare `WKS_TENANT_URL_TEMPLATE`, or self-serve creation stays closed
— a workspace nobody can be sent to is not worth creating.

The command does not take a subject id, and cannot. A tenant's sign-in connections
stamp a prefix onto the subjects that arrive through them, so the id a real login
carries is not one an operator can type — passing the "right" one is refused, and
passing one that is accepted creates an administrator nobody can sign in as. The
invite is what makes the account real.

Run it with the same admin database credentials as the other `tenant:` commands. It
bypasses RLS, has no HTTP surface, and records what it did in the operator ledger.

### Recovering a tenant nobody can get into

The same command without `--create` works on an existing tenant that has no
administrator — after a restore, or one that was provisioned and never used:

```
pnpm --filter @wikistead/server tenant:local-admin <tenant-slug> <email> --origin=https://wiki.example.com
```

For the evaluation stack that is `… tenant:local-admin dev you@example.com --origin=http://dev.localhost:5173` — the seeded `dev` tenant
on `dev.localhost`, with no `--create`. (`dev` is a reserved slug and cannot be *created* as a tenant
name; recovering the one the seed already made is a different act and is allowed.)

If that tenant requires SSO, the recovery goes past that requirement to issue the
invite, **says so in its output**, and records it in the operator ledger as a
separate entry. It does not switch the requirement off: the tenant's policy still
applies to everybody else, and to the recovered administrator as soon as they are
in. Only the one invite link is exempt, and it expires on the invite's own schedule.

If a tenant's OIDC config locks everyone out, see
`docs/runbooks/tenant-oidc-lockout-recovery.md`.

## Configuration reference

**[`docs/generated/environment-variables.md`](generated/environment-variables.md) is the complete list** — every
variable this product reads, with its default and what it does, generated from the code itself, so a
knob added in a release is in it. `.env.example` is the smaller set a fresh checkout needs to start.

The ones a deployment almost always sets:

| Variable | Notes |
|---|---|
| `DATABASE_URL` / `DATABASE_ADMIN_URL` | runtime (restricted, RLS-bound) vs migration (admin) roles — never swap them |
| `VALKEY_URL` | collab scale-out, rate limits, publish flush, OAuth flow state |
| `OPENFGA_API_URL` / `OPENFGA_STORE_ID` / `OPENFGA_MODEL_ID` | filled by bootstrap; server boot-asserts them |
| `MEILI_HOST` / `MEILI_MASTER_KEY` | search; the server derives scoped tenant tokens |
| `S3_*` + `AWS_*_CHECKSUM_*` | SeaweedFS default; set endpoint/keys for S3 or R2 |
| `OIDC_SECRET_ENC_KEY` | **required**; AES-256 key for tenant OIDC secrets at rest |
| `GUEST_TOKEN_SECRET` / `GUEST_TOKEN_TTL_SECONDS` | share-link token signing; short TTL bounds the revocation window |
| `SMTP_*` / `EMAIL_FROM` | leave `SMTP_HOST` empty to disable email (invites become copy-links) |
| `WKS_PUBLIC_BASE_URL` | the zone **above** your site host — see below. Unset (the shipped default) means mention and digest mail is not sent |
| `STRIPE_*` | Cloud billing only; leave empty when self-hosting (CE is unlimited) |
| `PLANTUML_RENDER_URL` | optional Kroki-compatible base URL; unset → PlantUML fences degrade to source |
| `METRICS_TOKEN` / `METRICS_PORT` | Prometheus `/metrics` on its own listener (default port 9464, never published by the ingress); unset token = metrics off, said at boot — see Operations |

### Mention and digest email needs an address to link to

Background email has no request to take a host from, so it composes one — and the composition
prefixes the workspace's slug. **The shipped compose profile sets nothing**, which means those two
kinds of mail are **not sent** rather than sent with a link that goes nowhere. (Invitations, password
setup and recovery mail carry no such link and are unaffected.)

To turn them on, put one line in `docker-compose.override.yml` naming **the zone above your site
host**:

```yaml
services:
  server:
    environment:
      WKS_PUBLIC_BASE_URL: https://example.com     # for SITE_HOST=wiki.example.com
```

The composed address is then `https://wiki.example.com` — your site host itself, which the shipped
Caddyfile already serves. No wildcard DNS, no second certificate.

⚠️ **Two things this rests on, and nothing checks either.** It works because your one workspace is
named after the host's first label (`wiki`), and because the parent zone is yours. If you create a
second workspace, its mail will point at a host nobody serves. If the parent zone is shared with
other people — a free subdomain provider, a company zone you do not control — then one-click
unsubscribe links, which carry a token, are delivered to somebody else's host.

The override file is the mechanism because the compose file pins the value in the service's own
`environment:`, which wins over `.env`.

## Operations

- **Upgrades**: pull, rebuild images, run migrations, roll the deployments. The
  authorization model in `infra/openfga/model.fga` is versioned — when a release
  notes a model change, write the new model to your store and update
  `OPENFGA_MODEL_ID` (model writes are additive; old model ids stay valid until
  you switch).
- **Backups**: back up Postgres (app database AND the OpenFGA database) and the
  object-storage bucket together. A step-by-step backup/restore runbook is not
  published yet.
- **Health**: `server` exposes `healthz`/`readyz`; deep dependency-readiness
  checks are not implemented yet — keep infra-level probes on Postgres/OpenFGA/Meili
  in the meantime.
- **Metrics**: `server` exposes Prometheus text on **its own listener**,
  `:9464/metrics` (`METRICS_PORT`), bearer-gated by `METRICS_TOKEN`. It is a separate
  port on purpose: the ingress publishes only the API port, so the exposition is
  reachable from inside your cluster or network and nowhere else. Leave the token
  unset and the route does not exist — the server logs `metrics: disabled` at boot
  so you can tell that state from a wrong token. To scrape:

  ```yaml
  scrape_configs:
    - job_name: wikistead
      bearer_token: <the METRICS_TOKEN value>
      static_configs: [{ targets: ["server:9464"] }]
  ```

  Labels never carry a workspace, member, page or space identifier — only the route
  template, method and status class — so the exposition is safe to ship to a shared
  Prometheus. The Helm chart mints `metrics-token` into its generated secret; with
  the k8s base, add the `metrics-token` key to `kb-secrets` (it is optional). The
  compose profile does not publish the port; add one to `docker-compose.override.yml`
  if your Prometheus is outside the compose network.
- **Tracing**: `server` speaks OpenTelemetry, off by default. Set
  `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://tempo:4318`, any OTLP/HTTP
  collector — Jaeger, Tempo, or a vendor's OTLP ingest) and it exports one span
  per request with child spans for the tenant connection acquire, OpenFGA,
  Meilisearch, object storage and the outbox drains (individual SQL statements
  are not spans yet). With the variable unset nothing is loaded and nothing is
  recorded — the boot log says `[tracing] disabled` so a mistyped variable name
  is visible. Spans carry route templates, never tenant, user or page
  identifiers. `OTEL_SERVICE_NAME` (default: the product name plus `-server`)
  and `OTEL_EXPORTER_OTLP_HEADERS` apply. The server honours an inbound W3C
  `traceparent` header, the standard behaviour — which also means any client
  can mark its own requests as not-sampled, or join a trace id of its choosing;
  strip the header at your edge for traffic you do not trust.
- **Pre-production gate**: before going live, walk the items that can only be
  verified in a real environment — cookie scoping across tenant subdomains,
  XFF trust, WS timeouts, noindex behaviour, and rate-limit fan-out across
  replicas.

## Where the user documentation lives

This file is the CE-repo deployment guide. The end-user documentation site
(getting started, editor guide, feature docs) is maintained in the private
docs-site repository and published
separately.

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
- Node.js 20+ and pnpm only if you build images yourself or run migrations from a
  checkout.
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

Edit `.env` — every value marked `change_me` must change, and two are mandatory:

```bash
# 32-byte AES key for encrypting tenant OIDC client secrets at rest (server refuses to boot without it)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → OIDC_SECRET_ENC_KEY

# signs anonymous share-link tokens; keep the TTL short (it bounds the post-revoke window)
openssl rand -base64 32                                                        # → GUEST_TOKEN_SECRET
```

Also set real values for `MEILI_MASTER_KEY`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, and
your IdP under the `OIDC_*` keys. `DATABASE_URL` is the restricted runtime role;
`DATABASE_ADMIN_URL` is used only by the migration runner — keep it out of app
processes.

Then:

```bash
pnpm install
pnpm dev:up          # docker compose up -d + first-run bootstrap (idempotent):
                     #   - migrates + seeds the app database
                     #   - creates the OpenFGA store + authorization model
                     #   - pins OPENFGA_STORE_ID / OPENFGA_MODEL_ID into .env
docker compose --profile apps up -d --build   # build + run web/server/collab in containers
# optional: server-side PlantUML rendering
docker compose --profile diagrams up -d       # Kroki; set PLANTUML_RENDER_URL=http://localhost:8005
```

The bootstrap (`scripts/dev-setup.mjs`) is safe to run repeatedly: on an existing
volume it detects the store and does nothing. Because OpenFGA persists to
Postgres, a plain restart never needs re-bootstrapping; only `docker compose down
-v` (volume wipe) re-triggers it.

Put a reverse proxy in front for anything beyond localhost evaluation:
`deploy/caddy/Caddyfile` is a ready-made single-host config with automatic ACME
TLS (`caddy run --config deploy/caddy/Caddyfile` with `SITE_HOST` /
`*_UPSTREAM` env set).

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
- **Migrations**: run `pnpm --filter @wikistead/server migrate` against the prod
  database (with `DATABASE_ADMIN_URL`) as a release step — migrations are
  idempotent and ordered (`infra/db/migrations`). Re-run on every upgrade.

## First tenant and sign-in

Members authenticate via **per-tenant OIDC**: each tenant registers its issuer /
client / JWKS in the admin console (`/admin` → Auth), and the server validates
against that tenant's registered configuration at request time. Auto-enrollment
policy (open / verified email domain / IdP groups / invite-only) is configured in
the same place; email-domain enrollment requires a DNS-TXT ownership challenge.

For evaluation, the compose bootstrap seeds a `dev` tenant (host `dev.localhost`)
wired to whatever IdP your `OIDC_*` env points at. Guests never touch the IdP —
share links mint short-lived app-signed tokens (`GUEST_TOKEN_SECRET`).

### Making the first admin of a new tenant

```
pnpm tenant:local-admin <tenant-slug> <email> --create [--plan=free] [--by=<you>]
```

It creates the tenant, turns password sign-in on for it, and prints a **first-admin
invite link**. Hand that link to the person: they set a password, and they are the
tenant's administrator. From there they configure OIDC in the admin console and can
turn password sign-in back off.

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
pnpm tenant:local-admin <tenant-slug> <email>
```

If that tenant requires SSO, the recovery goes past that requirement to issue the
invite, **says so in its output**, and records it in the operator ledger as a
separate entry. It does not switch the requirement off: the tenant's policy still
applies to everybody else, and to the recovered administrator as soon as they are
in. Only the one invite link is exempt, and it expires on the invite's own schedule.

If a tenant's OIDC config locks everyone out, see
`docs/runbooks/tenant-oidc-lockout-recovery.md`.

## Configuration reference

`.env.example` is the authoritative, commented list. The highlights:

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
| `STRIPE_*` | Cloud billing only; leave empty when self-hosting (CE is unlimited) |
| `PLANTUML_RENDER_URL` | optional Kroki-compatible base URL; unset → PlantUML fences degrade to source |

## Operations

- **Upgrades**: pull, rebuild images, run migrations, roll the deployments. The
  authorization model in `infra/openfga/model.fga` is versioned — when a release
  notes a model change, write the new model to your store and update
  `OPENFGA_MODEL_ID` (model writes are additive; old model ids stay valid until
  you switch).
- **Backups**: back up Postgres (app database AND the OpenFGA database) and the
  object-storage bucket together. A step-by-step backup/restore runbook is
  tracked in #403.
- **Health**: `server` exposes `healthz`/`readyz`; deep dependency-readiness
  checks are tracked in #400 — keep infra-level probes on Postgres/OpenFGA/Meili
  in the meantime.
- **Pre-production gate**: before going live, walk the items that can only be
  verified in a real environment — cookie scoping across tenant subdomains,
  XFF trust, WS timeouts, noindex behaviour, and rate-limit fan-out across
  replicas.

## Where the user documentation lives

This file is the CE-repo deployment guide. The end-user documentation site
(getting started, editor guide, feature docs) is maintained in the private
docs-site repository and published
separately; see #180 for the bridge between generated reference material and
that site.

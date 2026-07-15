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

Two invariants shape every deployment (details: `deploy/README.md`, ADR-016/039):

1. **One origin.** Web, `/api`, and `/collab` must be served from the same origin
   through a reverse proxy — the session cookie is a host-only BFF cookie and the
   collab WebSocket is same-host. Never expose `server:4000` or `collab:4100`
   directly.
2. **OpenFGA must run on a persistent datastore** (Postgres — never the in-memory
   engine: a restart would silently erase every permission in the system). The
   compose file wires this with a host volume. **The k8s base does NOT persist it:
   its Postgres is a dev-convenience Deployment with no PVC** — a pod restart
   loses the app database AND every permission. For production you must supply a
   durable Postgres yourself (StatefulSet + PVC, or a managed/operator database —
   tracked as the #423 launch blocker; backup/restore is #403).

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

Manifests live in `deploy/k8s` as a Kustomize base + overlays; `deploy/argocd`
adds an optional app-of-apps. Follow `deploy/README.md` for the proxy/ingress
rules — the short version:

```bash
# straight kustomize
kubectl apply -k deploy/k8s/overlays/prod
# or GitOps
kubectl apply -f deploy/argocd/project.yaml
kubectl apply -f deploy/argocd/app-of-apps.yaml
```

Before applying, walk the overlay and replace every `CHANGE_ME` (git URL, image
registry, hosts) and every dev credential:

- **Secrets**: the base references `kb-secrets` (database URLs, `MEILI_MASTER_KEY`,
  S3 keys, `OIDC_SECRET_ENC_KEY`, `GUEST_TOKEN_SECRET`, SMTP, Stripe). Manage them
  with your cluster's secret tooling. Note: encrypting the OpenFGA datastore URI
  with SOPS+age is tracked in #147 and not yet wired — do not commit real
  credentials to a fork until it lands, or wire your own SealedSecrets/SOPS.
- **Postgres / OpenFGA**: the base runs OpenFGA against Postgres (the persistent
  ENGINE is mandatory), **but the base's Postgres itself is ephemeral — a plain
  Deployment with no data volume** (dev convenience, exactly like the SeaweedFS
  note below). For production, replace it with a StatefulSet + PVC or a managed/
  operator Postgres (CloudNativePG etc.) BEFORE putting data in — a pod restart
  on the base manifest wipes the app database and every permission (#423 tracks
  wiring this in-repo; #403 tracks backup/restore). On first deploy, create the
  store + write `infra/openfga/model.fga`, then set
  `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` in the server/collab env. The server
  asserts the datastore/model at boot and refuses to start misconfigured.
- **Storage**: the base ships SeaweedFS (single binary, S3 gateway) with an
  `emptyDir` — for production either give it a PersistentVolume or, preferably,
  point `S3_*` at managed object storage (S3/R2; keep
  `AWS_*_CHECKSUM_*=WHEN_REQUIRED` so browser presigned PUTs work).
- **Ingress / TLS**: `deploy/k8s/base/ingress.yaml` routes `/api`, `/collab`
  (WS + sticky sessions + 1h timeouts), and `/` on one host, with cert-manager
  TLS. Per-tenant subdomains ride the same services via the Host header; a
  wildcard cert needs DNS-01 (#235, open) — until then use explicit hosts.
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
wired to whatever IdP your `OIDC_*` env points at. For a fresh production tenant,
create the tenant row + OIDC config through the signup/enrollment flow, then
promote the first member to tenant admin. Guests never touch the IdP — share
links mint short-lived app-signed tokens (`GUEST_TOKEN_SECRET`).

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
- **Pre-production gate**: a checklist of items that can only be verified in a
  real environment (cookie scoping across tenant subdomains, XFF trust, WS
  timeouts, noindex behaviour, rate-limit fan-out across replicas, …) lives in
  `docs/runbooks/prelaunch-deploy-gate.md`. Walk it before going live.

## Where the user documentation lives

This file is the CE-repo deployment guide. The end-user documentation site
(getting started, editor guide, feature docs) is maintained in the private
docs-site overlay repository (`docs-site/`, see ADR-084) and published
separately; see #180 for the bridge between generated reference material and
that site.

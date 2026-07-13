# wikistead

Self-hostable, multi-tenant **collaborative knowledge-base SaaS**. Markdown-based
editor with two surfaces over one CRDT document: a **vim** source+preview surface
for technical users and an **Obsidian-style live-preview** surface for everyone
else. Core differentiator: **anonymous real-time co-editing via share links**.

Built to ship **closed-source or open-core** — every dependency is permissive
(MIT / Apache-2.0 / BSD / ISC), enforced by a CI license allowlist.

## Locked architecture (see prompt + ADRs)
| Concern | Decision |
|---|---|
| Authorization | **OpenFGA** (ReBAC). Space→page inheritance, per-page override, groups, share-link subjects with time Conditions. |
| Guests | App-signed short-lived **share tokens** (never OIDC accounts, never billing seats). Each token is bound to exactly one resource (page or space). Revoke = delete the `resource:X#relation@share_link:Y` tuple (1 op); expiry = `non_expired` Condition on the tuple. |
| Members | **OIDC — any compliant IdP, configured per tenant** (password, Google, Microsoft, SAML-bridged, etc.). The app validates against each tenant's registered JWKS; no specific IdP is mandated. |
| Billing | **Stripe**; entitlement layer separate from authz (free→paid guest access is one setting). |
| Tenancy | **Hybrid, method-agnostic**: logical (RLS) default, namespace promotion for enterprise. App never branches on it. |
| Editing | Single canonical **`Y.Text`** + **CodeMirror 6** two surfaces (vim / live-preview). No block UI, no CRDT-type bridging. |
| Realtime | **Yjs + Hocuspocus**, scaled via **Valkey**. Local edit target <16ms; remote propagation is a separate SLO. |
| Search | **Meilisearch** (single index + tenant tokens). Denormalized viewer ACL filter → confirm the displayed dozen via OpenFGA → revoke = sync reindex (outbox). |
| Storage | **S3-compatible** abstraction; default OSS impl **SeaweedFS** (Apache-2.0, see ADR-014), swappable for R2 / S3. Tenant key-prefixing, browser presigned PUT/GET. |

## Layout
```
apps/
  server/   Fastify API — tenant resolver, spaces/pages, billing, search, storage,
            revisions, public render, API keys, share links (all wired, tested)
  collab/   Hocuspocus — onAuthenticate (member + guest tokens), RLS-scoped ydoc
            persistence, interval-gated revision snapshots, Valkey restore channel
  web/      Vite + React + CodeMirror — isolated <Editor/> (vim + live-preview over
            one Y.Text), sidebar tree, search, share UI, attachments
packages/
  types/    shared domain contracts
  auth/     guest token mint/verify + OIDC member verification
  authz/    OpenFGA primitives (check / filterAuthorized / tuple writes)
  events/   typed event bus (CE extension boundary)
  hooks/    CE extension hook points
  entitlements/  plan → limits resolution, separate from authz
infra/openfga/model.fga   authorization model (DSL, see ADR-002)
infra/db/migrations/      001 tenants … 011 page nesting
docs/adr/                 ADR-000 … ADR-014
deploy/                   Kustomize base + dev/prod overlays + ArgoCD app-of-apps
docker-compose.yml        full local middleware stack
```

## Local development
```
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local   # web → API on dev.localhost (tenant routing)
pnpm install
pnpm dev:up                    # up the middleware + idempotently bootstrap OpenFGA (store/model/tuples → .env)
pnpm --filter @wikistead/server migrate        # apply DB migrations
pnpm --filter @wikistead/server db:seed        # demo tenant / space / page
pnpm dev                       # runs server + collab + web on the host
```
`pnpm dev:up` is `docker compose up -d` + `dev:setup` (the idempotent FGA bootstrap). OpenFGA runs on the
**persistent postgres datastore** (#338 / ADR-128), so the store + model **survive `docker compose down` /
reboot** — `dev:setup` is first-run-only and a restart no longer breaks authz. (Upgrading an older in-memory
setup: `docker compose down -v && pnpm dev:up` once to create the `openfga` DB + run its migration.)

Open **http://localhost:5173/p/demo**. The API resolves the tenant from the Host
header, so the web calls it on `dev.localhost:4000` (see `apps/web/.env.example`).
Run app services in containers too: `docker compose --profile apps up -d --build`.

The server integration tests run against their **own isolated stack** (separate
containers, ports, and volumes — dev data is never touched):
```bash
pnpm setup:server-test          # bring up + migrate + seed the server-test middleware
pnpm --filter @wikistead/server test
pnpm teardown:server-test       # (optional) tear it down + wipe its volumes
```
`apps/server/vitest.config.ts` loads `.env.server-test`, so `pnpm test` connects to
that stack, not the dev one. Set it up once; the containers persist between runs.

- OpenFGA playground: http://localhost:3000
- Meilisearch: http://localhost:7700  ·  SeaweedFS S3 gateway: http://localhost:9000

## Core bet (verify in two browsers)
Open the web app in **two browsers**, one as a member (vim surface) and one as a
guest via share link (live-preview surface). Both edit the **same document**
concurrently and see each other's cursors. **No CRDT-type bridging is used** —
both surfaces bind the same `Y.Text`. This cross-surface anonymous co-editing is
the product's central differentiator and is covered by e2e (`editor.spec`,
`share.spec`).

## Implementation status
Backend phases (Phase 0) are implemented and green; the web frontend is built on
top. Test counts are integration tests against **real Postgres + real OpenFGA**
(server) and **Playwright over an isolated middleware stack** (e2e).

| Phase | State | Tests |
|---|---|---|
| Tenancy (RLS, resolver, registry) | ✅ | tenant-isolation (7) |
| Authorization (OpenFGA ReBAC) | ✅ | authz (13) |
| Spaces / pages + **nested tree, move, reorder, cross-space (3b)** | ✅ | spaces-pages (19) |
| Billing (Stripe, entitlements) | ✅ | billing (10) |
| Search (Meili + two-stage FGA guard) | ✅ | search (8) |
| Storage (SeaweedFS, presigned, GC) | ✅ | attachments (6) |
| Collab persistence (RLS-scoped ydoc) | ✅ | ydoc (7) |
| Revisions (snapshots, Valkey restore) | ✅ | revisions (10) |
| Public render (`user:anonymous`, 404-uniform) | ✅ | public (9) |
| API keys (`wks_`, third principal) | ✅ | api-keys (13) |
| Share links (anonymous mint / revoke) | ✅ | share-links (9) |
| **Web frontend** (editor, tree, search, share, attachments) | ✅ | e2e: editor / foundation / tree (3) / search / share / attachments |
| **Editor** (CM6 live-preview, vim, macros: mermaid/callout/table/excalidraw, comments, i18n en/ja) | ✅ | e2e: editor / macros / tables / atom-motion / comments |

ADRs (`docs/adr/`) record the locked decisions and the active design drafts.
Migrations 001–011 are applied by `migrate`. Remaining `TODO(phase: ...)` markers
point at the polish/business items below, not missing core features.

## Remaining (polish + business)
Core knowledge-base features are implemented and green (tenancy, authz, spaces/pages,
collab, search, storage, revisions, public render, API keys, share links, billing, the
web editor with live-preview / vim / macros, comments, i18n en/ja). What's left is
polish, hardening, and the business layer — most of it captured as ADR drafts in
`docs/adr/`:
- **Macros**: columns / details / tabs directives; PlantUML / math rendering (Mermaid,
  callout, table, Excalidraw are done).
- **Search hardening**: body-content indexing; CJK/Japanese tokenization config; the
  two-stage authorized-hit gap (ADR-027).
- **Guest / sharing**: space-scoped share links (`model.fga`: add `[share_link]` to
  `space#viewer`); guest (share-link) commenting (ADR-029); active disconnect of
  connected guests on revoke (ADR-028); rate-limiting the link-exchange endpoint
  (ADR-026).
- **Public**: nested public page tree with per-child gating (ADR-030).
- **Ops / scale**: production reverse proxy + persistent OpenFGA; revision pruning /
  S3 offload.
- **Business / legal**: final plan limits + pricing and a metered-overage soft cap;
  CE/EE split + AGPL legal review; `LICENSE` / `CHANGELOG` / `CONTRIBUTING`; release
  tooling (semantic-release, intentionally deferred — see the project design notes).

## Contributing

Wikistead has a [Code of Conduct](CODE_OF_CONDUCT.md). **Security issues** must go through
the private channel in [SECURITY.md](SECURITY.md) — never a public issue. Bug reports and
feature requests use the [issue forms](.github/ISSUE_TEMPLATE/); the feature form is scored
against the product's north stars (Knowledge First, Open formats — see the project design notes). External
pull requests are **not accepted at this time** (see the
[PR template](.github/PULL_REQUEST_TEMPLATE.md) for the policy and the internal validation
checklist: `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm license:check`).

## License

Wikistead ships **open-core**: the Community Edition (CE) is **AGPL-3.0**, and Enterprise
Edition (EE) features are proprietary, kept in gitignored overlays outside the public source
(two-repo overlay, ADR-084). Every **bundled dependency is permissive** (MIT / Apache-2.0 /
BSD / ISC; MPL-2.0 only when the file is unmodified) — no AGPL/GPL/SSPL/BSL/source-available
code is linked, bundled, or integrated into a distributable — enforced by a CI license
allowlist (`pnpm license:check`, ADR-011). The `LICENSE` file and the final AGPL legal
review are tracked as a pre-launch item (not yet committed here).

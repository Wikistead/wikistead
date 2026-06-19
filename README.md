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
docker compose up -d           # postgres, valkey, openfga, meilisearch, seaweedfs
pnpm --filter @wikistead/server migrate        # apply DB migrations
pnpm --filter @wikistead/server fga:bootstrap  # prints OPENFGA_STORE_ID / MODEL_ID → put in .env
pnpm --filter @wikistead/server fga:seed       # demo FGA tuples
pnpm --filter @wikistead/server db:seed        # demo tenant / space / page
pnpm install
pnpm dev                       # runs server + collab + web on the host
```
Run app services in containers too: `docker compose --profile apps up -d --build`.

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

ADRs 000–014 record the locked decisions. Migrations 001–011 are applied by
`migrate`. Remaining `TODO(phase: ...)` markers point at the polish/business items
below, not missing core features.

## Remaining (polish + business)
Core knowledge-base features are complete. What's left is product polish and the
business layer:
- **Revenue tiers**: concrete plan → limits design on top of the entitlements layer.
- **i18n**: UI translation + Meilisearch CJK/Japanese tokenization.
- **Space-scoped share links** (model TODO in `model.fga`: add `[share_link]` to
  `space#viewer`) and **immediate disconnect of connected guests** on revoke.
- **Comments**, and rich rendering (**PlantUML / Mermaid / math**).
- **Release tooling**: semantic-release is intentionally not yet wired (see the project design notes).

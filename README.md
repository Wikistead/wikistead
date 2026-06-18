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
| Storage | **S3-compatible** abstraction (MinIO / R2 / S3), tenant key-prefixing, presigned URLs. |

## Layout
```
apps/
  server/   Fastify API — tenant resolver, OpenFGA, search, storage, billing (stubs)
  collab/   Hocuspocus — onAuthenticate accepts member + guest tokens (the join point)
  web/      Vite + CodeMirror — two surfaces bound to one Y.Text (the PoC)
packages/
  types/    shared domain contracts
  auth/     guest token mint/verify + OIDC member verification
infra/openfga/model.fga   authorization model (DSL, ADR draft)
deploy/                    Kustomize base + dev/prod overlays + ArgoCD app-of-apps
docker-compose.yml         full local middleware stack
```

## Local development
```
cp .env.example .env
docker compose up -d           # postgres, valkey, openfga, meilisearch, minio
pnpm install
pnpm dev                       # runs server + collab + web on the host
```
Run app services in containers too: `docker compose --profile apps up -d --build`.

- OpenFGA playground: http://localhost:3000
- Meilisearch: http://localhost:7700  ·  MinIO console: http://localhost:9001

## Phase 0 PoC (what to verify first)
Open the web app in **two browsers**, one as a member (vim surface) and one as a
guest via share link (live-preview surface). Both edit the **same document**
concurrently and see each other's cursors. **No CRDT-type bridging is used** —
both surfaces bind the same `Y.Text`. If cross-surface presence works here, the
central architectural bet has paid off.

## Notes / TODO markers
Code carries `TODO(phase: ...)` markers matching the prompt's phase plan
(tenancy → authz → spaces/pages → billing → search → storage → revisions →
public render → API). Stubs are real and runnable but intentionally minimal.

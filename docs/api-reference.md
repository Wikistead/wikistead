# REST API reference

Wikistead exposes its member API over REST. The machine-readable specification lives at
[`docs/api/openapi.yaml`](api/openapi.yaml); this page covers the conventions the spec assumes.
(For LLM/agent integration, the MCP connector is usually the better
surface — it carries tools, OAuth consent, and a syntax reference; the REST API is the raw substrate.)

## Addressing a tenant

Every tenant is addressed by HOST — `https://<tenant-host>/api/...`. There is no tenant id in any path;
the Host header selects the tenant (custom domains work the same way). A request to an unknown host is a
404.

## Authentication

Create an API key in the app (Settings → API keys), then send it as a Bearer token:

```
curl -H "Authorization: Bearer wk_..." https://team.example.com/api/search?q=roadmap
```

- Keys are per-member: the API acts AS the member who created the key, with exactly their permissions.
- Keys carry a scope: `read` (GET/HEAD only — a mutating request is refused) or `write`. A tenant admin
  can cap the maximum scope members may issue.
- Keys are rate-limited per key. On 429, back off and retry.
- Browser sessions use a cookie (BFF) instead; this document describes the API-key surface. Share-link
  guests use short-lived app-signed tokens and can reach only the guest-enabled subset — API keys are the
  supported integration path.
- A guest token expires in minutes, and a guest client renews it against the link it came from rather
  than asking the visitor to open the link again. A renewal is refused the moment the link is revoked or
  expires, and a single visit may keep renewing for at most twelve hours; after that the visitor meets
  the link again, which for a password-protected link means the password. Renewal is part of the
  anonymous surface below, not of the API-key one.
- Some routes exist in two addressings. Attachment presign is `POST /spaces/{spaceId}/pages/{pageId}/attachments/presign`
  for a caller who knows the space and `POST /pages/{pageId}/attachments/presign` for one who does not — an
  edit-link guest holding a single page is never told which space the page sits in. Both run the same
  check: `edit` on the page. A view-link guest is refused on either.
- CORS allows only same-origin browser requests (the tenant's own host, either scheme) — a page on a
  different site cannot call this API from JS in a visitor's browser. A non-browser caller (`curl`,
  server-to-server) is unaffected; CORS is a browser-enforced policy, not a server-side auth boundary.

## Authorization semantics (what 404 vs 403 means)

- **404** — the resource is absent OR you may not view it. These are deliberately indistinguishable
  (existence hiding): probing ids reveals nothing.
- **403** — you can see the resource but lack the capability for this action (e.g. editing with a
  read grant), or your key's scope refuses the method.
- **422** — the content was rejected by the tenant's moderation/abuse filter (publish boundary).
- Every LIST endpoint is server-side filtered to what you may view; counts never include hidden items.

## Content model

Pages are CommonMark/GFM Markdown (plus `:::` directives — see the MCP syntax reference for the exact
macro notation). `GET /pages/:id/published` returns the last published state; drafts are collaborative
CRDT state and are not directly writable over REST (use the app or the MCP `edit_body` tool). Publishing
(`POST /pages/:id/publish`) snapshots a revision.

## Errors

Errors are JSON: `{ "message": "..." }` (some carry machine-readable extras, e.g. entitlement denials
include `upgrade: true`). 5xx are safe to retry with backoff; 4xx are not.

## Coverage

The OpenAPI file documents the stable member integration surface. Deliberately NOT covered (each has its
own contract): the browser session flows (`/auth/*`, `/signup/*`), the admin console API (`/admin/*`),
billing (`/billing/*`, Stripe webhooks), the MCP endpoints (`/mcp*`, documented via MCP itself), the
anonymous public reader (`/public/*`), and infra probes (`/healthz`, `/readyz`). The
`api-inventory-407` test keeps the spec and the route table from drifting: adding a member route without
documenting or explicitly excluding it fails the build.

The browser session flows redirect to `/login?error=<reason>` on refusal rather than returning a JSON
error body — the OIDC callback (`/auth/callback`) and the EE SAML ACS (`/auth/saml/acs`) both do.
`access` stays deliberately vague (no enumeration); `seat_full` and `address_taken` are the two refusals
specific enough to name (a billing wall, and "this address already belongs to a member here —
sign in that way, then add this provider from account settings"). Neither carries an API-key error body,
since neither reaches a caller that would parse one.

## Background processing

Several routes queue work a background worker settles later (imports, webhook delivery, email, search
indexing) rather than doing it inline — the initiating response (e.g. `202` from `POST
/spaces/{spaceId}/import`) is not itself completion. This surface has no user-visible change from
the groundwork for a future tenant-removal grace period: these workers can already exclude a workspace
mid-removal once `tenants.deleted_at` is set, and nothing sets it yet, so no request's behavior differs
today.

`/admin/*` responses are shaped for the console screen that reads them and change without a version
bump — e.g. `GET /admin/sso-exemptions` carries an `isAdmin` field so that screen can answer the one
question its own refusal tells an operator to act on. Not part of the OpenAPI-covered surface above.

`POST /admin/connections/{id}/supersede` declares that `{id}` (a live connection)
supersedes another connection given as `oldConnectionId` in the body — the recreate-an-IdP-connection
rescue: it links every member the retiring connection minted to the same subject under the new
connection, so a re-created OIDC provider does not seat them as new members. Refused (409) unless the
two connections share both `issuer` and `client_id`, and again if the new connection has already
seated a different member at a subject the re-key would claim (`supersession_collision`, naming both).

`GET /pages/{pageId}/embed/frameability` is UI plumbing behind the `:::embed-external`
macro, not part of the OpenAPI-covered surface: given an already-allowlisted URL, it answers whether
that URL refuses to be framed (`X-Frame-Options` / CSP `frame-ancestors`, read from a headers-only
`safeFetch` — the same page-view gate and provider allowlist as `GET /pages/{pageId}/embed`, so the
SSRF-exposed population is identical). A probe that cannot answer (timeout, a redirecting URL) verdicts
`embeddable` — a missed refusal is today's shipped behavior; a false refusal would replace a working
embed with a sentence. Verdicts are cached per full URL, not per host.

`/auth/link-callback` is a second OIDC-round-trip landing point, distinct from
`/auth/callback`: it completes an account-settings request to link an additional connection to the
*already signed-in* member, rather than starting a session. It redirects to `/settings/account/security`
with `?linked=1` or `?linkError=<reason>` — never JSON — and, unlike `/auth/callback`, is bound to the
session that started it (refusing a link completed in any other session, the linking-CSRF defence).

`GET /me/settings` (`/me/*` account-screen plumbing, not part of the OpenAPI-covered surface) carries a
`canOverrideDisplayName` field — the restrictive union that gates the display-name
override: `identitySource` alone answers a different, narrower question (which door a member's identity
came from), not whether they may currently write an override.

`language` is the member's OWN mail-language override — `en` | `ja` | `null`
(unset, falling back to the workspace's `tenant_settings.default_lang`, then English). `PATCH
/me/settings` validates a non-null value against the same `LANGS` the mail resolver and the web
switcher read (`@wikistead/i18n-shared`), and an explicit `null` clears the override. It does NOT
change the app's own UI language, which stays a browser-local choice.

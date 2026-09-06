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
- The session cookie's `Secure` attribute follows the request's actual protocol (including
  `X-Forwarded-Proto` behind a reverse proxy), not a build-time flag — so it is correctly absent on a
  self-hosted deployment that intentionally runs without TLS (`ingress.tls.enabled: false` in the Helm
  chart), and the browser can still send the cookie back on that deployment's own plain-HTTP connections.
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

A link a route builds — `POST /members/{sub}/password-setup`'s `setupUrl` — is always addressed at the
deployment's own declared public address (a verified custom domain, else `WKS_PUBLIC_BASE_URL`), never
at the Host header the request arrived on. On a deployment with neither configured, that route refuses
with `400 { code: "deployment_has_no_address" }` instead of building a link at an address nobody
declared.

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

`GET /spaces/{spaceId}/pages/tree-placeholders` resolves the sidebar tree's invisible-page placeholder
walk for one branch, resumable across calls, returning `{ placeholders,
placeholderCursor? }` — a present `placeholderCursor` means more of the walk remains and a follow-up
call presenting it (`?cursor=`) continues from where the first left off, examined once, never
re-examined or re-reported. The cursor is an opaque, encrypted (AES-256-GCM), scope-bound
(tenant/subject/space/branch), TTL-limited (15 min) token — never a raw offset or page id a client
could read anything out of. It carries a fixed byte budget (~4KB, `tree-placeholders-cursor.ts`'s
`CURSOR_BYTE_BUDGET`) so it survives the smallest deployed proxy header limit measured in this repo;
minting one that would exceed it throws rather than silently truncating the walk.

`GET /admin/surfaces` carries a `memberIdentitiesEnabled` boolean alongside its
existing `surfaces` list — true only where this build has composed the EE member-identity-links route
AND the caller is a tenant admin, so the member-row expand section (never a popover — see below) knows
whether to offer its toggle without ever calling a route that would 404 on a CE build.

`GET /admin/members/{sub}/identities` (EE, `requireTenantAdmin`) resolves one member's linked sign-in
identities — `{ primaryIdentitySource, links: [{linkId, connectionId, connectionName, linkedAt}] }`.
Two fields disclosed per link only (`connectionName`, `linkedAt`; `linkId` is an opaque list key, not
a disclosure): never `external_subject` (the raw upstream identifier), never a live-effectiveness flag
(deferred to a follow-up ticket once a correct display predicate exists — the ADR's own rev3/rev4 found
the obvious one wrong). An unknown or cross-tenant `sub` 404s identically to every other admin member
route (existence-hiding).

`DELETE /admin/members/{sub}/identities/{linkId}` (EE, `requireTenantAdmin`) removes ONE of a member's
linked sign-in identities, by the link's own row id — not every link to a connection (self-service's
`DELETE /me/connections/{connectionId}/link` deletes every row for a connection; this route deletes
exactly the row an admin selected in the identities list above). Refused (409 `last_way_in`, no
override) if this link is the member's only way in, counting a working local password the same way
self-service does. Refused (409 `reset_self`) if the admin names their own `sub` — this route has no
re-authentication step, on the premise that actor and target are different people. On success, every
one of the target member's sessions ends immediately (not the admin's own), and the connection's
group-slice contribution is revoked only if no sibling link to the same connection survives the
removal. Writes the same `member.identity_unlinked` audit action self-service uses, disambiguated by
actor/target. An unknown or cross-tenant `sub` 404s with `{ error: 'member not found' }`, the same body
the sibling GET uses; a `linkId` naming a different member, already-removed, or never-existent link all
404 with one shared `{ error: 'not found' }` body instead, so a caller cannot tell those three cases
apart (existence-hiding).

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

`DELETE /me/connections/{connectionId}/link` (`/me/*` account-screen plumbing, not part of the
OpenAPI-covered surface, its sibling `/me/connections/{connectionId}/link/start` excluded the same way)
removes the calling member's own link to that connection, re-authenticated (password, a confirmed TOTP
code, or a passkey — the same proof `/auth/link-callback` requires to add one). Refused `409
last_way_in` when this would leave the member with no way to sign back in: the check excludes the LINK
being removed but not the connection's ability to mint this member's sub again on a future sign-in
(the connection itself can still hand this member back the same identity), since unlinking does not
sever that. Unlike the admin's
connection-wide delete (`DELETE /admin/connections/{id}`), this touches one member's one link.

If the removed connection no longer admits THIS member's sub — it's disabled, gone, or was never this
member's own mint-derived origin to begin with, an ordinary second-door link — its per-connection group
slice (`member_connection_groups`, the union mechanism behind a login's group-derived roles) is revoked
in the same transaction as the link removal, and `members.groups`/the matching FGA membership tuples are
recomputed immediately rather than left to lapse at a next sign-in that may never come. A connection
that still mints this member's sub keeps its slice — removing the LINK row doesn't close that door, so
revoking the slice too would look like a real access change without actually restricting anything.

`GET /me/settings` (`/me/*` account-screen plumbing, not part of the OpenAPI-covered surface) carries a
`canOverrideDisplayName` field — the restrictive union that gates the display-name
override: `identitySource` alone answers a different, narrower question (which door a member's identity
came from), not whether they may currently write an override.

`language` is the member's OWN mail-language override — `en` | `ja` | `null`
(unset, falling back to the workspace's `tenant_settings.default_lang`, then English). `PATCH
/me/settings` validates a non-null value against the same `LANGS` the mail resolver and the web
switcher read (`@wikistead/i18n-shared`), and an explicit `null` clears the override. It does NOT
change the app's own UI language, which stays a browser-local choice.

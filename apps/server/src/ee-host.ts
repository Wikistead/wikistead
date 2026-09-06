// #178 / ADR-084: the CE "EE host" surface — the ONE public barrel the physically-separated EE
// packages (@wikistead-ee/*) import from `@wikistead/server/ee-host`. EE→CE is a permitted one-way
// dependency (the open-core guard forbids only CE→EE; ee-server is proprietary so it is exempt from
// the CE-library rule). Keeping the surface here — rather than letting EE reach into arbitrary deep
// paths — makes the boundary auditable: this file is exactly what EE may use from the CE app.
//
// It re-exports (a) the bootstrap the EE composition root calls (startServer / buildApp), and (b) the
// app-layer helpers the moved SCIM code needs (tenant resolution, tenant-db, seat/group/audit
// helpers, the pg pool, entitlement-UX). Adding to this list is the deliberate act of widening the
// EE↔CE contract.

export { startServer } from './server.js'
export { buildApp } from './app.js'

export { pool } from './db/pool.js'
export { acquireTenantDb, withTenantTx } from './db/index.js' // #382: isolation-aware non-request tx (SCIM token verify)
export type { TenantDb } from './db/index.js'

export { resolveTenantFromHost, loadTenant } from './tenant.js'
export { provisionTenant } from './auth/provisioning.js' // #475: EE tests provision a second tenant to pin RLS scoping
export { groupFgaId, syncMemberGroups } from './auth/group-sync.js'
// #578 slice 4: group-conferred tenant admin is retired (ADR-183 option (c)), so `evaluateAdminMapping`
// is gone. The last-admin predicate is NOT — SCIM deactivation asks the same question the console does,
// and it moved to its own module rather than dying with the file it happened to share (#573).
export { isLastAdmin } from './auth/last-admin.js'
export { registerSamlEntitlement } from './auth/saml-entitlement.js' // #693 the EE root registers the entitlement-reading predicate
// #693 the break-glass CLIs run per COMPOSITION — the EE wrappers register the predicate and
// call the same mains, so an entitled tenant's picture is honest in both editions.
export { cliMain as loginMethodsCliMain } from './scripts/login-methods.js'
export { cliMain as localAdminCliMain } from './scripts/local-admin.js'
export { loginMethodCeiling, assertClosingIsSafe, effectiveConnectionIds } from './auth/login-methods.js' // #537: SAML start/ACS honour the deployment ceiling; #822/ADR-251: the SAML disable guard asks the SAME question as the other doors, about ways in rather than configured methods; #1162/ADR-282: the member-identity-links admin route's display-only effectiveness predicate
export { billableMemberCount, lockSeats, memberWithEmail } from './auth/invites.js' // #930 / ADR-263 §3.2: SCIM asks the same address question the other three seating doors ask
// #688: the LEDGER moved into @wikistead-ee/server (write side, drain, viewer, transparency). What the
// seam carries now is the CE half: the vocabulary + the registration point (sink), and the generic
// plumbing the moved code rides. `auditIfEntitled` stays exported — it is the CE facade, and EE code
// (SCIM provisioning, key issuance) calls the same function CE routes do.
export { auditIfEntitled, registerAuditSink, auditActor, registerTransparencyProjector } from './audit/sink.js'
export type { AuditCore, AuditChanges, AuditChangeField, AuditSink, TransparencyProjector, OperatorActionForProjection } from './audit/sink.js'
// The hash-chain PRIMITIVE stays CE — the operator ledger (CE, break-glass) rides it — and the EE
// ledger links with the same one rather than a copy that could drift (#688).
export { computeEntryHash, verifyAuditChain, linkEntry, GENESIS_PREV } from './audit/chain.js'
export type { AuditEntry, AuditEntryCore, ChainVerdict } from './audit/chain.js'
export { claimOutboxBatch, startOutboxDrainWorker } from './db/outbox-lease.js' // #432: the outbox lease the EE drains ride
export { bumpRateBucket } from './rate-limit.js' // #688 slice 2: the collection dedup key rides the shared bucket
export { registerPageViewCollector } from './analytics/sink.js' // #688 slice 2: the raw public-view event's registration point
export type { PageViewEvent, PageViewCollector } from './analytics/sink.js'
export { entitlementDenied } from './entitlement-ux.js'
// #475: SCIM deprovisioning revokes the member's API keys, so the EE side needs the same key
// primitives the CE routes use — additive re-exports of CE code, no EE dependency added.
// #723 / ADR-232: the EE composition root registers SCIM's presence the way it registers the
// audit ledger — the CE marker lives in apps/server, the decision to light it lives in ee/.
export { registerScim } from './scim-sink.js'
// #1107 / ADR-280 §2: same shape, for admin visibility of member identity links. The reader
// (`memberIdentitiesRegistered`) and reset stay CE-internal, read only by `/admin/surfaces` and CE's
// own tests — this hop is writer-only, mirroring `registerScim`'s.
export { registerMemberIdentities } from './member-identities-sink.js'
// #1107 / ADR-280 §1: ordinary CE data-access utilities the EE route needs — additive re-exports, no
// EE dependency added, the same shape the SCIM/analytics re-exports above already use.
export { listMemberIdentityLinksForAdmin, nameConnectionForAdmin } from './auth/member-identities.js'
// #1163 / ADR-283 §2: ONE new export carries the whole admin-unlink sequence (guard/delete/audit/
// revoke) — the EE route is a thin HTTP wrapper with no authz/business logic of its own.
export { adminUnlinkMemberIdentity, type AdminUnlinkResult } from './auth/member-identities.js'
// #715 / ADR-229: the funnel collector seam. The report calls stay in CE; only the recording is EE.
export { registerFunnelCollector, funnelRegistered, resetFunnelCollector, reportLinkVisit, reportWorkspaceCreated } from './funnel/sink.js'
export { createApiKey } from './routes/api-keys.js'
export { verifyApiKey } from './api-key-auth.js'

// #178: additional CE-GENERAL auth helpers the moved SAML code needs (SAML → packages/ee-server, mirroring
// SCIM). Each is a pure CE utility ALREADY shared by CE OIDC (session / secret-crypto / oidc / return-to) —
// none imports EE, so exposing them via this barrel is a pure additive re-export, not new CE code. The
// hash-chained operator ledger STAYS in CE (a break-glass record — CE's oidc-disable
// script uses appendOperatorEntry) — EE consumes it through the seam like the rest of the audit surface.
export { coerceGroups } from './auth/oidc.js'
export { encryptSecret, decryptSecret } from './auth/secret-crypto.js'
export { SESSION_COOKIE, establishMemberSession, sessionCookieOptions, destroyMemberSessions, createSession, readSession } from './auth/session.js' // #477: SCIM deactivation drops the member's sessions too; #1053: the sweep's own valkey pin reads a session back rather than reaching into the internal key format
export { safeReturnTo } from './auth/return-to.js'
export { appendOperatorEntry, OPERATOR_CHAIN_LOCK, type OperatorAction } from './audit/operator-ledger.js' // #688: transparency (EE) projects this CE ledger

// #627 / ADR-213: the suspension verb lives in CE now — SCIM calls it with `reason: 'scim'` rather than
// carrying its own copy, so there is one meaning of "suspended" for the console and the directory alike.
export { suspendMember, reactivateMember, isScimSuspension, grantsShouldBeRebuilt, LastAdminSuspensionError } from './auth/member-suspension.js'
export type { SuspensionReason, SuspendOutcome, ReactivateOutcome } from './auth/member-suspension.js'
// #1050 / ADR-275 rev3 §2: SCIM's deferral decision (defer only when the tenant has somewhere to send
// §4's out-of-band notice) needs to ask "is THIS tenant's resolved driver the no-op one" — the CE class
// itself, not a duplicated `instanceof`-unfriendly copy.
export { NoopEmailDriver } from './email/index.js'
// #1051 / ADR-275 rev3 §4: the out-of-band notice rides the existing outbox — SCIM enqueues into the
// SAME queue every other transactional class uses, rather than a second send path.
export { enqueueEmailOutbox } from './email/outbox.js'
export { SCIM_OFFBOARDING_DEFERRED_CLASS } from './email/scim-offboarding-builder.js'
// #1053 differ-back (finding A): the sweep's tenant DISCOVERY moved off an admin/BYPASSRLS connection
// entirely — `tenants` carries no RLS (the global registry), so `listActiveTenantIds` on the ordinary
// pool already answers "which tenants exist" with the SAME role every other request uses, and the
// per-tenant pending check then runs through `acquireTenantDb`'s own RLS-scoped connection.
export { registerScimReconcileHook } from './auth/scim-reconcile-seam.js'
export type { ScimReconcileHook } from './auth/scim-reconcile-seam.js'
export { registry, listActiveTenantIds } from './db/index.js'
// #1053 / ADR-275 rev3 §3 (B3/B7 corrected the same way #1036/#1037 corrected ADR-270's premise):
// the ADR's own text analogises this endpoint's auth to `operator/app.ts`, but that console is the
// Cloud-only break-glass plane (own header comment: "Cloud-only deployment... CE/self-host keeps the
// CLI") and reads over a READ-ONLY connection — wrong on both counts for a write-capable, EE-general
// endpoint a self-hosted deployment's own cron must also be able to call. `bearerMatches` is the
// shared-secret style `metrics.ts` already uses for exactly this shape (a second listener, off the
// ingress, gated by an env token) — reused rather than re-implemented.
export { bearerMatches } from './metrics.js'
// #637 / ADR-216 §2: the EE composition root declares the same request-path rule as the CE one.
export { requireAuthzScope } from '@wikistead/authz'
// #637 / ADR-216 §7: the EE composition root registers what a restriction MEANS; CE owns the refusal.
export { registerAuthzRestrictionEvaluator } from '@wikistead/authz'
export type { AuthzRestrictionEvaluator } from '@wikistead/authz'
// #637 / ADR-216: the EE issuing route reuses CE's issuance gate and the space view check rather than
// inventing a second permission for a smaller credential.
export { isApiKeyIssuer, checkRelation, fgaClient } from '@wikistead/authz'
export { resetAuthzRestrictionEvaluator } from '@wikistead/authz'

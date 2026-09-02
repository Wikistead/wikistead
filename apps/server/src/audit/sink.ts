import type { Sql, TransactionSql } from 'postgres'
import { currentAuthzScope } from '@wikistead/authz'

// #688 / ADR-084: the CE side of the compliance audit ledger — the VOCABULARY and the registration
// point, with no ledger behind them. The ledger itself (enqueue, hash-chained drain, viewer,
// transparency projection) is organisational governance and lives in @wikistead-ee/server; the EE
// composition root registers it here. A CE build registers nothing, so every audited write path
// below stays a no-op — the same open-core line SCIM and SAML sit behind, applied to the ledger
// (owner ruling 2026-08-12, #688: personal safety = CE, organisational governance = EE).
//
// ⚠️ The 21 call sites throughout CE keep calling `auditIfEntitled` unchanged. What moved is the
// implementation, not the contract: the call still runs inside the operation's transaction, still
// returns the outbox id or null — null now also meaning "this build has no ledger".

export interface AuditCore {
  tenantId: string
  actor: string // 'user:<sub>' | 'api_key:<id>' | 'operator:<id>' | 'scim' | 'system'
  action: string // e.g. 'member.removed'
  target?: string // resource ref ('' when N/A)
  at?: string // ISO time; defaults to the DB now() at enqueue
  /**
   * #684 / ADR-223: what this action changed, as `{field: {from, to}}`. Absent for most actions.
   *
   * ⚠️ Everything written here is EXPORTED VERBATIM to every holder of `view_audit` (ADR-208 allows
   * granting that to an individual member), in a row nothing can amend. ADR-223 §3 draws the line: a
   * tenant's own objects may be named, what a member wrote about themselves may not.
   */
  changes?: AuditChanges
}

/**
 * The fields an audit row may record a before/after for — ADR-223 §3, closed at BUILD TIME.
 *
 * ⚠️ A type and not a runtime check, deliberately. A `throw` cannot enforce this: nine of the
 * forty-four audit call sites wrap the write in `.catch(() => {})`, so a refusal there deletes the
 * ledger row silently, and at the other thirty-five it rolls back the user's operation because the
 * write shares its transaction. Neither is an acceptable answer to "a developer added a field". The
 * compiler answers instead, before anything runs.
 *
 * ⚠️ Adding a member here PUBLISHES that value, unfiltered, to every holder of `view_audit`, in a row
 * that cannot be edited or deleted. §3's line: a value naming a tenant's own object (a role's name, a
 * stance) may be recorded; a value a member wrote about themselves (a factor's label, a display name)
 * may not — the difference is not who typed it but what it NAMES.
 */
export type AuditChangeField =
  | 'second_factor_kinds'
  // #684 slice 5: the SSO stance, for the same reason and in the same shape — `tenant.sso_required_on`
  // closes every other way in and `…_off` opens them again, and the two action names cannot say which
  // happened. A tenant setting's boolean: it names the tenant's own configuration, so it is on §3's
  // permitted side without a judgement call.
  | 'sso_required'
  // #1050 / ADR-275 rev3 §2: which UNCONDITIONAL floor (`last_admin` | `login_lockout`) deferred a
  // SCIM removal — `member.scim_offboarding_deferred` names it, per the ADR's own text. A system-
  // derived classification of the tenant's own authz state (which guard fired), never anything a
  // member wrote about themselves, so it sits on §3's permitted side the same way `sso_required` does.
  | 'pending_scim_removal_reason'

export type AuditChanges = Partial<Record<AuditChangeField, { from: unknown; to: unknown }>>

/**
 * #667 / ADR-221 §9: an API key's actions are recorded as the KEY, not as its owner.
 *
 * Measured before this existed: forty-nine call sites build an actor as `user:<sub>` and none ever
 * wrote `api_key:`, so every action a key took was filed as though the person did it by hand — and
 * after an incident there was no way to tell the two apart, which is the one question an audit log
 * exists to answer.
 *
 * The substitution happens HERE, once, rather than at those forty-nine sites. A list of corrected call
 * sites is a list that grows a fiftieth the week after; a derivation at the single place that writes
 * the row cannot be forgotten by whoever adds the next audited operation. Which requests are a key's
 * rides the ambient authz scope, filled by authentication beside the space restriction.
 *
 * The owner is not lost: it is a column on the key's row, one join away. Writing both into the actor
 * string would put the same fact in two places and let them drift.
 *
 * Only `user:` actors are rewritten. `scim`, `system` and `operator:` describe principals that are not
 * a member acting, so a key cannot be behind them — and rewriting one would make the ledger say
 * something false rather than something imprecise.
 *
 * Lives on the CE side of the seam: the derivation reads the ambient scope (CE machinery), and the
 * substitution is part of the VOCABULARY — what an actor string means — not of the ledger.
 */
export function auditActor(actor: string): string {
  if (!actor.startsWith('user:')) return actor
  const keyId = currentAuthzScope()?.apiKeyId
  return keyId ? `api_key:${keyId}` : actor
}

/** What the EE ledger registers: the entitlement-gated, in-tx enqueue. */
export type AuditSink = (sql: Sql, tenant: { id: string; plan: string }, core: Omit<AuditCore, 'tenantId'>) => Promise<string | null>

let sink: AuditSink | null = null

// ── Access Transparency (#435 / ADR-169), same seam shape ────────────────────────────────────────
// The break-glass ledger row is CE (the rescue's own record); whether that access is DISCLOSED to
// the tenant is the EE feature. The projector rides the operator ledger's admin transaction
// (both-or-neither, exactly as before the move) and answers with the tenant it disclosed to, so the
// caller can emit vendor.access for new accesses only.

export interface OperatorActionForProjection {
  actor: string
  action: string
  target: string
  at: string
  reason?: string
}

// The projector receives the operator ledger's TRANSACTION verbatim. postgres.js's TransactionSql
// is not assignable to Sql (connection-lifecycle members are missing), and the projector must accept
// exactly what the caller holds — so the seam names the transaction type, not the pool type.
export type TransparencyProjector = (tx: TransactionSql, action: OperatorActionForProjection) => Promise<string | null>

let projector: TransparencyProjector | null = null

export function registerTransparencyProjector(p: TransparencyProjector): void {
  projector = p
}

/** Null when nothing was disclosed — a CE build (no projector) and a non-tenant target alike. */
export async function projectTransparency(tx: TransactionSql, action: OperatorActionForProjection): Promise<string | null> {
  return projector ? projector(tx, action) : null
}

// Called once by the EE composition root (packages/ee-server/src/main.ts), like
// registerNarrowedKeyGate beside it. Last registration wins so the test setup can re-register.
export function registerAuditSink(s: AuditSink): void {
  sink = s
}

/** True when a ledger is composed in — the admin-surfaces nav filter reads this (#688). */
export function auditLedgerRegistered(): boolean {
  return sink !== null
}

// Enqueue an audit intent ONLY when a ledger exists AND the tenant is entitled to it. Call inside
// the operation tx (the intent commits atomically with the operation). Null on a CE build (no
// ledger registered) and for unentitled tenants alike: in both cases there is no ledger to write.
export async function auditIfEntitled(sql: Sql, tenant: { id: string; plan: string }, core: Omit<AuditCore, 'tenantId'>): Promise<string | null> {
  return sink ? sink(sql, tenant, core) : null
}

// #858 / #959, ADR-259 §3.1: member_identities is how a member gains a second way in without a
// second member being created. This module is the READ side that routes/auth.ts consults at login;
// the WRITE side (linking from account settings, ADR-259 §3.3) landed as #947, below.
import type { TenantDb } from '../db/index.js'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import {
  resolveLoginConnections, connectionAdmitsSubject, memberHasAnotherWayIn, localLoginEnabled, loginMethodCeiling,
} from './login-methods.js'
import { resolveSsoStance, isSsoExempt } from './sso-stance.js'
import { revokeMemberConnectionSlice } from './group-sync.js'
import { auditIfEntitled } from '../audit/sink.js'

/**
 * The stored link for (tenant, connection, external subject), if one exists.
 *
 * ADR-259 §3.1: "a stored link wins over the deterministic mint." The caller reads this BEFORE
 * applying any connection subject-prefix (or using the raw external subject as-is), and prefers it
 * unconditionally — including when the subject the connection would otherwise mint already belongs to
 * a different, LIVE member (§5's #807 case). Preferring the link only when the minted subject has no
 * member row is the implementation ADR-259 §5 names as wrong: it passes every other case while
 * reproducing the exact defect #807 was raised on.
 */
export async function findMemberIdentityLink(
  db: TenantDb,
  tenantId: string,
  connectionId: string,
  externalSubject: string,
): Promise<string | null> {
  const [row] = await db.sql<{ member_sub: string }[]>`
    SELECT member_sub FROM member_identities
    WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
    LIMIT 1`
  return row?.member_sub ?? null
}

/**
 * A member's own links (account settings, #947), and the connection-delete cascade (#960) — the
 * index this reads (`idx_member_identities_member`) was created for exactly these two callers.
 */
export async function listLinkedConnectionIds(db: TenantDb, tenantId: string, memberSub: string): Promise<string[]> {
  const rows = await db.sql<{ connection_id: string }[]>`
    SELECT connection_id FROM member_identities WHERE tenant_id = ${tenantId} AND member_sub = ${memberSub}`
  return rows.map((r) => r.connection_id)
}

/**
 * #1107 / ADR-280 §1: an ADMIN's view of one member's links — connection id + when it was linked, no
 * more. Disclosure (which fields the caller may see) is the route's job, not this read's; this just
 * returns what the table holds for the member, oldest link first (a stable, human-readable order).
 *
 * `id` is the row's own opaque primary key (migration 129) — carries no upstream meaning (unlike
 * `external_subject`, which this ADR never discloses), included ONLY so a caller has a stable key for
 * a link: the UNIQUE constraint is `(tenant_id, connection_id, external_subject)`, not
 * `(tenant_id, connection_id)`, so a member CAN hold two links to the SAME connection (two upstream
 * subjects, e.g. via the supersede path) — `connectionId` alone is not a safe list key.
 */
export interface MemberIdentityLinkRow {
  id: string
  connectionId: string
  linkedAt: Date
}

export async function listMemberIdentityLinksForAdmin(
  db: TenantDb, tenantId: string, memberSub: string,
): Promise<MemberIdentityLinkRow[]> {
  const rows = await db.sql<{ id: string; connection_id: string; created_at: Date }[]>`
    SELECT id, connection_id, created_at FROM member_identities
    WHERE tenant_id = ${tenantId} AND member_sub = ${memberSub}
    ORDER BY created_at ASC`
  return rows.map((r) => ({ id: r.id, connectionId: r.connection_id, linkedAt: r.created_at }))
}

/**
 * #1107 / ADR-280 §1 (rev6): name a connection by id for display, UNFILTERED by `enabled`/plan/stance —
 * naming a disabled or masked connection is not the fact this ticket's dropped `connectionEffective`
 * question would have protected (that question is deferred to its own follow-up). Deliberately NOT
 * `resolveLoginConnections`'s tenant-wide, filtered list: `member_identities.connection_id` is only
 * ever written for `kind === 'oidc'` or the fixed `'platform'` id (auth.ts's link-callback guard; the
 * supersede path writes a `tenant_oidc` id) — `local` and `saml` never appear here. Returns `null` only
 * when the id resolves to nothing at all (the connection was fully deleted, not merely disabled) — the
 * same absent-key shape `external_subject`'s omission uses elsewhere in this response.
 */
export interface NamedConnection {
  kind: 'oidc' | 'platform'
  label: string | null
  brand: string | null
}

export async function nameConnectionForAdmin(db: TenantDb, connectionId: string): Promise<NamedConnection | null> {
  if (connectionId === 'platform') return { kind: 'platform', label: null, brand: null }
  const [row] = await db.sql<{ label: string | null; preset: string | null }[]>`
    SELECT label, preset FROM tenant_oidc WHERE id = ${connectionId} LIMIT 1`
  if (!row) return null
  return { kind: 'oidc', label: row.preset ? null : row.label, brand: row.preset }
}

/**
 * Write a link (#947 / ADR-259 §3.3). Both `externalSubject` and `memberSub` MUST come from
 * server-verified sources — the callback-verified upstream subject and the `OidcLoginState`'s
 * `linkMemberSub` — never from anything a client supplied; §5 pins that the write cannot be reached
 * any other way.
 *
 * A pre-existing row for (tenant, connection, external subject) naming a DIFFERENT member is refused
 * (409 `identity_taken`) rather than silently left alone: an `ON CONFLICT DO NOTHING` here would tell
 * the caller the link succeeded while the identity stayed bound to whoever already holds it. A row
 * that already names THIS member is a harmless replay (double-click, retried redirect) and no-ops.
 *
 * #961 / ADR-259 §3.7: the INSERT and the display-name-override clear happen in ONE transaction. A
 * member holding any IdP-asserted way in may not override their name (account.ts's restrictive-union
 * guard refuses the WRITE), but an override set before this link existed already persists and would
 * outlive the guard that would now refuse it — so linking clears it here, in the same write, rather
 * than leaving a stale value the guard never sees again.
 */
function identityTaken(): Error {
  return Object.assign(
    new Error('this sign-in is already linked to a different member of this workspace'),
    { statusCode: 409, code: 'identity_taken' },
  )
}

export async function linkMemberIdentity(
  db: TenantDb,
  tenantId: string,
  connectionId: string,
  externalSubject: string,
  memberSub: string,
): Promise<void> {
  try {
    await db.tx(async (tx) => {
      const [existing] = await tx<{ member_sub: string }[]>`
        SELECT member_sub FROM member_identities
        WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
        LIMIT 1`
      if (existing && existing.member_sub !== memberSub) throw identityTaken()
      if (existing) return
      await tx`
        INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenantId}, ${connectionId}, ${externalSubject}, ${memberSub})`
      await tx`UPDATE members SET display_name_override = NULL, updated_at = now() WHERE tenant_id = ${tenantId} AND sub = ${memberSub}`
    })
  } catch (e) {
    // #968: a genuine race (the same sign-in linking from two tabs at once) has both calls' SELECT
    // above see no row before either INSERTs — the loser's INSERT hits the UNIQUE constraint as a
    // raw postgres 23505, and that abandons ITS transaction (a Postgres tx that hit an error refuses
    // every further statement until rollback, so the follow-up read below runs OUTSIDE it, once the
    // winner's transaction has already committed). Without this, the loser threw a bare 500 — the
    // route this feeds documents as never answering with JSON (docs/api-reference.md).
    if ((e as { code?: string }).code !== '23505') throw e
    const [winner] = await db.sql<{ member_sub: string }[]>`
      SELECT member_sub FROM member_identities
      WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}
      LIMIT 1`
    if (!winner || winner.member_sub !== memberSub) throw identityTaken()
    // Same member: the winner's transaction already inserted the row and cleared the override —
    // this call needed nothing further, the same harmless-replay outcome as the existing-row check.
  }
}

/**
 * Remove a member's own link to a connection (#1045 / ADR-259 §3.9). The caller is responsible for
 * everything §3.9 requires BEFORE calling this: re-authentication, and confirming the member has
 * another way in (`memberHasAnotherWayIn` with `excludeLinkOnly` set to this connection, ORed with a
 * `local_credentials` check) — this function only performs the write.
 *
 * Takes a `Sql` (not a `TenantDb`) so the caller can run it INSIDE the same transaction as the audit
 * row `auditIfEntitled` writes — a member-initiated destructive write and the ledger's record of it
 * should not be able to land as two separate facts (one committed, one lost) if the process dies
 * between them.
 *
 * Scoped to `(tenantId, connectionId, memberSub)`, not by row id: the caller never learns a link's
 * internal id (`GET /me/connections` reports linkage as a boolean, per connection), so there is no id
 * to hand back. Returns whether a row actually existed to remove, for the caller's 404.
 *
 * ⚠️ KNOWN GAP, left open on purpose rather than guessed at (review c-a8af, #1045): this does
 * NOT touch `member_connection_groups` or `members.groups`. `group-sync.ts`'s `revokeConnectionGroups`
 * revokes a connection's trust-group-derived roles the moment the STANCE requires it (biting kicks a
 * member who no longer satisfies it out immediately, not on their next sign-in) — whether an ordinary
 * self-service unlink should revoke the SAME slice, or leave it to lapse on the next sign-in the way
 * `identity_source` itself is documented as transitional (§3.9's own "judged by identity_source until
 * they sign in again"), is a policy question ADR-259 §3.9 never asked. Filed as a follow-up rather than
 * decided here.
 */
export async function unlinkMemberIdentity(
  sql: Sql,
  tenantId: string,
  connectionId: string,
  memberSub: string,
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    DELETE FROM member_identities
    WHERE tenant_id = ${tenantId} AND connection_id = ${connectionId} AND member_sub = ${memberSub}
    RETURNING id`
  return !!row
}

/**
 * #1163 / ADR-283 §1: an ADMIN removes ONE of a member's links, by the link's own row id — not
 * `(connectionId, memberSub)`. `unlinkMemberIdentity` above deletes every row for a connection at
 * once, which is correct for self-service (its own UI is a per-connection boolean) but wrong here: a
 * member can hold two links to the SAME connection (the supersede path, migration 129's UNIQUE
 * constraint being `(tenant_id, connection_id, external_subject)` not `(tenant_id, connection_id)`),
 * and the admin's UI shows — and the admin clicked "unlink" on — exactly one row.
 *
 * `member_sub` is redundant for uniqueness (`id` is a globally-unique primary key) but not decorative:
 * without it, a `linkId` naming a DIFFERENT member's row would silently act on that member while the
 * caller's own response shape implies it acted on the named `:sub`.
 */
export async function unlinkMemberIdentityById(
  sql: Sql,
  tenantId: string,
  linkId: string,
  memberSub: string,
): Promise<{ connectionId: string } | null> {
  const [row] = await sql<{ connection_id: string }[]>`
    DELETE FROM member_identities
    WHERE id = ${linkId} AND tenant_id = ${tenantId} AND member_sub = ${memberSub}
    RETURNING connection_id`
  return row ? { connectionId: row.connection_id } : null
}

export type AdminUnlinkResult = { ok: true } | { ok: false; reason: 'not_found' | 'last_way_in' | 'reset_self' }

/**
 * #1163 / ADR-283 §2: the whole admin-unlink sequence (existence → stranding guard → delete → audit →
 * sibling check → group-slice revoke), in ONE narrow CE function callable from either CE or EE — the
 * human ruling on ADR-283 §0 placed the HTTP route in EE (`packages/ee-server/src/member-identities/mount.ts`),
 * but the authz/business logic itself is CE regardless of where the route is mounted.
 */
export async function adminUnlinkMemberIdentity(
  db: TenantDb,
  fga: OpenFgaClient,
  tenant: { id: string; plan: string },
  adminSub: string,
  targetSub: string,
  linkId: string,
  env?: string | undefined,
): Promise<AdminUnlinkResult> {
  // #1163 / ADR-283 §2 (T2): refuse an admin targeting THEIR OWN sub, before anything else — the same
  // shape `DELETE /members/:sub/factors`'s `reset_self` refusal takes (members.ts). Self-service unlink
  // requires re-authentication as its proof of intent; this admin route has none, on the premise that
  // actor and target are different people. An admin unlinking their OWN identity through this route
  // would skip that proof AND destroy their OWN sessions with no `exceptSid` below, logging themselves
  // out as a side effect of a request that skipped the one check self-service requires for exactly
  // this action.
  if (targetSub === adminSub) return { ok: false, reason: 'reset_self' }

  return db.tx(async (tx) => {
    // Existence resolved FIRST, matching self-service's own ordering (auth.ts) — a guard-before-
    // existence-check ordering would answer 409 `last_way_in` for a bogus/foreign/already-gone linkId
    // where 404 is owed (ADR-283 §5's uniform-404 promise for exactly these three cases).
    const [link] = await tx<{ connection_id: string }[]>`
      SELECT connection_id FROM member_identities WHERE id = ${linkId} AND tenant_id = ${tenant.id} AND member_sub = ${targetSub}`
    if (!link) return { ok: false, reason: 'not_found' }

    // The stranding guard: BOTH halves of self-service's own check (auth.ts), mirrored exactly, target
    // sub instead of caller's — `memberHasAnotherWayIn`'s own contract deliberately excludes local
    // credentials ("asks only 'is there something ELSE'"), so `credentialWorks` is read separately and
    // OR'd in, the same way self-service does it. Runs INSIDE this transaction — the transaction buys
    // ATOMICITY (existence check, guard, delete, audit, sibling check, and revoke either all apply or
    // none do), not serializability: Postgres's default READ COMMITTED does not serialize two
    // concurrent transactions' reads against each other without explicit row locking, which this ADR
    // does not add (a residual race between two admins unlinking different links of the same member at
    // once — ADR-283's own Non-goals).
    const [cred] = await tx<[{ member_sub: string }?]>`
      SELECT member_sub FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${targetSub}`
    const credentialWorks = cred && loginMethodCeiling(env).has('local')
      ? await (async () => {
          if (!(await localLoginEnabled({ sql: tx } as never))) return false
          const stance = await resolveSsoStance({ sql: tx } as never, tenant, env)
          return !stance.biting || (await isSsoExempt({ sql: tx } as never, targetSub))
        })()
      : false
    if (!credentialWorks && !(await memberHasAnotherWayIn({ sql: tx } as never, tenant, targetSub, { excludeLinkId: linkId, env }))) {
      return { ok: false, reason: 'last_way_in' }
    }

    // The row-scoped delete (above) — the SELECT already proved this row exists within this tx's view.
    const result = await unlinkMemberIdentityById(tx, tenant.id, linkId, targetSub)
    if (!result) return { ok: false, reason: 'not_found' } // narrow, genuinely-concurrent race (READ COMMITTED, no row lock on the SELECT above), handled rather than asserted away
    await auditIfEntitled(tx, tenant, {
      // ADR-280 §3's own pre-declaration: the SAME action name as self-service, actor/target disambiguate.
      actor: `user:${adminSub}`, action: 'member.identity_unlinked', target: `member:${targetSub}`,
    })
    // Sibling check: `revokeMemberConnectionSlice`'s caller contract is "call only when the connection
    // no longer admits this sub" — self-service satisfies that by construction (it deletes EVERY row
    // for the connection, so no sibling can survive to contradict the answer); this route breaks that
    // invariant ON PURPOSE (exactly one row, by design), so a sibling link to the SAME connection can
    // remain after this delete, and a stored link wins over the deterministic mint (ADR-259 §3.1) — the
    // sibling is still a real door regardless of what `connectionAdmitsSubject` says.
    //
    // Known, accepted gap (mirrors `unlinkMemberIdentity`'s own docstring KNOWN GAP): suppressing the
    // revoke when a sibling survives means the DELETED link's own group-slice contribution, if any,
    // lingers in `member_connection_groups` until the member's next sign-in re-derives the union — not
    // a privilege leak (this is the read side of an already-effective connection), but named rather
    // than silently accepted.
    const [sibling] = await tx<{ id: string }[]>`
      SELECT id FROM member_identities WHERE tenant_id = ${tenant.id} AND connection_id = ${result.connectionId} AND member_sub = ${targetSub} LIMIT 1`
    if (!sibling) {
      const effective = await resolveLoginConnections({ sql: tx } as never, tenant, env)
      const conn = effective.find((c) => c.id === result.connectionId)
      const stillAdmits = conn ? connectionAdmitsSubject(conn, targetSub) : false
      if (!stillAdmits) await revokeMemberConnectionSlice(tx, fga, tenant.id, result.connectionId, targetSub)
    }
    return { ok: true }
  })
}

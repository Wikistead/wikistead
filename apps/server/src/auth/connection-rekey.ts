// #858 / #929, ADR-264: the re-key ADR-259 §3.5 named but withdrew from #960 ("re-key EXCLUDED").
// An administrator declares that a NEW connection supersedes an OLD one — same accident #960 warns
// about in its own delete-handler comment: a recreated connection mints `wc<newid8>_<x>`, orphaning
// every member the old connection minted as `wc<oldid8>_<x>`. This module writes ordinary
// `member_identities` links (member-identities.ts's table, #959) so the new connection's login
// resolves to the SAME member rather than seating a second one — it never rewrites `members.sub`.
import type { TenantDb } from '../db/index.js'
import { auditIfEntitled } from '../audit/sink.js'

export interface RekeyConnectionRow {
  id: string
  issuer: string
  client_id: string
  subject_prefix: string | null
}

/**
 * ADR-264 §3.1/§3.2: the constraint on which pairs of connections may be declared to supersede one
 * another. Same issuer (survives a delete-and-recreate of the same IdP — the id changes, the issuer
 * does not) AND same client_id (OIDC does not guarantee `sub` stability across clients; a pairwise
 * IdP mints a different sub per relying party, so a client change makes the old subs incomparable).
 * A pure function so both the declare-time and apply-time checks (§3.3) call the identical rule.
 */
export function supersessionMismatch(newConn: RekeyConnectionRow, oldConn: RekeyConnectionRow): 'issuer_mismatch' | 'client_id_mismatch' | null {
  if (newConn.issuer !== oldConn.issuer) return 'issuer_mismatch'
  if (newConn.client_id !== oldConn.client_id) return 'client_id_mismatch'
  return null
}

function rekeyError(code: string, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { statusCode: 409, code, ...extra })
}

async function readPair(sql: TenantDb['sql'], newConnectionId: string, oldConnectionId: string) {
  const rows = await sql<RekeyConnectionRow[]>`
    SELECT id, issuer, client_id, subject_prefix FROM tenant_oidc WHERE id IN (${newConnectionId}, ${oldConnectionId})`
  const newConn = rows.find((r) => r.id === newConnectionId) ?? null
  const oldConn = rows.find((r) => r.id === oldConnectionId) ?? null
  return { newConn, oldConn }
}

function assertDeclarable(newConn: RekeyConnectionRow | null, oldConn: RekeyConnectionRow | null): asserts newConn is RekeyConnectionRow {
  if (!newConn || !oldConn) throw Object.assign(new Error('connection not found'), { statusCode: 404 })
  // Legacy (pre-#570) rows carry a NULL subject_prefix — raw, un-namespaced subs. §2's mechanism acts
  // only on subs carrying the RETIRING connection's prefix, which a NULL-prefix connection has none
  // of by construction; declaring against one would either match nothing or (if read carelessly)
  // match every raw sub in the tenant, which is not a re-key.
  if (oldConn.subject_prefix == null) throw rekeyError('no_subject_prefix', 'the retiring connection mints unprefixed subjects and cannot be re-keyed')
  if (newConn.subject_prefix == null) throw rekeyError('no_subject_prefix', 'the replacement connection mints unprefixed subjects and cannot receive a re-key')
  const mismatch = supersessionMismatch(newConn, oldConn)
  if (mismatch === 'issuer_mismatch') throw rekeyError('issuer_mismatch', 'the two connections do not share an issuer — this is not the same directory reconnected')
  if (mismatch === 'client_id_mismatch') throw rekeyError('client_id_mismatch', 'the two connections do not share a client id — subjects are not guaranteed comparable across OAuth clients')
}

export interface RekeyCollision { oldSub: string; otherSub: string }

export class SupersessionCollisionError extends Error {
  readonly statusCode = 409
  readonly code = 'supersession_collision'
  readonly collisions: RekeyCollision[]
  constructor(collisions: RekeyCollision[]) {
    super('the replacement connection has already seated a different member at one of the subjects this re-key would claim')
    this.collisions = collisions
  }
}

export interface ApplySupersessionResult { linksWritten: number }

/**
 * ADR-264 §3: declare (checked once against the rows as first read) then apply (re-checked, inside
 * the transaction, against a FRESH read) — §3.3's reason: "a rule verified once against a row
 * somebody can still change is a rule about the past." `opts.beforeApply` is a TEST-ONLY seam: production
 * callers never pass it, and it exists to let a pin simulate a row being edited in the gap between
 * the two checks.
 */
export async function applyConnectionSupersession(
  db: TenantDb,
  tenant: { id: string; plan: string },
  actorSub: string,
  newConnectionId: string,
  oldConnectionId: string,
  opts?: { beforeApply?: () => Promise<void> },
): Promise<ApplySupersessionResult> {
  const declared = await readPair(db.sql, newConnectionId, oldConnectionId)
  assertDeclarable(declared.newConn, declared.oldConn)

  if (opts?.beforeApply) await opts.beforeApply()

  return db.tx(async (tx) => {
    const applied = await readPair(tx, newConnectionId, oldConnectionId)
    assertDeclarable(applied.newConn, applied.oldConn)
    const oldConn = applied.oldConn!
    const newConn = applied.newConn

    const carriers = await tx<{ sub: string }[]>`
      SELECT sub FROM members WHERE tenant_id = ${tenant.id} AND sub LIKE ${oldConn.subject_prefix! + '%'}`

    // §3.5: a collision refuses, names both members, and writes nothing — checked over the WHOLE set
    // before any INSERT, so a collision found on carrier #5 does not leave #1-4 written.
    const collisions: RekeyCollision[] = []
    const externalSubjects = carriers.map((c) => ({ oldSub: c.sub, x: c.sub.slice(oldConn.subject_prefix!.length) }))
    for (const { oldSub, x } of externalSubjects) {
      const [linked] = await tx<{ member_sub: string }[]>`
        SELECT member_sub FROM member_identities
        WHERE tenant_id = ${tenant.id} AND connection_id = ${newConnectionId} AND external_subject = ${x}`
      if (linked && linked.member_sub !== oldSub) { collisions.push({ oldSub, otherSub: linked.member_sub }); continue }
      const [seated] = await tx<{ sub: string }[]>`
        SELECT sub FROM members WHERE tenant_id = ${tenant.id} AND sub = ${newConn.subject_prefix! + x}`
      if (seated && seated.sub !== oldSub) collisions.push({ oldSub, otherSub: seated.sub })
    }
    if (collisions.length > 0) throw new SupersessionCollisionError(collisions)

    let written = 0
    for (const { oldSub, x } of externalSubjects) {
      const res = await tx`
        INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
        VALUES (${tenant.id}, ${newConnectionId}, ${x}, ${oldSub})
        ON CONFLICT (tenant_id, connection_id, external_subject) DO NOTHING`
      if (res.count > 0) written++
    }

    // ADR-264 §5: "the applied re-key is one audited operation naming both connections and the
    // number of links written. Zero links written is reported, not silent" — written unconditionally,
    // including when `carriers` was empty (the loops above are no-ops and `written` stays 0).
    await auditIfEntitled(tx, tenant, {
      actor: `user:${actorSub}`,
      action: 'connection.superseded',
      target: `connection:${newConnectionId}<-${oldConnectionId} links:${written}`,
    })

    return { linksWritten: written }
  })
}

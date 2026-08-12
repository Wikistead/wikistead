// #605 / ADR-210: the SSO-required STANCE — decided by a predicate of its own, beside the resolvers.
//
// §R5-2 is the reason this is not folded into either resolver: `resolveLoginConnections` does not
// decrypt (a corrupt secret would hold the stance up forever while nobody can sign in) and
// `resolveAvailableLogin` throws on a bad secret (the stance would turn one broken row into a 500 on
// the PASSWORD path — the very door that must not close). So the stance counts a federated connection
// only if it is enabled AND its secret decrypts, per connection, and ANY failure of this evaluation
// falls to the LAPSE side: an error can open the password door early; it must never hold it shut.
//
// The stance never bites while no federated method is effective (§2 (d), the same lapse discipline as
// the platform preference): stored intent is kept, nothing is rewritten, and restoring a connection
// resumes enforcement with no extra write (§R5-4 — intended, not a bug; the enable side gets no guard).
import { resolveEntitlements } from '@wikistead/entitlements'
import type { TenantDb } from '../db/index.js'
import { loginMethodCeiling } from './login-methods.js'
import { decryptSecret } from './secret-crypto.js'

export interface SsoStance {
  /** the stored intent (tenant_login_prefs.sso_required) */
  selected: boolean
  /** selected AND at least one federated way in is REAL right now — the only state that closes doors */
  biting: boolean
}

// §R5-6: the LOGIN-path reader of the new column tolerates 42P01 (missing table) AND 42703 (missing
// column — the column is a later arrival, unlike 087's) and reads absence as "no stance". The admin
// route and the CLI deliberately do NOT use this — they read the row with zero tolerance, because
// silently rendering "no stance" against a half-migrated schema is how a stance gets double-written.
export async function ssoRequiredSelected(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ sso_required: boolean }[]>`SELECT sso_required FROM tenant_login_prefs LIMIT 1`.catch((err: unknown) => {
    const code = (err as { code?: string }).code
    if (code === '42P01' || code === '42703') return [] as { sso_required: boolean }[]
    throw err
  })
  return !!row?.sso_required
}

/** How many federated ways in are REAL right now (enabled AND, for oidc, the secret decrypts). The
 *  write-time precondition for turning the stance ON (§R5-4) asks this directly, before any intent is
 *  stored — the same count the stance's own lapse uses, so the two cannot disagree. */
export async function federatedWayInCount(
  db: TenantDb, tenant: { plan: string }, env?: string | undefined, opts?: { exceptConnectionId?: string },
): Promise<number> {
  const ceiling = loginMethodCeiling(env)
  let federated = 0
  if (ceiling.has('tenant-oidc')) {
    const rows = await db.sql<{ id: string; client_secret_enc: string | null }[]>`
      SELECT id, client_secret_enc FROM tenant_oidc WHERE enabled`
    for (const r of rows) {
      if (opts?.exceptConnectionId === r.id) continue
      try {
        if (r.client_secret_enc != null) decryptSecret(r.client_secret_enc)
        federated++
      } catch {
        // a row whose secret cannot be decrypted is not a way in, whatever the display says
      }
    }
  }
  // #693 seam: the CE stance resolver asks whether the SAML door counts as an own IdP; its bytes live in ee/
  if (ceiling.has('saml') && resolveEntitlements(tenant.plan).samlSso) {
    const [saml] = await db.sql<{ id: string }[]>`SELECT id FROM tenant_saml WHERE enabled LIMIT 1`.catch((err: unknown) => {
      if ((err as { code?: string }).code === '42P01') return [] as { id: string }[]
      throw err
    })
    if (saml && opts?.exceptConnectionId !== saml.id) federated++
  }
  return federated
}

/**
 * The one decision point. `exceptConnectionId` is the COUNTERFACTUAL knob (§R5-1): the lockout guards
 * ask "would the stance still bite AFTER this write", so they evaluate with the row being disabled
 * already dropped — a guard that asks about the present refuses the very write that would lapse the
 * stance and re-open the password door.
 */
export async function resolveSsoStance(
  db: TenantDb,
  tenant: { plan: string },
  env?: string | undefined,
  opts?: { exceptConnectionId?: string },
): Promise<SsoStance> {
  let selected = false
  try {
    selected = await ssoRequiredSelected(db)
    if (!selected) return { selected: false, biting: false }
    return { selected, biting: (await federatedWayInCount(db, tenant, env, opts)) > 0 }
  } catch {
    // §R5-2: the evaluation itself failed — fall to lapse. The stored intent is still reported when it
    // was readable, so the admin surface can say "lapsed" rather than "off".
    return { selected, biting: false }
  }
}

/** Is `memberSub` exempt from the stance (ADR-210 §2 (a))? RLS scopes the read to the tenant. */
export async function isSsoExempt(db: TenantDb, memberSub: string): Promise<boolean> {
  const [row] = await db.sql<{ member_sub: string }[]>`
    SELECT member_sub FROM sso_exemptions WHERE member_sub = ${memberSub}`.catch((err: unknown) => {
    if ((err as { code?: string }).code === '42P01') return [] as { member_sub: string }[]
    throw err
  })
  return !!row
}

/**
 * The §4 branch-2 question, asked by the entrances that use or hand over a key (rows 3–5): does the
 * stance close the local door for THIS member? Rows 6–7 (an admin arranging a key; a signed-in member
 * maintaining their own) never ask; rows 8–9 (a NEW person) refuse whenever the stance bites.
 */
export async function stanceBlocksLocalFor(
  db: TenantDb, tenant: { plan: string }, memberSub: string, env?: string | undefined,
): Promise<boolean> {
  const stance = await resolveSsoStance(db, tenant, env)
  if (!stance.biting) return false
  return !(await isSsoExempt(db, memberSub))
}

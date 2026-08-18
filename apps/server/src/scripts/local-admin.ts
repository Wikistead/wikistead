// Break-glass first admin (#616 / ADR-212 slice 1, adopting ADR-198 §7's shape):
//
//   pnpm tenant:local-admin <tenantSlug> <email> [--create] [--plan=free] [--by=<operator>]
//
// It does NOT hand somebody a sub. `provisionTenant` calls `assertExternalSub` unconditionally and
// every connection since #554 S4 stamps a `subject_prefix`, so the sub a real login arrives with is
// reserved: an operator who passes the sub their colleague will actually use gets a 400, and one who
// passes a sub that survives the gate has created an admin row nobody can sign in as. The entrance is a
// PASSWORD INVITE — the first admin arrives holding a credential the operator handed them.
//
// OPERATOR action: admin DB credentials, bypasses RLS, no tenant session, NO HTTP surface. Like
// `tenant:login-methods` it may override a tenant-side guard, and like it, it says so in the output and
// records the act in the operator ledger. What it will not do is rewrite the tenant's stance: a policy
// that survives its own rescue is the difference between break-glass and a silent policy change.
//
// ORDER IS LOAD-BEARING, and it is the opposite of what ADR-212 assumed (measured in
// adminless-invite-probe-616): `createInvite({kind:'local'})` refuses at ISSUE time while password
// sign-in is off, so the enablement comes FIRST or the command dies on its own first step.
import os from 'node:os'
import postgres from 'postgres'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import { resolveSsoStance } from '../auth/sso-stance.js'
import { createInvite } from '../auth/invites.js'
import { acquireTenantDb } from '../db/index.js'
import { isValidSlug } from '../auth/provisioning.js'
import type { Tenant } from '@wikistead/types'

export interface LocalAdminResult {
  tenantId: string
  slug: string
  created: boolean
  /** the tenant asked for SSO only, and this recovery went past it */
  steppedOverStance: boolean
  /** local sign-in had to be switched on for the invite to be issuable at all */
  enabledLocalLogin: boolean
  inviteUrl: string
  expiresAt: Date
}

/** The whole act, in one place, so the CLI wrapper is only argument parsing and printing. */
export async function createLocalAdmin(
  sql: postgres.Sql,
  args: { slug: string; email: string; create?: boolean; plan?: string; by?: string; origin?: string },
): Promise<LocalAdminResult> {
  if (!args.email.includes('@')) throw new Error(`"${args.email}" is not an email address — it becomes the sign-in name`)

  let [tenant] = await sql<{ id: string; slug: string; plan: string }[]>`
    SELECT id, slug, plan FROM tenants WHERE slug = ${args.slug}`
  let created = false
  if (!tenant) {
    // The slug rule is a rule about MAKING a name (reserved subdomains, shape). It is checked here,
    // where a name is minted — not above, where it also refused to recover a tenant that already
    // holds the name.
    //
    // #726 measured what that cost: the self-host guide seeds a `dev` tenant on `dev.localhost` and
    // then tells the reader to run this command for their first administrator. `dev` is RESERVED, so
    // the command refused, and the evaluation stack had no way in at all — the seeded admin only
    // works through the dev bearer, which the self-host profile now correctly rejects.
    //
    // Recovering an existing tenant cannot claim a namespace: the row is already there, and getting
    // here requires database credentials.
    if (!isValidSlug(args.slug)) throw new Error(`"${args.slug}" is not a usable tenant slug`)
    if (!args.create) {
      throw new Error(`no tenant "${args.slug}" — pass --create to make one, or check the slug`)
    }
    const [row] = await sql<{ id: string; slug: string; plan: string }[]>`
      INSERT INTO tenants (slug, plan) VALUES (${args.slug}, ${args.plan ?? 'free'})
      RETURNING id, slug, plan`
    tenant = row!
    created = true
  }

  const asTenant = { id: tenant.id, slug: tenant.slug, plan: tenant.plan, isolation: 'logical' } as Tenant
  const db = await acquireTenantDb(asTenant)
  try {
    // The stance is READ before anything is changed, so the output can name what this act stepped over.
    // Read for the ledger too: "the operator overrode a policy" is a different fact from "the operator
    // recovered a tenant", andasked for both to be readable.
    const stance = await resolveSsoStance(db, { plan: tenant.plan })

    // FIRST (see the order note above), and only when it is not already on — a command that reports
    // enabling something it did not enable is the same lie in the other direction.
    const [prefs] = await db.sql<{ local_login_enabled: boolean }[]>`
      SELECT local_login_enabled FROM tenant_login_prefs LIMIT 1`
    const enabledLocalLogin = prefs?.local_login_enabled !== true
    if (enabledLocalLogin) {
      await db.sql`
        INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${tenant.id}, true)
        ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true`
    }

    const invite = await createInvite(db, {
      tenantId: tenant.id, plan: tenant.plan,
      // not a member, and deliberately shaped like the ledger's actor so the invite row itself says
      // where it came from (`invites.invited_by` has no FK — measured, not assumed)
      invitedBy: `operator:${args.by ?? os.userInfo().username}`,
      email: args.email, role: 'admin', kind: 'local',
      operatorOverride: true,
    })

    await sql.begin(async (tx) => {
      await appendOperatorEntry(tx, {
        actor: `operator:${args.by ?? os.userInfo().username}`,
        action: created ? 'tenant.local_admin_created' : 'tenant.local_admin_recovered',
        target: `tenant:${tenant!.id}`,
        at: new Date().toISOString(),
      })
      // the SECOND fact, as its own entry: stepping over a tenant's policy is not the same act as
      // recovering it, and a reader of the chain must be able to see it without inferring
      if (stance.biting) {
        await appendOperatorEntry(tx, {
          actor: `operator:${args.by ?? os.userInfo().username}`,
          action: 'tenant.sso_stance_overridden',
          target: `tenant:${tenant!.id}`,
          at: new Date().toISOString(),
        })
      }
    })

    const origin = args.origin ?? `https://${tenant.slug}.${process.env.PUBLIC_TENANT_BASE_HOST ?? 'localhost'}`
    return {
      tenantId: tenant.id, slug: tenant.slug, created,
      steppedOverStance: stance.biting, enabledLocalLogin,
      inviteUrl: `${origin}/invite?token=${invite.token}`,
      expiresAt: invite.expiresAt,
    }
  } finally {
    await db.release()
  }
}

/** What the operator reads at 3am. Every line is a fact this act changed. */
export function renderLocalAdmin(r: LocalAdminResult): string[] {
  const out = [
    `${r.created ? 'created' : 'recovered'} tenant ${r.slug} (${r.tenantId})`,
    r.enabledLocalLogin
      ? 'password sign-in: turned ON for this tenant (the invite cannot be issued without it)'
      : 'password sign-in: already on',
  ]
  if (r.steppedOverStance) {
    // `tenant:login-methods` prints its effective set and shouts when it is empty, for the same reason:
    // at 3am the only thing an operator can trust is what the command said it did.
    out.push('WARNING: this tenant requires SSO. The recovery stepped over that stance to issue a password invite.')
    out.push('         The stance itself was NOT changed — it still applies to everyone else, and to this')
    out.push('         person once they are in. Recorded in the operator ledger as tenant.sso_stance_overridden.')
  }
  out.push(`first-admin invite (expires ${r.expiresAt.toISOString()}):`)
  out.push(`  ${r.inviteUrl}`)
  return out
}

// Exported for the EE composition's wrapper (#693) — same command, EE-composed process.
export async function cliMain(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const [slug, email] = positional
  if (!slug || !email) {
    console.error('usage: pnpm tenant:local-admin <tenantSlug> <email> [--create] [--plan=free] [--by=<operator>] [--origin=https://…]')
    process.exit(2)
  }
  const sql = postgres(process.env.DATABASE_ADMIN_URL!)
  try {
    const res = await createLocalAdmin(sql, {
      slug, email,
      create: argv.includes('--create'),
      ...(flag('plan') ? { plan: flag('plan')! } : {}),
      ...(flag('by') ? { by: flag('by')! } : {}),
      ...(flag('origin') ? { origin: flag('origin')! } : {}),
    })
    for (const line of renderLocalAdmin(res)) console.log(line)
  } catch (e) {
    console.error(`tenant:local-admin failed — ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}

// Exact-URL match (not endsWith): the EE wrapper shares this basename and imports this module —
// a suffix guard would run the CE composition once on import and the wrapper's call second (#693).
if (import.meta.url === `file://${process.argv[1]}`) void cliMain()

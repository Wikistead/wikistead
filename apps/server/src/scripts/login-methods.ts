// Break-glass, whole-picture edition (#537 / ADR-195 §10, ruling 5): ONE command that PRINTS a
// tenant's effective login-method set and SETS it — in the ENABLE direction the per-feature
// commands (tenant:oidc-disable / tenant:saml-disable) deliberately lack.
//
//   pnpm tenant:login-methods <tenantSlug>                          # print the picture
//   pnpm tenant:login-methods <tenantSlug> --enable=tenant-oidc     # flip a method's selection ON
//   pnpm tenant:login-methods <tenantSlug> --disable=saml           # ...or OFF
//   pnpm tenant:login-methods <tenantSlug> --platform-login=on|off  # the shared-IdP toggle
//   ... [--by=<operator>]
//
// OPERATOR action: admin DB credentials, bypasses RLS, no tenant session, NO HTTP surface. It
// overrides the TENANT-side guards (ruling 4, the 409 lockout guards) — at 3am the operator must be
// able to set any selection — but it always prints the resulting effective set and shouts when that
// set is EMPTY. What it cannot rewrite is the CEILING: `LOGIN_METHODS` is deployment env, owned by
// the same operator running this command, so when the ceiling is the blocker the output names the
// exact env change instead of silently shadowing a security control with a DB row (two sources of
// truth for the ceiling is how the next 3am happens). Enable-direction writes flip ONLY the enabled
// flag — break-glass never invents config; a tenant with no stored IdP config gets an error naming
// what is missing.
import os from 'node:os'
import postgres from 'postgres'
import { emit } from '@wikistead/events'
import { resolveEntitlements } from '@wikistead/entitlements'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import { loginMethodCeiling, type LoginMethod } from '../auth/login-methods.js'
import { loadPlatformOidc } from '../auth/oidc.js'

export interface MethodPicture {
  inCeiling: boolean
  configured: boolean
  selected: boolean
  effective: boolean
  blocker: 'ceiling' | 'config' | 'selection' | 'entitlement' | null
}
export interface LoginMethodsPicture {
  tenantId: string
  slug: string
  plan: string
  ceiling: LoginMethod[]
  methods: Record<LoginMethod, MethodPicture>
  effectiveSet: LoginMethod[]
}

// The whole picture, from the operator connection (bypasses RLS). Mirrors the request-time resolver's
// ENABLED-level predicates; like the guards, it cannot see a broken cfg (undecryptable secret,
// corrupt cert) — stated in the output as a caveat rather than pretended away.
export async function inspectLoginMethods(sql: postgres.Sql, args: { slug: string }): Promise<LoginMethodsPicture> {
  const [tenant] = await sql<{ id: string; plan: string }[]>`SELECT id, plan FROM tenants WHERE slug = ${args.slug}`
  if (!tenant) throw Object.assign(new Error(`no tenant with slug "${args.slug}"`), { code: 'tenant_not_found' })
  const ceiling = loginMethodCeiling()
  const [oidc] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc WHERE tenant_id = ${tenant.id}`
  const [saml] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml WHERE tenant_id = ${tenant.id}`.catch(() => [] as { enabled: boolean }[])
  const [pref] = await sql<{ platform_login_disabled: boolean }[]>`SELECT platform_login_disabled FROM tenant_login_prefs WHERE tenant_id = ${tenant.id}`
  const platformCfg = !!loadPlatformOidc()
  const entitledSaml = resolveEntitlements(tenant.plan).samlSso

  const pick = (m: {
    inCeiling: boolean
    configured: boolean
    selected: boolean
    entitled?: boolean
  }): MethodPicture => {
    const effective = m.inCeiling && m.configured && m.selected && m.entitled !== false
    const blocker = effective
      ? null
      : !m.inCeiling
        ? ('ceiling' as const)
        : m.entitled === false
          ? ('entitlement' as const)
          : !m.configured
            ? ('config' as const)
            : ('selection' as const)
    return { inCeiling: m.inCeiling, configured: m.configured, selected: m.selected, effective, blocker }
  }

  const methods: Record<LoginMethod, MethodPicture> = {
    'tenant-oidc': pick({ inCeiling: ceiling.has('tenant-oidc'), configured: oidc != null, selected: !!oidc?.enabled }),
    'platform-oidc': pick({ inCeiling: ceiling.has('platform-oidc'), configured: platformCfg, selected: !pref?.platform_login_disabled }),
    saml: pick({ inCeiling: ceiling.has('saml'), configured: saml != null, selected: !!saml?.enabled, entitled: entitledSaml }),
  }
  return {
    tenantId: tenant.id,
    slug: args.slug,
    plan: tenant.plan,
    ceiling: [...ceiling],
    methods,
    effectiveSet: (Object.keys(methods) as LoginMethod[]).filter((k) => methods[k].effective),
  }
}

export interface RecoverArgs {
  slug: string
  operator: string
  enable?: LoginMethod
  disable?: LoginMethod
  platformLogin?: 'on' | 'off'
}
export interface RecoverResult {
  changed: boolean
  picture: LoginMethodsPicture // AFTER the write
}

// Set the tenant-side selection. One transaction with the durable operator-ledger append (ADR-089):
// an unrecorded privileged write must be impossible. `platform-oidc` in --enable/--disable maps to
// the prefs row (its selection has no per-IdP home).
export async function recoverLoginMethods(sql: postgres.Sql, args: RecoverArgs): Promise<RecoverResult> {
  const before = await inspectLoginMethods(sql, { slug: args.slug })
  const at = new Date().toISOString()
  const wants: Array<{ method: LoginMethod; on: boolean }> = []
  if (args.enable) wants.push({ method: args.enable, on: true })
  if (args.disable) wants.push({ method: args.disable, on: false })
  if (args.platformLogin) wants.push({ method: 'platform-oidc', on: args.platformLogin === 'on' })

  let changed = false
  await sql.begin(async (tx) => {
    for (const w of wants) {
      const cur = before.methods[w.method]
      if (w.method === 'platform-oidc') {
        if (cur.selected === w.on) continue
        await tx`
          INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled)
          VALUES (${before.tenantId}, ${!w.on})
          ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = ${!w.on}, updated_at = now()
        `
      } else {
        if (!cur.configured) {
          // Enable-only flips the flag; break-glass never invents config.
          throw Object.assign(
            new Error(`"${args.slug}" has no stored ${w.method} config — break-glass can flip 'enabled', not create a config. Configure it first (admin UI or DB).`),
            { code: 'no_config' },
          )
        }
        if (cur.selected === w.on) continue
        if (w.method === 'tenant-oidc') {
          await tx`UPDATE tenant_oidc SET enabled = ${w.on}, updated_at = now() WHERE tenant_id = ${before.tenantId}`
        } else {
          await tx`UPDATE tenant_saml SET enabled = ${w.on}, updated_at = now() WHERE tenant_id = ${before.tenantId}`
        }
      }
      changed = true
      await appendOperatorEntry(tx, {
        actor: `operator:${args.operator}`,
        action: 'tenant.login_methods_recovered',
        target: `tenant:${before.tenantId}`,
        at,
      })
    }
  })
  if (changed) {
    emit({ type: 'tenant.login_methods_recovered', tenantId: before.tenantId, operator: args.operator })
    console.log(
      `[break-glass] tenant.login_methods_recovered tenant=${before.tenantId} slug=${args.slug} operator=${args.operator} at=${at}`,
    )
  }
  return { changed, picture: await inspectLoginMethods(sql, { slug: args.slug }) }
}

export function renderPicture(p: LoginMethodsPicture): string {
  const lines: string[] = []
  lines.push(`tenant ${p.slug} (${p.tenantId}, plan=${p.plan})`)
  lines.push(`ceiling (LOGIN_METHODS): ${p.ceiling.join(', ') || '(empty!)'}`)
  for (const [name, m] of Object.entries(p.methods)) {
    const state = m.effective ? 'EFFECTIVE' : `off (blocker: ${m.blocker})`
    lines.push(`  ${name.padEnd(14)} ${state}  [ceiling=${m.inCeiling} configured=${m.configured} selected=${m.selected}]`)
  }
  lines.push(`effective set: ${p.effectiveSet.join(', ') || 'EMPTY — nobody can sign in to this tenant!'}`)
  const ceilingBlocked = Object.entries(p.methods).filter(([, m]) => m.blocker === 'ceiling' && m.selected && m.configured)
  if (ceilingBlocked.length > 0) {
    lines.push(
      `NOTE: ${ceilingBlocked.map(([n]) => n).join(', ')} blocked ONLY by the deployment ceiling — ` +
        `this command cannot rewrite env; set LOGIN_METHODS to include it (or unset for all) and restart.`,
    )
  }
  lines.push('caveat: predicates are enabled-level — a stored-but-broken cfg (bad secret/cert) still shows EFFECTIVE.')
  return lines.join('\n')
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) {
    console.error('usage: pnpm tenant:login-methods <tenantSlug> [--enable=<m>] [--disable=<m>] [--platform-login=on|off] [--by=<operator>]')
    process.exit(2)
  }
  const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const asMethod = (v: string | undefined): LoginMethod | undefined => {
    if (v === undefined) return undefined
    if (v === 'tenant-oidc' || v === 'platform-oidc' || v === 'saml') return v
    console.error(`unknown method "${v}" (valid: tenant-oidc, platform-oidc, saml)`)
    process.exit(2)
  }
  const platformLogin = opt('platform-login')
  if (platformLogin !== undefined && platformLogin !== 'on' && platformLogin !== 'off') {
    console.error('--platform-login takes on|off')
    process.exit(2)
  }
  const operator = opt('by') || process.env.WIKISTEAD_OPERATOR || os.userInfo().username || 'unknown'
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const enable = asMethod(opt('enable'))
    const disable = asMethod(opt('disable'))
    if (!enable && !disable && !platformLogin) {
      console.log(renderPicture(await inspectLoginMethods(adminPool, { slug })))
    } else {
      const r = await recoverLoginMethods(adminPool, { slug, operator, enable, disable, platformLogin: platformLogin as 'on' | 'off' | undefined })
      console.log(r.changed ? 'changed.' : 'no-op (already in the requested state).')
      console.log(renderPicture(r.picture))
    }
  } catch (err) {
    console.error(`tenant:login-methods: ${(err as Error).message}`)
    process.exit(1)
  } finally {
    await adminPool.end()
  }
}

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
  blocker: 'ceiling' | 'config' | 'selection' | 'entitlement' | 'stance' | null
}
export interface LoginMethodsPicture {
  tenantId: string
  slug: string
  plan: string
  ceiling: LoginMethod[]
  // #605: the stance, printed so the operator sees WHY local/platform are blocked (never a lie of omission)
  ssoRequired: { selected: boolean; biting: boolean }
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
  // #554 S1: deterministic first connection (the row every legacy read path picks); the kind-level
  // writes below flip ALL of the tenant's oidc connections — TODO(#554 S4): per-connection --connection.
  const [oidc] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc WHERE tenant_id = ${tenant.id} ORDER BY sort, id LIMIT 1`
  const [saml] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml WHERE tenant_id = ${tenant.id}`.catch(() => [] as { enabled: boolean }[])
  const [pref] = await sql<{ platform_login_disabled: boolean; local_login_enabled: boolean; sso_required: boolean }[]>`SELECT platform_login_disabled, local_login_enabled, sso_required FROM tenant_login_prefs WHERE tenant_id = ${tenant.id}`
  const platformCfg = !!loadPlatformOidc()
  // #693 seam: the CLI mirrors the resolver's door composition; SAML bytes live in ee/
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

  const tenantOidc = pick({ inCeiling: ceiling.has('tenant-oidc'), configured: oidc != null, selected: !!oidc?.enabled })
  const samlPic = pick({ inCeiling: ceiling.has('saml'), configured: saml != null, selected: !!saml?.enabled, entitled: entitledSaml })
  // Mirror the resolver's CONDITIONAL pref (Slice 3 finding 1): "platform off" bites only while an
  // own IdP is effective; otherwise it LAPSES and platform login is back open (no lockout by pref).
  // #568 / ADR-198 §3: local is an own way in — it counts toward the lapse condition below exactly
  // as tenant-oidc and saml do. "Configured" has no meaning for a method with nothing to configure,
  // so the tenant's switch IS both the configuration and the selection.
  const localPic = pick({ inCeiling: ceiling.has('local'), configured: true, selected: !!pref?.local_login_enabled })
  const ownIdpEffective = tenantOidc.effective || samlPic.effective || localPic.effective
  const platformSelected = !pref?.platform_login_disabled
  const platform = pick({
    inCeiling: ceiling.has('platform-oidc'),
    configured: platformCfg,
    selected: platformSelected || !ownIdpEffective, // lapsed pref = effectively selected
  })
  // #605 / ADR-210: the STANCE, folded into the effective set the operator trusts at 3am — before
  // this, the CLI would print a stance-blocked `local` as EFFECTIVE (the cost of option (c)).
  // Same enabled-level caveat as everything here: this cannot see an undecryptable secret, so a
  // stance the runtime has lapsed (broken cfg) may still print as biting — stated, not pretended away.
  const ssoSelected = !!pref?.sso_required
  const ssoBiting = ssoSelected && (tenantOidc.effective || samlPic.effective)
  const methods: Record<LoginMethod, MethodPicture> = {
    'tenant-oidc': tenantOidc,
    'platform-oidc': ssoBiting
      ? { ...platform, selected: platformSelected, effective: false, blocker: 'stance' }
      : { ...platform, selected: platformSelected }, // report the STORED intent, effect includes the lapse
    saml: samlPic,
    local: ssoBiting ? { ...localPic, effective: false, blocker: 'stance' } : localPic,
  }
  return {
    tenantId: tenant.id,
    slug: args.slug,
    plan: tenant.plan,
    ceiling: [...ceiling],
    ssoRequired: { selected: ssoSelected, biting: ssoBiting },
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
  // #605: the operator can unlock (or set) the stance — the tenant-side preconditions are deliberately
  // bypassed here, like every other guard this tool overrides; the ledger records it.
  ssoRequired?: 'on' | 'off'
  // #554 S4 / ADR-197 §2: per-connection break-glass — flips ONE tenant_oidc row by its minted id
  // instead of the whole kind. Composable with --enable/--disable being absent.
  connection?: { id: string; on: boolean }
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
    // #605: the stance write — same ledger discipline as everything here
    if (args.ssoRequired && before.ssoRequired.selected !== (args.ssoRequired === 'on')) {
      const on = args.ssoRequired === 'on'
      await tx`INSERT INTO tenant_login_prefs (tenant_id, sso_required) VALUES (${before.tenantId}, ${on})
               ON CONFLICT (tenant_id) DO UPDATE SET sso_required = ${on}, updated_at = now()`
      changed = true
      await appendOperatorEntry(tx, {
        actor: `operator:${args.operator}`,
        action: on ? 'tenant.sso_required_on' : 'tenant.sso_required_off',
        target: `tenant:${before.tenantId}`,
        at,
        reason: 'recovery',
      })
    }
    if (args.connection) {
      const [row] = await tx<{ id: string; enabled: boolean }[]>`
        SELECT id, enabled FROM tenant_oidc WHERE id = ${args.connection.id} AND tenant_id = ${before.tenantId}`
      if (!row) {
        throw Object.assign(new Error(`no connection ${args.connection.id} on "${args.slug}" — break-glass flips flags, it never invents config.`), { code: 'no_config' })
      }
      if (row.enabled !== args.connection.on) {
        await tx`UPDATE tenant_oidc SET enabled = ${args.connection.on}, updated_at = now() WHERE id = ${row.id}`
        changed = true
        await appendOperatorEntry(tx, {
          actor: `operator:${args.operator}`,
          action: args.connection.on ? 'tenant.connection_enabled' : 'tenant.connection_disabled',
          target: `tenant:${before.tenantId}`,
          at,
          reason: 'recovery',
        })
      }
    }
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
        // #568 review B3: an EXPLICIT branch per method. This was an if/else where anything that was
        // not tenant-oidc wrote `tenant_saml`, so `local` — which is "configured" by construction and
        // therefore never hit the guard above — would have silently flipped SAML instead. The CLI's
        // argument parser refuses `local` today, so it was a mine rather than a live bug; a mine in
        // the break-glass path is worse than most, because it is used at 3am on a tenant nobody can
        // get into.
        if (w.method === 'tenant-oidc') {
          await tx`UPDATE tenant_oidc SET enabled = ${w.on}, updated_at = now() WHERE tenant_id = ${before.tenantId}`
        } else if (w.method === 'saml') {
          await tx`UPDATE tenant_saml SET enabled = ${w.on}, updated_at = now() WHERE tenant_id = ${before.tenantId}`
        } else if (w.method === 'local') {
          // Password sign-in has no config of its own; the tenant's switch IS the whole state.
          await tx`
            INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled)
            VALUES (${before.tenantId}, ${w.on})
            ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${w.on}, updated_at = now()
          `
        } else {
          throw Object.assign(new Error(`break-glass does not know how to flip "${w.method}"`), { code: 'unknown_method' })
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
  if (p.ssoRequired.selected) {
    lines.push(`sso-required: ${p.ssoRequired.biting ? 'ON (biting)' : 'ON but LAPSED (no federated method effective — password/platform doors are open)'} — unlock: --sso-required=off`)
  }
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
  const pm = p.methods['platform-oidc']
  if (pm.effective && !pm.selected) {
    lines.push('NOTE: platform login is OFF by tenant preference but LAPSED back open — no own IdP is effective (SSO enforcement resumes when one is).')
  }
  lines.push('caveat: predicates are enabled-level — a stored-but-broken cfg (bad secret/cert) still shows EFFECTIVE.')
  return lines.join('\n')
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2]
  if (!slug || slug.startsWith('--')) {
    console.error('usage: pnpm tenant:login-methods <tenantSlug> [--enable=<m>] [--disable=<m>] [--connection=<id>:on|off] [--platform-login=on|off] [--sso-required=on|off] [--by=<operator>]')
    process.exit(2)
  }
  const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const asMethod = (v: string | undefined): LoginMethod | undefined => {
    if (v === undefined) return undefined
    // #568 §3 M8: break-glass learns `local` — a tenant whose only way in is password sign-in must
    // be recoverable from the same place as every other one.
    if (v === 'tenant-oidc' || v === 'platform-oidc' || v === 'saml' || v === 'local') return v
    console.error(`unknown method "${v}" (valid: tenant-oidc, platform-oidc, saml, local)`)
    process.exit(2)
  }
  const platformLogin = opt('platform-login')
  if (platformLogin !== undefined && platformLogin !== 'on' && platformLogin !== 'off') {
    console.error('--platform-login takes on|off')
    process.exit(2)
  }
  const ssoRequired = opt('sso-required')
  if (ssoRequired !== undefined && ssoRequired !== 'on' && ssoRequired !== 'off') {
    console.error('--sso-required takes on|off')
    process.exit(2)
  }
  const operator = opt('by') || process.env.WIKISTEAD_OPERATOR || os.userInfo().username || 'unknown'
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const enable = asMethod(opt('enable'))
    const disable = asMethod(opt('disable'))
    const connRaw = opt('connection')
    let connection: { id: string; on: boolean } | undefined
    if (connRaw !== undefined) {
      const m = /^(.+):(on|off)$/.exec(connRaw)
      if (!m) { console.error('--connection takes <id>:on|off'); process.exit(2) }
      connection = { id: m[1]!, on: m[2] === 'on' }
    }
    if (!enable && !disable && !platformLogin && !connection && !ssoRequired) {
      console.log(renderPicture(await inspectLoginMethods(adminPool, { slug })))
    } else {
      const r = await recoverLoginMethods(adminPool, { slug, operator, enable, disable, platformLogin: platformLogin as 'on' | 'off' | undefined, connection, ssoRequired: ssoRequired as 'on' | 'off' | undefined })
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

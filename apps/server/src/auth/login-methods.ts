import { resolveEntitlements } from '@wikistead/entitlements'
import type { TenantDb } from '../db/index.js'
import { loadPlatformOidc, loadSocialLogin, type TenantOidcConfig } from './oidc.js'

// #537 / ADR-195: the ONE place that answers "which login methods does this tenant offer right now?".
// Two layers: the deployment env is a CEILING (`LOGIN_METHODS`), the tenant's own configuration selects
// within it; the effective set is their intersection, computed at READ time (a lowered ceiling never
// rewrites tenant rows — raise it back and the old selection returns). Every login entry point — start,
// CALLBACK (B3: the state TTL would otherwise leave a 5-minute completion window), signup (B4), SAML
// start/ACS — consults this module; a method that is not in the effective set answers the SAME 404 as a
// tenant that does not exist ('not found', §7's unified body). "Not in the UI" is never the gate.
//
// Invariant (B8): the resolver PRESERVES the tenant-oidc / platform distinction (`viaTenantOidc`) — the
// CE first-admin bootstrap keys on it, and a resolver refactor that collapses the two is the documented
// way to break bootstrap. Social is NOT a method here (ruling 3): it is a hint on the platform issuer,
// silently dropped when unavailable (ADR-121's existing contract).

export type LoginMethod = 'tenant-oidc' | 'platform-oidc' | 'saml'
const ALL_METHODS: readonly LoginMethod[] = ['tenant-oidc', 'platform-oidc', 'saml']

// The deployment ceiling. Unset = everything (the CE default: no new config required). Tokens are
// validated; an env that names ONLY unknown tokens is a configuration error, not an empty product —
// fail fast at boot (assertLoginCeilingValid) instead of serving mysterious 404s (B8: the ceiling must
// not become a silent lockout).
export function loginMethodCeiling(env: string | undefined = process.env.LOGIN_METHODS): Set<LoginMethod> {
  if (env === undefined || env.trim() === '') return new Set(ALL_METHODS)
  const tokens = env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const valid = tokens.filter((t): t is LoginMethod => (ALL_METHODS as readonly string[]).includes(t))
  return new Set(valid)
}

export function assertLoginCeilingValid(env: string | undefined = process.env.LOGIN_METHODS): void {
  if (loginMethodCeiling(env).size === 0) {
    throw new Error(
      `LOGIN_METHODS="${env}" resolves to NO login method — every login would 404 and no admin could ever fix it from inside. ` +
      `Valid tokens: ${ALL_METHODS.join(', ')} (unset = all).`,
    )
  }
}

// The tenant's own IdP row (RLS-scoped; the caller owns decryption via oidc.ts loaders where needed).
async function tenantOidcEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc LIMIT 1`
  return !!row?.enabled
}

// #537 Slice 3 / ruling 4: the tenant's stance on the DEPLOYMENT's shared IdP (migration 087).
// Absent row = platform login on (the historical default). Fail-open on read error would re-open a
// door the tenant closed, so this one fails CLOSED the other way: an error keeps platform login ON
// (the safe default for "can anyone still sign in") and logs — the toggle is an SSO-enforcement
// convenience, not a security boundary (the tenant's OWN IdP gate is).
async function platformLoginDisabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ platform_login_disabled: boolean }[]>`SELECT platform_login_disabled FROM tenant_login_prefs LIMIT 1`.catch((err: unknown) => {
    console.warn('[login-methods] tenant_login_prefs read failed; keeping platform login on:', err)
    return [] as { platform_login_disabled: boolean }[]
  })
  return !!row?.platform_login_disabled
}

async function tenantSamlEnabled(db: TenantDb): Promise<boolean> {
  // The table exists in every deployment (migration 038); the EE code that USES it lives in ee-server.
  // Reading the flag here is data access, not an EE feature — the entitlement gate below still applies.
  const [row] = await db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml LIMIT 1`.catch((err: unknown) => {
    // Fail-closed (saml drops out of the set) — but say so, per B8's "no mysterious 404s" rule.
    console.warn('[login-methods] tenant_saml read failed; treating saml as unavailable:', err)
    return [] as { enabled: boolean }[]
  })
  return !!row?.enabled
}

export interface AvailableLogin {
  methods: Set<LoginMethod>
  // The OIDC pick for /auth/login — tenant IdP wins over platform (ADR-016 order, unchanged).
  // null when neither OIDC method is effective (SAML may still be).
  oidc: { cfg: TenantOidcConfig; viaTenantOidc: boolean } | null
}

// `loadTenantOidcCfg` is injected by the caller (auth.ts owns secret decryption) so this module stays
// free of crypto concerns; it is only called when tenant-oidc is inside the ceiling AND enabled.
export async function resolveAvailableLogin(
  db: TenantDb,
  tenant: { plan: string },
  loadTenantOidcCfg: (db: TenantDb) => Promise<TenantOidcConfig | null>,
  env?: string | undefined,
): Promise<AvailableLogin> {
  const ceiling = loginMethodCeiling(env)
  const methods = new Set<LoginMethod>()

  let tenantCfg: TenantOidcConfig | null = null
  if (ceiling.has('tenant-oidc') && (await tenantOidcEnabled(db))) {
    tenantCfg = await loadTenantOidcCfg(db)
    if (tenantCfg) methods.add('tenant-oidc')
  }
  // Ruling 4: the tenant may have turned the platform IdP off (SSO enforcement) — read the pref
  // only when the ceiling and deployment config would otherwise make it effective (lazy).
  let platform = ceiling.has('platform-oidc') ? loadPlatformOidc() : null
  if (platform && (await platformLoginDisabled(db))) platform = null
  if (platform) methods.add('platform-oidc')
  if (ceiling.has('saml') && resolveEntitlements(tenant.plan).samlSso && (await tenantSamlEnabled(db))) {
    methods.add('saml')
  }

  const oidc = tenantCfg
    ? { cfg: tenantCfg, viaTenantOidc: true }
    : platform
      ? { cfg: platform, viaTenantOidc: false }
      : null
  return { methods, oidc }
}

// #537 lockout guard: "would anything OTHER than `except` still let someone in?" — asked before a
// write that disables one method. Refusing the transition to an empty effective set is the guard; an
// ALREADY-empty set is not made worse by a write, so only the transition is refused (the admin's
// live cookie session is the recovery path, per the module header of tenant-oidc.ts).
//
// Two honest limits (design-review, Slice 1):
// - TOCTOU: this read and the caller's write are not one transaction, and the sibling method can be
//   disabled through its own route concurrently — two simultaneous disables can still empty the set.
//   The guard is a seatbelt against the common accident, not a serializable invariant; break-glass
//   (Slice 4) is the recovery for the race.
// - The predicates mirror the resolver's ENABLED checks, not the full login reality (a stored-but-
//   undecryptable tenant IdP cfg, a corrupt SAML cert): a "remaining" method can still be broken.
//   That gap is §4's documented one — the guard prevents intentional lockout, not misconfiguration.
export async function otherLoginMethodsEffective(
  db: TenantDb,
  tenant: { plan: string },
  except: LoginMethod,
  env?: string | undefined,
): Promise<boolean> {
  const ceiling = loginMethodCeiling(env)
  if (except !== 'platform-oidc' && ceiling.has('platform-oidc') && loadPlatformOidc() && !(await platformLoginDisabled(db))) return true
  if (except !== 'saml' && ceiling.has('saml') && resolveEntitlements(tenant.plan).samlSso && (await tenantSamlEnabled(db))) return true
  if (except !== 'tenant-oidc' && ceiling.has('tenant-oidc') && (await tenantOidcEnabled(db))) return true
  return false
}

// Social slugs for the login screen: only on the platform issuer path (ADR-121), and only when
// platform-oidc is effective — a ceiling that drops platform-oidc drops the buttons with it.
export function socialProvidersFor(available: AvailableLogin): string[] {
  return available.methods.has('platform-oidc') && (!available.oidc || !available.oidc.viaTenantOidc)
    ? loadSocialLogin().providers
    : []
}

// The admin toggle's write path (upsert). Ruling 4's guard lives in the route (it needs the whole
// availability picture); this is just the persistence.
export async function setPlatformLoginDisabled(db: TenantDb, tenantId: string, disabled: boolean): Promise<void> {
  await db.sql`
    INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled)
    VALUES (${tenantId}, ${disabled})
    ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = ${disabled}, updated_at = now()
  `
}

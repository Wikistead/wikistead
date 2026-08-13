import { samlEntitled } from './saml-entitlement.js'
import type { TenantDb } from '../db/index.js'
import { loadPlatformOidc, type TenantOidcConfig } from './oidc.js'

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

// #568 / ADR-198 §3 M8: `local` is a CONNECTION like any other — same ceiling vocabulary, same
// effective-set arithmetic, same "you cannot disable your only way back in" guard. Password sign-in
// that lived outside this module would be a second way in that the lockout guard cannot see.
export type LoginMethod = 'tenant-oidc' | 'platform-oidc' | 'saml' | 'local'
const ALL_METHODS: readonly LoginMethod[] = ['tenant-oidc', 'platform-oidc', 'saml', 'local']

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

// The tenant's own IdP rows (RLS-scoped; the caller owns decryption via oidc.ts loaders where
// needed). S2 review N6: ANY enabled connection counts — first-row-only diverged from the
// connection list once N≥2, and on the platform-lapse side that divergence failed OPEN (a
// first-row-disabled tenant with a live second connection had its SSO enforcement lapse).
async function tenantOidcEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc WHERE enabled LIMIT 1`
  return !!row?.enabled
}

// #537 Slice 3 / ruling 4: the tenant's stance on the DEPLOYMENT's shared IdP (migration 087).
// Absent row = platform login on (the historical default). Fail-open on read error would re-open a
// door the tenant closed, so this one fails CLOSED the other way: an error keeps platform login ON
// (the safe default for "can anyone still sign in") and logs — the toggle is an SSO-enforcement
// convenience, not a security boundary (the tenant's OWN IdP gate is).
// Only the missing-table case (a server running ahead of migration 087) is tolerated — anything
// else THROWS so a real failure surfaces as a 500 instead of silently un-enforcing SSO
// (design-review Slice 3, finding 2: a broad catch here was fail-open on the security-relevant side).
// #568 / ADR-198 §3: does this tenant offer password sign-in? Unlike every other method this one has
// no configuration row of its own, so the answer lives with the other stance a tenant takes about a
// method it does not configure (migration 087/106). Absent row = OFF: acquiring a password door
// because a migration ran is not a decision anyone made. Same missing-table tolerance as the platform
// pref (a server running ahead of its migration), and anything else throws rather than quietly
// answering "off" — a read failure must not look like a tenant's choice.
export async function localLoginEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ local_login_enabled: boolean }[]>`SELECT local_login_enabled FROM tenant_login_prefs LIMIT 1`.catch((err: unknown) => {
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '42703') return [] as { local_login_enabled: boolean }[]
    throw err
  })
  return !!row?.local_login_enabled
}

async function platformLoginDisabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ platform_login_disabled: boolean }[]>`SELECT platform_login_disabled FROM tenant_login_prefs LIMIT 1`.catch((err: unknown) => {
    if ((err as { code?: string }).code === '42P01') return [] as { platform_login_disabled: boolean }[] // undefined_table
    throw err
  })
  return !!row?.platform_login_disabled
}

async function tenantSamlEnabled(db: TenantDb): Promise<boolean> {
  // The table exists in every deployment (migration 038); the EE code that USES it lives in ee-server.
  // Reading the flag here is data access, not an EE feature — the entitlement gate below still applies.
  // Same catch discipline as the prefs read: missing-table only; real failures surface.
  const [row] = await db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml LIMIT 1`.catch((err: unknown) => {
    if ((err as { code?: string }).code === '42P01') return [] as { enabled: boolean }[] // undefined_table
    throw err
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
  // saml is decided BEFORE platform: the platform pref below conditions on "any own IdP effective",
  // and saml is an own IdP.
  // #693 entitlement answered by the REGISTERED predicate (CE default false) — a CE build
  // must not count a door with no bytes behind it, whatever data was imported.
  if (ceiling.has('saml') && samlEntitled(tenant) && (await tenantSamlEnabled(db))) {
    methods.add('saml')
  }
  // #568 / ADR-198 §3 M8 + §9: local is an OWN way in (no external IdP involved) and carries no
  // entitlement gate — the ruling is that edition never decides which authentication methods exist.
  // It is decided before platform for the same reason saml is: it counts toward ownIdpEffective.
  if (ceiling.has('local') && (await localLoginEnabled(db))) methods.add('local')
  // Ruling 4: the tenant may have turned the platform IdP off (SSO enforcement). The pref is a
  // CONDITIONAL, re-evaluated at read time exactly like the rest of the effective set: it bites only
  // WHILE an own IdP (tenant-oidc or saml, above) is effective. When that stops being true — plan
  // downgrade drops samlSso, the IdP row goes away — platform login LAPSES BACK OPEN instead of
  // leaving the tenant with an empty set (design-review Slice 3, finding 1: the write-time-only
  // check made an entitlement downgrade a brand-new full-lockout path). The stored intent is kept;
  // restore the own IdP and the enforcement resumes. The admin panel shows the lapse as platform
  // being effective again.
  const ownIdpEffective = methods.size > 0
  let platform = ceiling.has('platform-oidc') ? loadPlatformOidc() : null
  if (platform && ownIdpEffective && (await platformLoginDisabled(db))) platform = null
  // #605 / ADR-210 §1: while the STANCE bites, the effective set is intersected with the federated
  // pair — every other row keeps its selection (nothing stored changes; the admin surface says why).
  // The stance is decided by its own predicate (sso-stance.ts, §R5-2) and SUPERSEDES the platform
  // preference while on: one door, one stored reason.
  const { resolveSsoStance } = await import('./sso-stance.js')
  if ((await resolveSsoStance(db, tenant, env)).biting) {
    methods.delete('local')
    platform = null
  }
  if (platform) methods.add('platform-oidc')

  const oidc = tenantCfg
    ? { cfg: tenantCfg, viaTenantOidc: true }
    : platform
      ? { cfg: platform, viaTenantOidc: false }
      : null
  return { methods, oidc }
}

// #554 S1 / ADR-197 §2: the ordered effective CONNECTION list — ceiling ∩ enabled ∩ entitlement,
// computed at read time like everything else in this module. S1 ships the resolver; the login
// screen and start/callback keep consuming resolveAvailableLogin until S2/S3 wire them here, so
// N=1 behavior stays byte-identical while the vessel widens. `label`/`brand` stay null until S3
// (rev3 narrowed labels) and S4 (presets) fill them. The platform connection is env-injected (no
// row), listed under the fixed id 'platform' — it can never collide with a minted uuid, and S3
// owns whatever surfaces it publicly. The platform-lapse rule (ADR-195 ruling 4) carries over:
// the tenant's platform-off pref bites only while an own-IdP connection is effective.
//
// KNOWN drift vs resolveAvailableLogin, to reconcile when S3 makes this the consumed truth
// (S1 review finding 3; (a) first-row-vs-any-enabled was RESOLVED in the S2 review — both sides
// now count any enabled row, and the legacy pick is the first ENABLED row): (b) remains —
// resolveAvailableLogin drops a connection whose secret fails to DECRYPT (loadTenantOidcCfg
// throws/null) while this lists it — S3 must not render a button the start route cannot honor.
export interface LoginConnection {
  id: string
  kind: 'oidc' | 'saml' | 'platform' | 'local'
  label: string | null
  brand: string | null
  // #554 S6 / ADR-197 §6: whether this connection's asserted groups claim is persisted. SERVER-
  // INTERNAL — login-options projects {id, kind, label, brand} explicitly, so this never publishes.
  // The platform connection is trusted (the deployment operator's own IdP — today's behavior).
  trustGroups: boolean
  // #554 S4 / ADR-197 §5: non-null on connections that MINT namespaced member subs
  // (wc<conn8>_<externalSub>). NULL on the legacy connection (raw subs), platform and SAML.
  subjectPrefix: string | null
}

export async function resolveLoginConnections(
  db: TenantDb,
  tenant: { plan: string },
  env?: string | undefined,
): Promise<LoginConnection[]> {
  const ceiling = loginMethodCeiling(env)
  const out: LoginConnection[] = []
  if (ceiling.has('tenant-oidc')) {
    const rows = await db.sql<{ id: string; trust_groups: boolean; subject_prefix: string | null; label: string | null; preset: string | null }[]>`
      SELECT id, trust_groups, subject_prefix, label, preset FROM tenant_oidc WHERE enabled ORDER BY sort, id`
    // rev3 labels: a tenant-authored label publishes ONLY preset-less (a preset connection wears
    // its fixed brand; the API refuses labels on presets, this is the second seatbelt)
    for (const r of rows) out.push({ id: r.id, kind: 'oidc', label: r.preset ? null : r.label, brand: r.preset, trustGroups: r.trust_groups, subjectPrefix: r.subject_prefix })
  }
  if (ceiling.has('saml') && samlEntitled(tenant)) {
    // one per tenant in v1 (ADR-197 §1 B5); SAML never bootstraps (§2 rev2: oidc-only in v1)
    const [row] = await db.sql<{ id: string; trust_groups: boolean }[]>`SELECT id, trust_groups FROM tenant_saml WHERE enabled LIMIT 1`.catch((err: unknown) => {
      if ((err as { code?: string }).code === '42P01') return [] as { id: string; trust_groups: boolean }[]
      throw err
    })
    if (row) out.push({ id: row.id, kind: 'saml', label: null, brand: null, trustGroups: row.trust_groups, subjectPrefix: null })
  }
  // #568: local is a connection with no configuration to point at — a fixed id, like platform, which
  // cannot collide with a minted uuid. It never bootstraps an admin (§7 keeps that on the CLI) and
  // asserts no groups, so it trusts none.
  if (ceiling.has('local') && (await localLoginEnabled(db))) {
    out.push({ id: 'local', kind: 'local', label: null, brand: null, trustGroups: false, subjectPrefix: null })
  }
  const ownIdpEffective = out.length > 0
  let platform = ceiling.has('platform-oidc') ? loadPlatformOidc() : null
  if (platform && ownIdpEffective && (await platformLoginDisabled(db))) platform = null
  // #605 / ADR-210 §1: the stance filters this list the same way (one decision point, sso-stance.ts).
  const { resolveSsoStance } = await import('./sso-stance.js')
  if ((await resolveSsoStance(db, tenant, env)).biting) {
    const keep = out.filter((c) => c.kind === 'oidc' || c.kind === 'saml')
    out.length = 0
    out.push(...keep)
    platform = null
  }
  if (platform) out.push({ id: 'platform', kind: 'platform', label: null, brand: null, trustGroups: true, subjectPrefix: null })
  return out
}

// #554 S4 review F2/F3: the per-connection lockout guard, SHARED by the connections surface and
// the legacy /admin/oidc card so the same operation cannot get opposite answers. It honors the
// ADR-195 ruling-4 platform LAPSE: when the write would remove the last own-IdP connection, a
// configured, in-ceiling platform IdP is still a way back in — the pref lapses open the moment no
// own IdP is effective, so the write is allowed. Honest limit (F11, the #537 guard's own caveat):
// read-then-write without a lock — two concurrent disables of different connections can still
// empty the set; break-glass is the recovery.
export async function assertNotLastWayIn(
  db: TenantDb,
  tenant: { id: string; plan: string },
  exceptId: string,
  env?: string | undefined,
): Promise<void> {
  const effective = await resolveLoginConnections(db, tenant, env)
  if (!effective.some((c) => c.id === exceptId)) return // not effective now — the guard steps aside
  // #605 / ADR-210 §R5-1: the guard evaluates the COUNTERFACTUAL — the world AFTER this write — not
  // the present. With the stance on, one SSO connection and local selected on, the stance-filtered
  // list is [that connection]; asking "is anything else effective NOW" would refuse the very write
  // that lapses the stance and re-opens the password door (a brand-new 409 this feature would have
  // invented). So the remainder is re-derived with the row already dropped: if the stance would no
  // longer bite, the doors it was masking come back into the count.
  const { resolveSsoStance } = await import('./sso-stance.js')
  const stanceAfter = await resolveSsoStance(db, tenant, env, { exceptConnectionId: exceptId })
  let remaining = effective.filter((c) => c.id !== exceptId)
  if (!stanceAfter.biting) {
    // the stance lapses after this write — count the doors it was hiding (local; platform is handled
    // by the ruling-4 lapse below, exactly as today)
    if (loginMethodCeiling(env).has('local') && (await localLoginEnabled(db)) && !remaining.some((c) => c.kind === 'local')) {
      remaining = [...remaining, { id: 'local', kind: 'local', label: null, brand: null, trustGroups: false, subjectPrefix: null }]
    }
  }
  if (remaining.length > 0) return
  if (loginMethodCeiling(env).has('platform-oidc') && loadPlatformOidc()) return // the lapse (ruling 4)
  throw Object.assign(
    new Error('this is the last effective way to sign in. Enable another connection first, or have an operator run `pnpm tenant:login-methods`.'),
    { statusCode: 409, code: 'login_lockout' },
  )
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
  // The platform pref is deliberately NOT consulted here: it is a conditional that lapses the moment
  // no own IdP is effective (see resolveAvailableLogin), so a configured, in-ceiling platform IdP is
  // ALWAYS a way back in — either directly, or by lapse once the disable being guarded goes through.
  if (except !== 'platform-oidc' && ceiling.has('platform-oidc') && loadPlatformOidc()) return true
  if (except !== 'saml' && ceiling.has('saml') && samlEntitled(tenant) && (await tenantSamlEnabled(db))) return true
  if (except !== 'tenant-oidc' && ceiling.has('tenant-oidc') && (await tenantOidcEnabled(db))) return true
  return false
}

// #554 S3 / ADR-197 §3: socialProvidersFor is RETIRED (named in the ADR so the seam does not
// linger half-alive). Social slugs now ride the platform CONNECTION's presence in the
// login-options list — the "tenant OIDC wins → hide social" rule died with the N-up screen.

// The admin toggle's write path (upsert). Ruling 4's guard lives in the route (it needs the whole
// availability picture); this is just the persistence.
export async function setPlatformLoginDisabled(db: TenantDb, tenantId: string, disabled: boolean): Promise<void> {
  await db.sql`
    INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled)
    VALUES (${tenantId}, ${disabled})
    ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = ${disabled}, updated_at = now()
  `
}

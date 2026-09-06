import { samlEntitled } from './saml-entitlement.js'
import type { TenantDb } from '../db/index.js'
import { loadPlatformOidc, type TenantOidcConfig } from './oidc.js'
import { RESERVED_SUB_RE } from './reserved-subs.js'

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
/**
 * ADR-251 / #822: the doors somebody can actually walk through after a write — not the doors that
 * are SELECTED.
 *
 * THE DEFECT the two older guards share. `otherLoginMethodsEffective` asks which METHODS are
 * configured and never looks at `local` at all, so a workspace using SAML and passwords cannot turn
 * SAML off: it is told to enable another method first, and another method is already enabled.
 * `assertNotLastWayIn` does count the password door, but only as a preference — a tenant where every
 * administrator signs in through the IdP and nobody holds a password satisfies it, and closing the
 * last federated door there leaves a workspace nobody can administer. ⚠️ Ruled 2026-08-21: a door
 * being SELECTED is not a way in; the last live way in may only be closed with a key-holding
 * administrator confirmed to exist, and an explicit confirmation.
 *
 * So the classification is:
 *
 *   `local`      usable ONLY when an active tenant administrator holds a password. Selected but
 *                key-less, it is not a way in and is dropped.
 *   federated    `unknown`. The product cannot enumerate who an external IdP will admit; claiming to
 *   platform     have verified them would be a lie, and refusing them would strand every SSO-only
 *                tenant. They count, exactly as today.
 *
 * ⚠️ The ruling-4 lapse is IN the list, not beside it. Kept as a separate arm, "nothing is left" can
 * be judged before or after key-less `local` rows are dropped, and the two orders disagree: judged
 * after, a write is waved through by an arm reasoning from what is CONFIGURED while the list it
 * describes is empty. What is configured and what is usable are never the same fact.
 *
 * ⚠️ Stated limit: an administrator who holds `admin` through a GROUP is not counted (ADR-207 puts
 * that in `role_assignments`; this reads `members.role`). The direction is safe — it can only refuse
 * a write it need not have — and the `last_direct_admin` floor keeps one directly granted
 * administrator, so it cannot produce a lockout. Named here rather than found later.
 */
export type WayIn = { id: string; kind: string; usable: 'yes' | 'unknown' }

/**
 * ⚠️ The shapes a closing write can take, written in ONE place so two halves of an implementation
 * cannot invent different ones.
 *
 * Changing the question from "is the password door selected" to "does an administrator hold a key"
 * means writes that take the KEY away can close the last way in without touching a login-method
 * screen at all. `demoting` is its own shape rather than a reuse of `deactivating`, even though both
 * remove the same person from the key-holding set, because the two refusals are different sentences —
 * a suspension says they would be the last way in, a demotion says they are the only administrator
 * who can get back in. One shape would force one wording onto both screens, and a refusal that reads
 * like a bug gets removed in good faith.
 */
export type Closing =
  | { id: string; live: boolean }   // a connection row
  | { credentialOf: string }        // this member's password entrance is going away
  | { deactivating: string }        // this member is being suspended or removed
  | { demoting: string }            // this member stops being an administrator

export async function waysInAfter(
  db: TenantDb,
  tenant: { id: string; plan: string },
  closing: Closing,
  env?: string | undefined,
): Promise<WayIn[]> {
  // The key-taking shapes do not close a connection: every door stays exactly as it was, and what
  // changes is whether `local` still has a key behind it. So the list is derived unchanged and only
  // the `local` classification is asked with that person removed.
  if (!('id' in closing)) {
    // ⚠️ All three key-taking shapes reduce to the SAME exclusion: the person stops counting as an
    // administrator who holds a key — by losing the key (`credentialOf`), by losing the account
    // (`deactivating`), or by losing the adminship (`demoting`). They stay three shapes because the
    // three REFUSALS are different sentences, not because the counterfactual differs.
    const excluded = 'credentialOf' in closing ? closing.credentialOf : 'deactivating' in closing ? closing.deactivating : closing.demoting
    const effective = await resolveLoginConnections(db, tenant, env)
    const out: WayIn[] = []
    for (const c of effective) {
      if (c.kind !== 'local') { out.push({ id: c.id, kind: c.kind, usable: 'unknown' }); continue }
      if (await anAdminHoldsAKey(db, { without: excluded })) {
        out.push({ id: c.id, kind: c.kind, usable: 'yes' })
      }
    }
    // #925 / ADR-251 §3.8b: under a biting stance, `resolveLoginConnections` correctly strips `local`
    // from the list above (it is not a door for ordinary members) — but an EXEMPT admin whose password
    // door is actually open is still a real way back in, and with `local` gone from `effective` no
    // entry above can ever be marked `'local'`, so none can ever be marked `'yes'`. Ask both halves
    // directly, the way admin-login-methods.ts's own exemption check does, rather than through a door
    // this stance has already stripped from view. All three conjuncts, matching resolveLoginConnections
    // §212/§321's own three (a lowered ceiling does not rewrite the tenant's stored preference row, so
    // two conjuncts alone still answer 'yes' for a door LOGIN_METHODS itself has 404ing).
    const { resolveSsoStance } = await import('./sso-stance.js')
    if ((await resolveSsoStance(db, tenant, env)).biting
      && loginMethodCeiling(env).has('local')
      && (await localLoginEnabled(db))
      && (await anAdminHoldsAKey(db, { exemptOnly: true, without: excluded }))) {
      out.push({ id: 'sso-exemption', kind: 'local', usable: 'yes' })
    }
    return out
  }
  const effective = await resolveLoginConnections(db, tenant, env)
  // The caller says whether the id it is closing is live NOW. `live: false` means the write closes a
  // door that was already shut, which takes nothing away — the same step-aside the older guard makes.
  if (!closing.live) return effective.map((c) => ({ id: c.id, kind: c.kind, usable: c.kind === 'local' ? 'yes' : 'unknown' }))

  const { resolveSsoStance } = await import('./sso-stance.js')
  const stanceAfter = await resolveSsoStance(db, tenant, env, { exceptConnectionId: closing.id })
  let remaining = effective.filter((c) => c.id !== closing.id)
  if (!stanceAfter.biting && loginMethodCeiling(env).has('local') && (await localLoginEnabled(db)) && !remaining.some((c) => c.kind === 'local')) {
    remaining = [...remaining, { id: 'local', kind: 'local', label: null, brand: null, trustGroups: false, subjectPrefix: null }]
  }
  // The lapse, folded in: when it would open the platform door, that door IS a member of the list.
  // ⚠️ The CONNECTION kind is `platform`; `platform-oidc` is the METHOD name the ceiling speaks. The
  // typechecker caught the mix-up, which is the same two-vocabularies-for-one-thing this ADR is about.
  if (!remaining.some((c) => c.kind === 'platform') && loginMethodCeiling(env).has('platform-oidc') && loadPlatformOidc()) {
    remaining = [...remaining, { id: 'platform', kind: 'platform', label: null, brand: null, trustGroups: false, subjectPrefix: null }]
  }

  const out: WayIn[] = []
  for (const c of remaining) {
    if (c.kind !== 'local') { out.push({ id: c.id, kind: c.kind, usable: 'unknown' }); continue }
    if (await anAdminHoldsAKey(db)) out.push({ id: c.id, kind: c.kind, usable: 'yes' })
    // else: selected but key-less — not a way in, dropped.
  }
  return out
}

/**
 * Does an active tenant administrator hold a password?
 *
 * ⚠️ This is the question the ruling turned the guard into, and it is NOT what `isLastAdmin` asks —
 * that one counts `role` and `deactivated_at` and never joins the credential table. Migration 109
 * dropped the `wlocal_` restriction, so an IdP-derived administrator can hold one too.
 *
 * ⚠️ A passkey-only administrator is NOT counted (ruled 2026-08-21, deliberately for now). The
 * direction is over-refusal, which is the safe side.
 */
/**
 * The SSO-exemption floor's refusals, in one place.
 *
 * FOUR writes can reach this floor — turning the requirement on, deselecting passwords, revoking an
 * exemption, and deleting a credential — and this family's whole history is one copy being edited:
 * #836 narrowed one of three and left the other two loose, #898 found them, and the fourth copy had
 * meanwhile drifted a clause. Aligning the strings by hand would split again on the next edit, so the
 * sentences live here and every site reads one.
 *
 * ⚠️ Every one of them says ADMINISTRATOR, deliberately. `anAdminHoldsAKey` asks whether an exempt
 * ADMIN holds a password; a refusal that says "member" tells the operator to exempt an ordinary one,
 * which walks them straight back into the state this floor exists to prevent — people who can sign in
 * during an outage and nobody among them who can fix anything.
 */
export const SSO_FLOOR_REFUSAL = {
  /** Turning the requirement ON, and deleting the last exempt admin's credential. */
  needAnExemptAdmin:
    'name at least one exempt ADMINISTRATOR who holds a password (and keep password sign-in selected) before requiring SSO — they are the way back in, and the one who can fix things, when the IdP is down.',
  /** Deselecting password sign-in while the requirement is on. */
  passwordsAreWhatMakesItSafe:
    'SSO is required for this workspace, and an exempt ADMINISTRATOR holding a password is what makes that safe. Turn the SSO requirement off before deselecting passwords.',
  /** Revoking the exemption that is holding the floor up. */
  lastExemptAdmin:
    'this is the last exempt ADMINISTRATOR holding a password — exempt another administrator who has one, or turn the SSO requirement off. ' +
    'If nobody else can sign in, an operator can create a new administrator at a fresh address and give each stranded member a password entrance (ADR-259 §3.5a).',
} as const

export async function anAdminHoldsAKey(
  db: TenantDb,
  opts: { without?: string; exemptOnly?: boolean } = {},
): Promise<boolean> {
  // `without` asks the counterfactual the key-taking writes need: would an administrator still hold a
  // key once THIS person no longer does. It is the only counterfactual: a demotion, a suspension and a
  // revoked password all remove the same person from the same set, and an earlier draft carried a
  // second flag for the demotion that no query ever read.
  // ⚠️ `exemptOnly` narrows the SAME question to the SSO exemption list (#836): when the IdP is down,
  // is there an administrator who can both get in AND fix things. A narrowing of this predicate
  // rather than a second one, because a rule written twice is how this family keeps ending up with
  // one copy edited — which is exactly why the two older guards disagreed.
  const excluded = opts.without ?? null
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM members m
      JOIN local_credentials c ON c.member_sub = m.sub
      ${opts.exemptOnly ? db.sql`JOIN sso_exemptions se ON se.member_sub = m.sub` : db.sql``}
     WHERE m.role = 'admin' AND m.deactivated_at IS NULL
       AND (${excluded}::text IS NULL OR m.sub <> ${excluded})`
  return (row?.n ?? 0) > 0
}

/**
 * ADR-251 §3.8a. RULED 2026-08-27 (#925): a key-taking write that would empty the SSO-exempt
 * floor is WARNED, not refused outright — `waysInAfter`'s ordinary `confirm_required` shape, not a
 * hard throw. Asked FIRST, ahead of `assertClosingIsSafe`, on all four key-taking writes.
 *
 * Narrow deliberately: it fires only when the target IS one of the currently-exempt admins, removing
 * them would leave none, and the floor was not already broken (the transition check, mirroring
 * `assertClosingIsSafe`'s own `closing.live` step-aside) — a write that does not touch the exempt
 * floor at all falls through to `assertClosingIsSafe` exactly as before.
 *
 * `.selected`, not `.biting`: `biting` can go false with no write at all (a federated connection
 * disabled, or its secret failing to decrypt) and come back true just as silently when restored — a
 * floor keyed on it would stop protecting during that window. `.selected` has no such window, and it
 * is what the exemption-revoke door this mirrors (`admin-login-methods.ts`) already reads.
 */
/**
 * Returns `true` when the floor WOULD have refused and `confirm` let it through — ADR-251 §3.8c
 * (option C): a machine caller is always `confirm: true`, and this is how `suspendMember` learns
 * whether that auto-confirm actually crossed the floor (and so owes the audit ledger an entry naming
 * it), rather than duplicating this predicate's own logic at the call site.
 */
export async function assertNotLastExemptAdmin(
  db: TenantDb,
  tenant: { plan: string },
  sub: string,
  confirm: boolean,
): Promise<boolean> {
  const { resolveSsoStance, isSsoExempt } = await import('./sso-stance.js')
  const stance = await resolveSsoStance(db, tenant)
  if (!stance.selected) return false
  if (!(await isSsoExempt(db, sub))) return false // this write's target isn't exempt — not this floor's business
  if (await anAdminHoldsAKey(db, { exemptOnly: true, without: sub })) return false // another exempt admin still holds a key
  if (!(await anAdminHoldsAKey(db, { exemptOnly: true }))) return false // TRANSITION: the floor was ALREADY down — refusing takes nothing back
  if (confirm) return true // RULED: warned, and they chose to go on (or, for SCIM, auto-confirmed — the caller logs it)
  // #925 / ADR-251 §3.8a/§7-8: `floor: 'sso_exempt'` distinguishes this refusal from
  // `assertClosingIsSafe`'s own `confirm_required` (which carries `remainingKind` instead) — the two
  // can now fire on the same write and are not the same sentence (#866 shipped, #963 had to un-ship,
  // the shape this field exists to stop recurring). A caller that reads only `code` collapses them.
  throw Object.assign(new Error(SSO_FLOOR_REFUSAL.lastExemptAdmin), { statusCode: 409, code: 'confirm_required', floor: 'sso_exempt' })
}

/**
 * ADR-251 §3.2: the three answers a door-closing write can get.
 *
 *   two or more ways in, or one that is `yes`   allow — today's behaviour
 *   nothing at all                              409 `login_lockout`
 *   exactly one, and it is `unknown`            409 `confirm_required`, until the caller repeats
 *                                               itself with `confirm`
 *
 * ⚠️ The confirmation is scoped to the RULING'S case and no wider. An earlier draft asked for it
 * whenever nothing remaining was provably usable — and because `yes` can only come from `local`, that
 * would have asked an SSO-only tenant to confirm every ordinary connection tidy-up, three doors
 * remaining or not. The ruling says "closing the last living way in", so the trigger is literally
 * that: one door left, and the product cannot promise it works.
 *
 * ⚠️ Read on the TRANSITION, not the post-state — the callers carry that difference themselves
 * (`b.enabled === false && row.enabled`, the SAML guard's enabled→disabled check, and this function's
 * own step-aside through `closing.live`). Two rules would be a defect; there is one.
 */
/**
 * Returns `true` when the "one unverifiable door left" refusal WOULD have fired and `opts.confirm`
 * let it through — ADR-251 §3.8c (option C): a machine caller is always `confirm: true`, and this is
 * how `suspendMember` learns whether that auto-confirm actually crossed the floor (owing the audit
 * ledger an entry naming it), rather than duplicating this predicate's own logic at the call site.
 * `login_lockout` (nothing left at all) always throws regardless of `confirm` — there is no "warn and
 * proceed" for a write with no remedy behind it, so it carries no return value to report.
 */
export async function assertClosingIsSafe(
  db: TenantDb,
  tenant: { id: string; plan: string },
  closing: Closing,
  opts: { confirm?: boolean; env?: string | undefined } = {},
): Promise<boolean> {
  const remaining = await waysInAfter(db, tenant, closing, opts.env)
  // ⚠️ Read on the TRANSITION, not the post-state. Every guard in this area is written that way, and
  // for the door-closing shapes the callers carry the difference themselves (`b.enabled === false &&
  // row.enabled`, and this function's own step-aside through `closing.live`). The key-taking shapes
  // have no such caller-side transition, so it is taken here: a write that leaves the set exactly as
  // empty as it found it takes nothing away, and refusing it is a 409 with no remedy behind it —
  // there is no door to enable that would make the demotion legal. Measured: without this, a tenant
  // with nothing configured refused every role change.
  if (remaining.length === 0 && !('id' in closing)) {
    const before = await waysInAfter(db, tenant, { id: '', live: false }, opts.env)
    if (before.length === 0) return false
  }
  if (remaining.length === 0) {
    throw Object.assign(
      new Error('this is the last effective way to sign in. Enable another connection first, or have an operator run `pnpm tenant:login-methods`.'),
      { statusCode: 409, code: 'login_lockout' },
    )
  }
  if (remaining.length > 1 || remaining[0]!.usable === 'yes') return false
  if (opts.confirm) return true
  throw Object.assign(
    new Error('this would leave one way in, and it cannot be verified from here. Confirm to continue.'),
    { statusCode: 409, code: 'confirm_required', remainingKind: remaining[0]!.kind },
  )
}

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

// #858 / #949, ADR-259 §3.9: the per-MEMBER question `DELETE /members/:sub/password-setup` asks —
// distinct from `anAdminHoldsAKey` and `assertNotLastWayIn` above, which are both WORKSPACE questions
// (can ANYBODY still get in). `identity_source === 'local'` used to stand in for "this is their only
// door", and a link breaks that proxy in both directions: a `local` member who has since linked a
// provider has two ways in and was refused for nothing; a member whose connection was deleted has none
// and was let through. #822 is the shape this family keeps repeating — a proxy read where the real
// question should be asked.
//
// Excludes the password credential itself: the caller already found it (it is what this route is
// about to remove), so this asks only "is there something ELSE" — a link, or a mint-derived entrance.
//
//   a LINK             member_identities, any connection (ADR-259 §3.1 — written by #947 / #960)
//   a MINT-DERIVED      this sub's prefix still names a connection that is still effective, or —
//   entrance            transitionally, for a sub with no recognisable prefix — a legacy tenant-oidc
//                       connection (predates #554, subjectPrefix null) or the platform connection is
//                       still effective and would still admit a raw external subject
//
// `wlocal_` (the local-invite mint) asserts neither: it names no connection, and its only entrance is
// the credential already excluded above — so it falls through both checks to `false` without a special
// case, the same way a deleted connection's `wc…_` prefix does.
//
// #960 reuses this same predicate for the OTHER door-closing write that can strand a member — deleting
// a connection takes its links and its mint-derived entrance with it — via `excludeConnectionId`: the
// counterfactual "as if this connection (and any link through it) were already gone", asked BEFORE it
// actually is. Reused rather than copied, because a second copy of this question is exactly the shape
// #822 keeps repeating (three guards, one question, answered differently).
// #1064 / ADR-259 §3.10 (review, revise pass on the first cut of #1064): the single-
// connection half of the predicate below — "does THIS ONE connection admit THIS sub" — as opposed to
// "does ANY connection in the effective set admit it". A caller asking about one specific connection
// (the unlink route, auth.ts) must NOT substitute "is this connection in the tenant's effective set at
// all" for this — a connection can be perfectly effective for the TENANT (enabled, in plan) while
// admitting a completely different member's sub (a second door added on top of a DIFFERENT origin,
// the ordinary case §3.3 exists for) and not this one at all.
export function connectionAdmitsSubject(conn: LoginConnection, sub: string): boolean {
  const prefix = RESERVED_SUB_RE.exec(sub)?.[0] ?? null
  return prefix ? conn.subjectPrefix === prefix : conn.subjectPrefix === null && (conn.kind === 'oidc' || conn.kind === 'platform')
}

// Pure half of the mint-derived check, split out so a caller holding an already-resolved `effective`
// list (one `resolveLoginConnections` call) can ask it for many subs — see `subsWithAnotherWayIn`.
function subjectHasMintDerivedEntrance(sub: string, effective: readonly LoginConnection[]): boolean {
  return effective.some((c) => connectionAdmitsSubject(c, sub))
}

// #1163 / ADR-283 §2: the three exclusion shapes are mutually exclusive by construction, not by
// convention — `?: never` on each arm's siblings makes passing two of them (e.g. `excludeLinkOnly` AND
// `excludeLinkId`) a TypeScript error rather than a silently-collapsing `??` preference. A plain
// optional-fields object would NOT enforce this (excess-property checking only rejects a literal
// matching none of the union's members, not one that happens to satisfy more than one).
type MemberHasAnotherWayInOpts =
  | { env?: string | undefined; excludeConnectionId: string; excludeLinkOnly?: never; excludeLinkId?: never }
  | { env?: string | undefined; excludeLinkOnly: string; excludeConnectionId?: never; excludeLinkId?: never }
  // #1163 / ADR-283 §2: row-scoped exclusion — the admin route deletes exactly ONE link (§1's
  // `unlinkMemberIdentityById`), not every row for a connection (self-service's `excludeLinkOnly`
  // shape). A sibling link to the SAME connection must still count as another way in.
  | { env?: string | undefined; excludeLinkId: string; excludeConnectionId?: never; excludeLinkOnly?: never }
  | { env?: string | undefined; excludeConnectionId?: never; excludeLinkOnly?: never; excludeLinkId?: never }

export async function memberHasAnotherWayIn(
  db: TenantDb,
  tenant: { id: string; plan: string },
  sub: string,
  // `excludeConnectionId` is #960's shape: the CONNECTION is going away, so it drops out of both the
  // link check and the mint-derived check below. `excludeLinkOnly` is #1045's — unlinking removes only
  // the STORED LINK; the connection itself (and whatever it would mint on the member's next sign-in)
  // is untouched, so it must stay in the mint-derived half. Passing both for the same id would be a
  // caller bug (the connection can't be simultaneously "gone" and "still there to mint from") — kept as
  // two names rather than one so a caller cannot reach for the wrong one by accident.
  opts: MemberHasAnotherWayInOpts = {},
): Promise<boolean> {
  const excludeConnection = opts.excludeConnectionId ?? opts.excludeLinkOnly
  const [link] = await db.sql<{ id: string }[]>`
    SELECT id FROM member_identities WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}
      ${excludeConnection ? db.sql`AND connection_id <> ${excludeConnection}` : opts.excludeLinkId ? db.sql`AND id <> ${opts.excludeLinkId}` : db.sql``}
    LIMIT 1`
  if (link) return true

  const effective = (await resolveLoginConnections(db, tenant, opts.env))
    .filter((c) => c.id !== opts.excludeConnectionId)
  return subjectHasMintDerivedEntrance(sub, effective)
}

// #949 review the members LIST needs this same answer for every row on the page, and a
// naive per-row `memberHasAnotherWayIn` call would re-run `resolveLoginConnections` — a TENANT-WIDE
// computation, not a per-member one — once per row. One linked-set query (batched with `= ANY`) and one
// `resolveLoginConnections` call, no matter how many subs are asked about.
export async function subsWithAnotherWayIn(
  db: TenantDb,
  tenant: { id: string; plan: string },
  subs: readonly string[],
  opts: { env?: string | undefined } = {},
): Promise<Set<string>> {
  if (subs.length === 0) return new Set()
  const linked = await db.sql<{ member_sub: string }[]>`
    SELECT DISTINCT member_sub FROM member_identities WHERE tenant_id = ${tenant.id} AND member_sub = ANY(${subs})`
  const out = new Set(linked.map((r) => r.member_sub))
  const remaining = subs.filter((s) => !out.has(s))
  if (remaining.length > 0) {
    const effective = await resolveLoginConnections(db, tenant, opts.env)
    for (const sub of remaining) if (subjectHasMintDerivedEntrance(sub, effective)) out.add(sub)
  }
  return out
}

// #858 / #960, ADR-259 §3.5's second half: which members a connection's deletion would touch at all —
// the candidate set `memberHasAnotherWayIn`'s counterfactual is checked against. Two ways a member is
// touched: a stored LINK through this connection (ADR-259 §3.1), or a sub whose prefix this connection
// mints (the mint-derived entrance §3.9 reads). A member touched neither way is not this connection's
// business, so the caller never has to run the (per-member) counterfactual query against everybody.
export async function membersReachableThroughConnection(
  db: TenantDb,
  tenant: { id: string; plan: string },
  connectionId: string,
): Promise<string[]> {
  const [conn] = await db.sql<{ subject_prefix: string | null }[]>`
    SELECT subject_prefix FROM tenant_oidc WHERE id = ${connectionId}`
  const linked = await db.sql<{ member_sub: string }[]>`
    SELECT DISTINCT member_sub FROM member_identities WHERE tenant_id = ${tenant.id} AND connection_id = ${connectionId}`
  const minted = conn?.subject_prefix
    ? await db.sql<{ sub: string }[]>`
        SELECT sub FROM members WHERE tenant_id = ${tenant.id} AND sub LIKE ${conn.subject_prefix + '%'}`
    : []
  return [...new Set([...linked.map((r) => r.member_sub), ...minted.map((r) => r.sub)])]
}

// #858 / #960, ADR-259 §3.5: "a member left with no link and no credential has just lost their last
// way in" — asked BEFORE the connection is deleted, in ADR-251's vocabulary (`confirm_required`, not a
// hard refusal, because a rule that always refuses gives an SSO-only tenant a connection it can never
// remove). Returns the subs that would be stranded; an empty array means the delete needs no confirm.
export async function membersStrandedByConnectionDeletion(
  db: TenantDb,
  tenant: { id: string; plan: string },
  connectionId: string,
  env?: string | undefined,
): Promise<string[]> {
  const candidates = await membersReachableThroughConnection(db, tenant, connectionId)
  const stranded: string[] = []
  for (const sub of candidates) {
    const [cred] = await db.sql<{ member_sub: string }[]>`
      SELECT member_sub FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${sub}`
    if (cred) continue
    if (!(await memberHasAnotherWayIn(db, tenant, sub, { env, excludeConnectionId: connectionId }))) stranded.push(sub)
  }
  return stranded
}

// #537's kind-level lockout guard is RETIRED (#822 / ADR-251 §3.4 — named here so the seam does not
// linger half-alive). It asked which METHODS were configured and had no `local` branch at all, so a
// workspace on SAML plus passwords was told to enable another method before disabling SAML while
// another method was already enabled. Every door-closing write asks `assertClosingIsSafe` now, which
// asks about ways somebody can walk THROUGH. Leaving a "does not count the password door" predicate
// in the module is how the next feature picks it up.

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

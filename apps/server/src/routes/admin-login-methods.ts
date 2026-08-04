import type { FastifyInstance } from 'fastify'
import { requireTenantAdmin, requireConnectionManager, isTenantAdmin } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { loginMethodCeiling, setPlatformLoginDisabled } from '../auth/login-methods.js'
import { federatedWayInCount, resolveSsoStance } from '../auth/sso-stance.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { loadPlatformOidc } from '../auth/oidc.js'
import { resolveLogin } from './auth.js'

// #537 / ADR-195 Slice 3: the admin's view of "which ways in exist", and the ONE tenant-level switch
// that has no per-IdP home — platform login (the deployment's shared IdP). tenant#admin gated.
//
// The GET is a display model, not an authz source: per method it separates WHY something is off —
// `inCeiling` (deployment policy; §1: shown as unavailable-by-policy, never silently off),
// `configured`/`selected` (the tenant's own state) and `effective` (what login actually offers,
// straight from the same resolver every login entry point uses).
//
// Ruling 4 (SSO enforcement): platform login may be turned OFF only while the tenant's OWN IdP
// (OIDC or SAML) is EFFECTIVE — enabled AND verified AND loadable, the resolver's own bar, which is
// deliberately stronger than the row's enabled flag. Refusal is 409 `own_idp_required`; together
// with the per-IdP disable guards (409 login_lockout) this keeps the effective set non-empty.
export interface LoginMethodState {
  inCeiling: boolean
  configured: boolean
  selected: boolean
  effective: boolean
}
export interface LoginMethodsView {
  methods: {
    'tenant-oidc': LoginMethodState
    'platform-oidc': LoginMethodState & { blockedByStance?: boolean }
    saml: LoginMethodState & { entitled: boolean }
    // #568 / ADR-198 §3: password sign-in. `configured` is always true — there is nothing to
    // configure — so the tenant's switch IS both the configuration and the selection.
    local: LoginMethodState & { blockedByStance?: boolean }
  }
  // #605 / ADR-210 §1: the STANCE. `selected` is the stored intent; `biting` says whether it is
  // closing doors right now (selected && a federated way in is real); selected && !biting is the
  // LAPSE, which the screen must show as such (ADR-195 §1: never silently off, never silently open).
  ssoRequired: { selected: boolean; biting: boolean }
  // #604-B: may the CALLER change the stance / platform / password selections and manage the
  // SSO exemptions? Those writes stayed on the admin tier while the read opened to
  // `manage_connections`, so the screen has to be told which of its controls belong to it.
  canManageStance: boolean
}

export async function adminLoginMethodsPlugin(app: FastifyInstance) {
  app.get('/admin/login-methods', async (req): Promise<LoginMethodsView> => {
    // #604-B (item 3): the READ opens to `manage_connections`. This is the minimum the sign-in
    // methods screen needs to stand up — without it a connection manager could edit connections
    // through the API and still be shown a broken page, which is what the review found.
    //
    // The WRITE line is deliberately UNCHANGED (still tier): the PATCH below carries the stance and
    // the platform/password selections, i.e. WHO CAN GET IN AT ALL and the break-glass exemptions
    // (#605). Handing "manage the sign-in methods" should not hand "close every other door and
    // decide who is exempt" — that is a lockout decision, and #573 is what it costs when it is
    // wrong. So the verb reads the screen and edits the CONNECTIONS (admin-connections, already
    // verb-gated); the tier keeps the stance. `canManageStance` below is that same line, answered
    // by the server so the client does not have to infer it.
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    const ceiling = loginMethodCeiling()
    const available = await resolveLogin(req.db, req.tenant)
    const [oidcRow] = await req.db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc ORDER BY sort, id LIMIT 1`
    const [samlRow] = await req.db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml LIMIT 1`.catch(() => [] as { enabled: boolean }[])
    // ZERO error tolerance here on purpose (§R5-6): an operated surface must fail loudly against a
    // half-migrated schema rather than render "no stance" and invite a double write.
    const [pref] = await req.db.sql<{ platform_login_disabled: boolean; local_login_enabled: boolean; sso_required: boolean }[]>`SELECT platform_login_disabled, local_login_enabled, sso_required FROM tenant_login_prefs LIMIT 1`
    const stance = await resolveSsoStance(req.db, req.tenant)
    return {
      // The stance/selection writes are tier-gated (see the note on the gate above). The screen asks
      // the server rather than guessing from a tier flag it happens to hold.
      canManageStance: await isTenantAdmin(app.fga, req.user.sub, req.tenant.id),
      ssoRequired: { selected: !!pref?.sso_required, biting: stance.biting },
      methods: {
        'tenant-oidc': {
          inCeiling: ceiling.has('tenant-oidc'),
          configured: oidcRow != null,
          selected: !!oidcRow?.enabled,
          effective: available.methods.has('tenant-oidc'),
        },
        'platform-oidc': {
          inCeiling: ceiling.has('platform-oidc'),
          configured: !!loadPlatformOidc(),
          selected: !pref?.platform_login_disabled, // absent row = on (the historical default)
          effective: available.methods.has('platform-oidc'),
          // §1: while the stance bites it SUPERSEDES the platform preference — one door, one stated
          // reason, and the surface names which intent is the current one
          ...(stance.biting ? { blockedByStance: true } : {}),
        },
        saml: {
          inCeiling: ceiling.has('saml'),
          entitled: resolveEntitlements(req.tenant.plan).samlSso,
          configured: samlRow != null,
          selected: !!samlRow?.enabled,
          effective: available.methods.has('saml'),
        },
        local: {
          inCeiling: ceiling.has('local'),
          configured: true, // nothing to configure — see the interface note
          selected: !!pref?.local_login_enabled, // absent row = off (a password door is a decision)
          effective: available.methods.has('local'),
          // ADR-195 §1: the row keeps its selection and SAYS why it is off — never silently
          ...(stance.biting && pref?.local_login_enabled ? { blockedByStance: true } : {}),
        },
      },
    }
  })

  app.patch<{ Body: { platformLoginEnabled?: boolean; localLoginEnabled?: boolean; ssoRequired?: boolean } }>('/admin/login-methods', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    // #605 / ADR-210: the STANCE switch. ON has write-time preconditions (§R5-4, own_idp_required's
    // twin); OFF is always allowed. Audited in-tx — a deliberate DECISION, not an inheritance from the
    // platform toggle (which only emits an event): turning every other door off is an authz change.
    if (typeof req.body?.ssoRequired === 'boolean') {
      const on = req.body.ssoRequired
      if (on) {
        if ((await federatedWayInCount(req.db, req.tenant)) === 0) {
          // without this the switch is a silent trap: it does nothing at first (lapse), and the day a
          // connection is enabled two doors close with no write to the stance and no guard watching
          throw Object.assign(
            new Error('enable and verify a federated sign-in method (OIDC or SAML) before requiring SSO — otherwise the requirement would spring shut later with nobody watching.'),
            { statusCode: 409, code: 'own_idp_required' },
          )
        }
        // §5: the outage case is the whole reason for (a) — an exemption that cannot actually sign in
        // (no credential, or the password door itself off) is not break-glass
        const [exempt] = await req.db.sql<{ member_sub: string }[]>`
          SELECT se.member_sub FROM sso_exemptions se JOIN local_credentials lc ON lc.member_sub = se.member_sub LIMIT 1`
        const [pref] = await req.db.sql<{ local_login_enabled: boolean }[]>`SELECT local_login_enabled FROM tenant_login_prefs LIMIT 1`
        if (!exempt || !pref?.local_login_enabled) {
          throw Object.assign(
            new Error('name at least one exempt member who holds a password (and keep password sign-in selected) before requiring SSO — they are the way back in when the IdP is down.'),
            { statusCode: 409, code: 'sso_exemption_required' },
          )
        }
      }
      await req.db.tx(async (tx) => {
        await tx`INSERT INTO tenant_login_prefs (tenant_id, sso_required) VALUES (${req.tenant.id}, ${on})
                 ON CONFLICT (tenant_id) DO UPDATE SET sso_required = ${on}, updated_at = now()`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: on ? 'tenant.sso_required_on' : 'tenant.sso_required_off', target: `tenant:${req.tenant.id}` })
      })
      const after = await resolveLogin(req.db, req.tenant)
      emit({ type: 'tenant.login_methods_updated', tenantId: req.tenant.id, actorId: req.user.sub, platformLoginEnabled: after.methods.has('platform-oidc') })
      return reply.code(204).send()
    }
    // #568 / ADR-198 §3: local is switched here rather than beside a configuration it does not have.
    // Turning it OFF takes a way in away, so it answers to the same rule every other method does —
    // you cannot close the last door (the guard is below, shared with the platform branch).
    if (typeof req.body?.localLoginEnabled === 'boolean') {
      const on = req.body.localLoginEnabled
      if (!on) {
        const available = await resolveLogin(req.db, req.tenant)
        const others = [...available.methods].filter((m) => m !== 'local')
        if (others.length === 0) {
          throw Object.assign(
            new Error('this is the only way in — enable another sign-in method before turning passwords off.'),
            { statusCode: 409, code: 'login_lockout' },
          )
        }
      }
      await req.db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${req.tenant.id}, ${on})
                       ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}, updated_at = now()`
      // The event's payload names the PLATFORM flag (its shape predates local); report the value
      // that flag actually has now, rather than inventing one from the local write.
      const after = await resolveLogin(req.db, req.tenant)
      emit({
        type: 'tenant.login_methods_updated', tenantId: req.tenant.id, actorId: req.user.sub,
        platformLoginEnabled: after.methods.has('platform-oidc'),
      })
      return reply.code(204).send()
    }
    const enabled = req.body?.platformLoginEnabled
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'platformLoginEnabled (boolean) or localLoginEnabled (boolean) is required' })
    }
    if (!enabled) {
      // Ruling 4: only an EFFECTIVE own IdP justifies closing the shared door. Same TOCTOU honesty
      // as the other guards: this read and the write are not one transaction; break-glass recovers.
      const available = await resolveLogin(req.db, req.tenant)
      if (!available.methods.has('tenant-oidc') && !available.methods.has('saml')) {
        throw Object.assign(
          new Error('enable and verify OIDC or SAML before turning platform login off — otherwise nobody could sign in.'),
          { statusCode: 409, code: 'own_idp_required' },
        )
      }
    }
    await setPlatformLoginDisabled(req.db, req.tenant.id, !enabled)
    emit({ type: 'tenant.login_methods_updated', tenantId: req.tenant.id, actorId: req.user.sub, platformLoginEnabled: enabled })
    return reply.code(204).send()
  })

  // #605 / ADR-210 §2 (a): the EXEMPTIONS — named members who may still use the password door while
  // the stance bites. Admin-gated like the switch; every change audited in-tx (an exemption is an
  // authz fact). The listing carries `hasCredential` so the screen can say which exemptions could
  // actually sign in today (§5: the credential row is the only honest witness that a key exists).
  app.get('/admin/sso-exemptions', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const rows = await req.db.sql<{ member_sub: string; created_at: Date; has_credential: boolean }[]>`
      SELECT se.member_sub, se.created_at, (lc.member_sub IS NOT NULL) AS has_credential
      FROM sso_exemptions se LEFT JOIN local_credentials lc ON lc.member_sub = se.member_sub
      ORDER BY se.created_at`
    return rows.map((r) => ({ memberSub: r.member_sub, createdAt: r.created_at, hasCredential: r.has_credential }))
  })

  app.put<{ Params: { sub: string } }>('/admin/sso-exemptions/:sub', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    // §4: the exemption is nameable BEFORE the key exists (exempt → mint → complete), but never for a
    // stranger: the sub must be a member of THIS tenant.
    const [member] = await req.db.sql<{ sub: string }[]>`SELECT sub FROM members WHERE sub = ${req.params.sub} AND deactivated_at IS NULL`
    if (!member) return reply.code(404).send({ error: 'member not found' })
    await req.db.tx(async (tx) => {
      await tx`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${req.tenant.id}, ${req.params.sub}, ${req.user.sub})
               ON CONFLICT (tenant_id, member_sub) DO NOTHING`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'tenant.sso_exemption_granted', target: `member:${req.params.sub}` })
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { sub: string } }>('/admin/sso-exemptions/:sub', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    // §5: revoking the exemption is ENOUGH — the key stays but opens nothing. Refused only when it
    // would remove the LAST credentialed exemption while the stance is on: the same floor the ON
    // precondition set, or the switch's own requirement dies one delete later.
    const stance = await resolveSsoStance(req.db, req.tenant)
    if (stance.selected) {
      const [other] = await req.db.sql<{ member_sub: string }[]>`
        SELECT se.member_sub FROM sso_exemptions se JOIN local_credentials lc ON lc.member_sub = se.member_sub
        WHERE se.member_sub <> ${req.params.sub} LIMIT 1`
      const [self] = await req.db.sql<{ member_sub: string }[]>`
        SELECT member_sub FROM sso_exemptions WHERE member_sub = ${req.params.sub}`
      if (self && !other) {
        throw Object.assign(
          new Error('this is the last exempt member holding a password — name another exemption first, or turn the SSO requirement off.'),
          { statusCode: 409, code: 'sso_exemption_required' },
        )
      }
    }
    const gone = await req.db.tx(async (tx) => {
      const rows = await tx<{ member_sub: string }[]>`DELETE FROM sso_exemptions WHERE member_sub = ${req.params.sub} RETURNING member_sub`
      if (rows.length > 0) {
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'tenant.sso_exemption_revoked', target: `member:${req.params.sub}` })
      }
      return rows.length > 0
    })
    if (!gone) return reply.code(404).send({ error: 'not exempt' })
    return reply.code(204).send()
  })
}

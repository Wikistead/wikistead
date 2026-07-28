import type { FastifyInstance } from 'fastify'
import { requireTenantAdmin } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import { loginMethodCeiling, setPlatformLoginDisabled } from '../auth/login-methods.js'
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
    'platform-oidc': LoginMethodState
    saml: LoginMethodState & { entitled: boolean }
  }
}

export async function adminLoginMethodsPlugin(app: FastifyInstance) {
  app.get('/admin/login-methods', async (req): Promise<LoginMethodsView> => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const ceiling = loginMethodCeiling()
    const available = await resolveLogin(req.db, req.tenant)
    const [oidcRow] = await req.db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_oidc LIMIT 1`
    const [samlRow] = await req.db.sql<{ enabled: boolean }[]>`SELECT enabled FROM tenant_saml LIMIT 1`.catch(() => [] as { enabled: boolean }[])
    const [pref] = await req.db.sql<{ platform_login_disabled: boolean }[]>`SELECT platform_login_disabled FROM tenant_login_prefs LIMIT 1`
    return {
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
        },
        saml: {
          inCeiling: ceiling.has('saml'),
          entitled: resolveEntitlements(req.tenant.plan).samlSso,
          configured: samlRow != null,
          selected: !!samlRow?.enabled,
          effective: available.methods.has('saml'),
        },
      },
    }
  })

  app.patch<{ Body: { platformLoginEnabled?: boolean } }>('/admin/login-methods', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const enabled = req.body?.platformLoginEnabled
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'platformLoginEnabled (boolean) is required' })
    }
    if (!enabled) {
      // Ruling 4: only an EFFECTIVE own IdP justifies closing the shared door. Same TOCTOU honesty
      // as the other guards: this read and the write are not one transaction; break-glass recovers.
      const available = await resolveLogin(req.db, req.tenant)
      if (!available.methods.has('tenant-oidc') && !available.methods.has('saml')) {
        throw Object.assign(
          new Error('enable and verify your own identity provider (OIDC or SAML) before turning platform login off — otherwise nobody could sign in.'),
          { statusCode: 409, code: 'own_idp_required' },
        )
      }
    }
    await setPlatformLoginDisabled(req.db, req.tenant.id, !enabled)
    emit({ type: 'tenant.login_methods_updated', tenantId: req.tenant.id, actorId: req.user.sub, platformLoginEnabled: enabled })
    return reply.code(204).send()
  })
}

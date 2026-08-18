// #723 / ADR-232 §2 + §7: the SCIM tab follows the COMPOSITION, and its routes follow the plan.
//
// Two different questions, and getting them backwards was the design mistake review caught:
//   - composition (CE vs EE): a CE build has no /scim/v2 routes, so the surface must not appear at
//     all — measured here through readableAdminSurfaces, in both directions;
//   - entitlement (Business vs a lower Cloud plan): the bytes ARE there, so ADR-072 says show the
//     tab and let the route answer `scim_not_entitled` for the upgrade affordance. Hiding it would
//     route an entitlement loss down the authz channel, which that ruling forbids.
//
// The registration is toggled with the real registrar rather than a stub: module state is
// per-vitest-file, so this file's CE default does not leak into the suite that composes EE.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readableAdminSurfaces, ADMIN_SURFACES } from '../routes/admin-surfaces.js'
import { registerScim, resetScimRegistration, scimRegistered } from '../scim-sink.js'
import { fgaClient } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import type { Tenant } from '@wikistead/types'

const ADMIN = 'dev-user'
let tenant: Tenant

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))! as Tenant
}, 60_000)

afterEach(() => resetScimRegistration())
afterAll(async () => { await pool.end() }, 60_000)

describe('#723: the SCIM surface appears only where SCIM is served', () => {
  it('the registry knows the surface at all (a renamed key must not pass this file vacuously)', () => {
    expect(ADMIN_SURFACES.scim, 'the tab is admin-gated, like the other credential surfaces').toBe('admin')
  })

  it('CE default: nothing registered, so an admin is not offered the surface', async () => {
    expect(scimRegistered()).toBe(false)
    const open = await readableAdminSurfaces(fgaClient, ADMIN, tenant.id)
    expect(open, 'a CE build has no /scim/v2 routes — the tab would open onto nothing').not.toContain('scim')
    // …and the rest of the console is unaffected: this is a filter, not a fault.
    expect(open).toContain('members')
  }, 60_000)

  it('registered: the same admin IS offered it', async () => {
    registerScim()
    const open = await readableAdminSurfaces(fgaClient, ADMIN, tenant.id)
    expect(open).toContain('scim')
  }, 60_000)
})

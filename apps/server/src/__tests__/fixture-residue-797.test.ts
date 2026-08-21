// #797, the other half: a run that was KILLED must not poison the next one.
//
// The reported failure was not only "two fixtures collide". It was that one interrupted run made the
// file red FOREVER: the fixture INSERTs its row in `beforeAll` and deletes it in `afterAll`, so a
// cancelled run leaves the row, and the next `beforeAll` fails on the one-row-per-tenant constraint.
// Measured: one cancelled run, then every run after it, until the table was cleared by hand.
//
// Two things now stop that, and this file measures both rather than trusting the reasoning:
//   1. the SEQUENCE the fixtures use on the way in — clear my own tenant's row, then claim it — which
//      is only safe tenant-wide because the tenant belongs to one file, and which is what carries a
//      run started right after a killed one inside the same stack;
//   2. the tenant is outside the prune script's KEEP list, so `setup:server-test` collects the debris
//      at all — the half that was structurally impossible while the fixtures sat in a seeded tenant.
//
// That the two fixtures actually follow this is seed-tenant-fixtures-797's job (it sweeps every file
// rather than naming them); what is measured here is that the sequence survives the residue.
//
// Deliberately no seeded tenant is named anywhere here: this file bare-INSERTs a single-row-per-tenant
// table, which is exactly what seed-tenant-fixtures-797 sweeps for, and it should be judged by that
// sweep like everything else rather than exempted by name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const root = resolve(import.meta.dirname, '../../../..')
let pt: PrivateTenant

beforeAll(async () => { pt = await privateTenant(admin, 't797res') }, 60_000)
afterAll(async () => { await pt?.dispose(); await admin.end() }, 60_000)

/** What a fixture does on the way in: clear my own tenant's row, then claim it. */
async function fixtureSetup(tenantId: string, entityId: string): Promise<string> {
  await admin`DELETE FROM tenant_saml WHERE tenant_id = ${tenantId}`
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
    VALUES (gen_random_uuid()::text, ${tenantId}, ${entityId}, ${`${entityId}/sso`}, 'enc', 'https://sp.example', 'https://sp.example/acs', true)
    RETURNING id`
  return row!.id
}

describe('#797: a killed run leaves nothing that kills the next one', () => {
  it('a leftover row from an interrupted run does not stop the next setup', async () => {
    // The residue: a row a previous run inserted and never got to delete. Under a DIFFERENT
    // idp_entity_id, because the shape that was failing had the leftover written by the OTHER
    // fixture — a self-heal keyed to one's own value cannot see it.
    await admin`
      INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
      VALUES (gen_random_uuid()::text, ${pt.id}, 'https://killed-run.example', 'https://killed-run.example/sso', 'enc', 'https://sp.example', 'https://sp.example/acs', true)`

    const id = await fixtureSetup(pt.id, 'https://next-run.example')
    const rows = await admin<{ id: string; idp_entity_id: string }[]>`
      SELECT id, idp_entity_id FROM tenant_saml WHERE tenant_id = ${pt.id}`
    expect(rows.map((r) => r.id), 'the next run holds the row').toEqual([id])
    expect(rows[0]!.idp_entity_id).toBe('https://next-run.example')
  }, 60_000)

  it('and the tenant it lives in is one the prune script collects', () => {
    // If this tenant were on the KEEP list, the debris above would outlive every run — which is what
    // made an interruption permanent rather than merely annoying. Read from the script that decides.
    const src = readFileSync(resolve(root, 'infra/db/prune-test-tenants.ts'), 'utf8')
    const keep = [...(/const KEEP = \[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(keep.length, 'the prune script named no tenant it keeps — has the list moved?').toBeGreaterThan(0)
    expect(keep, 'a fixture tenant on the KEEP list is debris nothing ever collects').not.toContain(pt.id)
  })
})

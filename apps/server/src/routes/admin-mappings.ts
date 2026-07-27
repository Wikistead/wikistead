// #497 / ADR-183 §2b: the CRUD surface for "this IdP group confers TENANT ADMIN".
//
// Kept out of roles.ts on purpose. The role-mapping routes there hand out CUSTOM roles and carry a
// per-scope authority (a space manager may map a space role); admin is a built-in with no roles row, it
// is tenant-wide by definition, and there is no scope at which anyone below a tenant admin may confer
// it. Sharing a file would invite sharing a gate.
//
// A row here NEVER becomes an FGA leaf — see auth/admin-mapping.ts for why the model is untouched and
// how a member's admin is materialised and revoked instead.
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { evaluateAdminMapping } from '../auth/admin-mapping.js'

export interface AdminMappingRow {
  id: string
  group_name: string
  created_by: string
  created_at: Date
}

export async function adminMappingsPlugin(app: FastifyInstance) {
  // Tenant admin, then the customRoles entitlement — the same order and the same reasoning as the
  // role-mapping routes: DEFINING a machine-driven grant is issuance-gated, while an already-conferred
  // grant is a plain FGA tuple that keeps working after a downgrade.
  const writeGate = async (req: { user: { sub: string }; tenant: { id: string; plan: string } }) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    if (!resolveEntitlements(req.tenant.plan).customRoles) throw entitlementDenied('customRoles')
  }

  app.post<{ Body: { groupName?: string } }>('/admin/roles/admin-mappings', async (req, reply) => {
    await writeGate(req)
    const groupName = req.body?.groupName?.trim()
    if (!groupName) throw Object.assign(new Error('groupName required'), { statusCode: 400 })
    const id = randomUUID()
    await req.db.tx(async (tx) => {
      await tx`
        INSERT INTO group_admin_mappings (id, tenant_id, group_name, created_by)
        VALUES (${id}, ${req.tenant.id}, ${groupName}, ${req.user.sub})
        ON CONFLICT (tenant_id, group_name) DO NOTHING`
      await auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'role.mapping_created', target: `group:${groupName}`,
      })
    })
    // Creating a mapping does NOT retro-promote the members who already carry the group: each one is
    // materialised at their next login / SCIM group change, which is the moment we can attribute and
    // audit. Promoting a whole group here would be the same silent mass grant option (a) was rejected for.
    return reply.code(201).send({ id, groupName })
  })

  app.get('/admin/roles/admin-mappings', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const rows = await req.db.sql<AdminMappingRow[]>`
      SELECT id, group_name, created_by, created_at FROM group_admin_mappings ORDER BY created_at`
    // The materialised admins this mapping set currently accounts for — the list an operator needs to
    // answer "who did this give admin to", which is the whole reason provenance exists.
    const materialised = await req.db.sql<{ sub: string; groups: string[] | null }[]>`
      SELECT sub, groups FROM members WHERE role = 'admin' AND admin_origin = 'mapping' ORDER BY sub`
    return {
      mappings: rows.map((r) => ({ id: r.id, groupName: r.group_name, createdBy: r.created_by, createdAt: r.created_at })),
      materialisedAdmins: materialised.map((m) => ({ sub: m.sub, groups: m.groups ?? [] })),
    }
  })

  app.delete<{ Params: { mappingId: string } }>('/admin/roles/admin-mappings/:mappingId', async (req, reply) => {
    await writeGate(req)
    const [row] = await req.db.sql<AdminMappingRow[]>`
      SELECT id, group_name, created_by, created_at FROM group_admin_mappings WHERE id = ${req.params.mappingId}`
    if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 }) // RLS-scoped: another tenant's id is absent
    await req.db.tx(async (tx) => {
      await tx`DELETE FROM group_admin_mappings WHERE id = ${req.params.mappingId}`
      await auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'role.mapping_deleted', target: `group:${row.group_name}`,
      })
    })
    // Revoke NOW rather than leaving it to the drift sweep. Deleting the mapping is the operator saying
    // "this group no longer confers admin"; waiting a sweep interval for that to take effect would be a
    // revocation the UI claims has happened and the authority has not. Each member goes back through the
    // SAME evaluator the login path uses, so the manual-admin and last-admin protections apply here too.
    const affected = await req.db.sql<{ sub: string; groups: string[] | null }[]>`
      SELECT sub, groups FROM members WHERE role = 'admin' AND admin_origin = 'mapping'`
    let demoted = 0
    for (const m of affected) {
      const outcome = await evaluateAdminMapping(req.db, app.fga, req.tenant, m.sub, m.groups ?? [])
      if (outcome === 'demoted') demoted++
    }
    return reply.code(200).send({ ok: true, demoted })
  })
}

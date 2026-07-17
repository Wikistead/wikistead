// #420 / ADR-164 increment 2: custom-role DEFINITIONS (the role store CRUD).
//
// A role is a tenant-scoped NAMED bundle of atomic capabilities. FGA stays the single authz
// truth — nothing here touches a check path; a role only becomes tuples when the assignment
// write-path (increment 3) expands it. Gates on every WRITE, in the audit-viewer order:
//   1. the #383 shared tenant-admin gate,
//   2. the customRoles ENTITLEMENT (EE / Cloud top tier) via the single resolver — defining is
//      issuance-gated (a downgrade blocks new definitions; expanded grants are plain FGA tuples
//      and keep working — the apiAccess/webhooks precedent).
// Listing is tenant-admin only (no entitlement): the UI shows the uniform role picker (built-ins
// + any custom rows retained from an entitled period) on every plan.
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js'

// The ADR-164 §1 atomic vocabulary a custom role may bundle. `manage` is deliberately absent —
// it is the built-in SUPERSET (manager); a custom bundle wanting everything lists the atoms.
export const ROLE_CAPABILITIES = ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings', 'moderate'] as const
export type RoleCapability = (typeof ROLE_CAPABILITIES)[number]

// Built-in roles are VIRTUAL (reserved names, not rows) — surfaced by GET for a uniform picker,
// rejected as custom names. Their semantics stay the fixed FGA relations, not capability bundles.
const BUILT_IN_ROLES: { name: string; capabilities: string[] }[] = [
  { name: 'viewer', capabilities: ['view'] },
  { name: 'editor', capabilities: ['view', 'comment', 'edit', 'publish'] },
  { name: 'moderator', capabilities: ['moderate'] },
  { name: 'manager', capabilities: ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings'] },
]
const RESERVED_NAMES = new Set([...BUILT_IN_ROLES.map((r) => r.name), 'admin', 'owner'])

interface RoleRow { id: string; name: string; capabilities: string[]; created_at: Date; updated_at: Date }

function parseDefinition(body: { name?: unknown; capabilities?: unknown }): { name: string; capabilities: RoleCapability[] } {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 64) {
    throw Object.assign(new Error('name (1-64 chars) required'), { statusCode: 400 })
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw Object.assign(new Error('name collides with a built-in role'), { statusCode: 400 })
  }
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    throw Object.assign(new Error('capabilities (non-empty array) required'), { statusCode: 400 })
  }
  const caps = [...new Set(body.capabilities)]
  for (const c of caps) {
    if (!ROLE_CAPABILITIES.includes(c as RoleCapability)) {
      throw Object.assign(new Error(`unknown capability "${String(c)}" (allowed: ${ROLE_CAPABILITIES.join(', ')})`), { statusCode: 400 })
    }
  }
  return { name, capabilities: caps as RoleCapability[] }
}

export async function rolesPlugin(app: FastifyInstance) {
  const adminGate = async (req: { user: { sub: string }; tenant: { id: string } }) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
  }
  const writeGates = async (req: { user: { sub: string }; tenant: { id: string; plan: string } }) => {
    await adminGate(req)
    if (!resolveEntitlements(req.tenant.plan).customRoles) throw entitlementDenied('customRoles')
  }

  app.get('/admin/roles', async (req) => {
    await adminGate(req)
    const rows = await req.db.sql<RoleRow[]>`
      SELECT id, name, capabilities, created_at, updated_at FROM roles ORDER BY name`
    return {
      builtIn: BUILT_IN_ROLES,
      custom: rows.map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities })),
    }
  })

  app.post<{ Body: { name?: string; capabilities?: string[] } }>('/admin/roles', async (req, reply) => {
    await writeGates(req)
    const def = parseDefinition(req.body ?? {})
    const id = randomUUID()
    await req.db.tx(async (tx) => {
      const dup = await tx<{ id: string }[]>`SELECT id FROM roles WHERE name = ${def.name}`
      if (dup.length) throw Object.assign(new Error('a role with this name already exists'), { statusCode: 409 })
      await tx`INSERT INTO roles (id, tenant_id, name, capabilities) VALUES (${id}, ${req.tenant.id}, ${def.name}, ${def.capabilities as string[]})`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.created', target: `role:${id}` })
    })
    return reply.code(201).send({ id, name: def.name, capabilities: def.capabilities })
  })

  app.put<{ Params: { roleId: string }; Body: { name?: string; capabilities?: string[] } }>(
    '/admin/roles/:roleId', async (req) => {
      await writeGates(req)
      const def = parseDefinition(req.body ?? {})
      await req.db.tx(async (tx) => {
        const [row] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE id = ${req.params.roleId}`
        if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
        const dup = await tx<{ id: string }[]>`SELECT id FROM roles WHERE name = ${def.name} AND id != ${req.params.roleId}`
        if (dup.length) throw Object.assign(new Error('a role with this name already exists'), { statusCode: 409 })
        // NOTE (increment 4): once assignments exist, a capability change diff-re-expands every
        // assignment (Fork B1, with thetuple reference count). Increment 2 has no
        // assignment write-path, so editing a definition affects no tuples yet.
        await tx`UPDATE roles SET name = ${def.name}, capabilities = ${def.capabilities as string[]}, updated_at = now() WHERE id = ${req.params.roleId}`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.updated', target: `role:${req.params.roleId}` })
      })
      return { id: req.params.roleId, name: def.name, capabilities: def.capabilities }
    })

  app.delete<{ Params: { roleId: string } }>('/admin/roles/:roleId', async (req, reply) => {
    await writeGates(req)
    await req.db.tx(async (tx) => {
      const [row] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE id = ${req.params.roleId}`
      if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
      // Defensive: deleting a role with LIVE assignments would orphan its expanded tuples (the
      // provenance rows would cascade away while the FGA leaves stayed). The unassign-first flow
      // arrives with increment 3; until then (and after), delete requires zero assignments.
      const [{ count }] = await tx<[{ count: string }]>`
        SELECT count(*)::text AS count FROM role_assignments WHERE role_id = ${req.params.roleId}`
      if (Number(count) > 0) {
        throw Object.assign(new Error('role has live assignments — unassign first'), { statusCode: 409 })
      }
      await tx`DELETE FROM roles WHERE id = ${req.params.roleId}`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.deleted', target: `role:${req.params.roleId}` })
    })
    return reply.code(204).send()
  })
}

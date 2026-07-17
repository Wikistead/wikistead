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
import { requireTenantAdmin, writeTuples, deleteTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import { reindexPublishedPages } from './spaces.js'

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

// #420 / ADR-164 increment 3: capability → the FGA tuples an ASSIGNMENT expands to. FGA stays the
// single truth — assignment = write these fixed-relation tuples; check paths never read the tables.
// Page leaves mirror fgaRelationForCap (pages.ts); space relations mirror the member grant path
// (spaces.ts CAP_TO_RELATION + the #258 viewer/viewer_member pair). `comment` has NO space-scoped
// per-principal relation (space comment is the audience toggle), so space assignment rejects it.
const PAGE_CAP_RELATION: Record<RoleCapability, string> = {
  view: 'view_direct', comment: 'comment_direct', edit: 'edit_direct', moderate: 'moderate',
  delete: 'delete_direct', share: 'share_direct', settings: 'settings_direct', publish: 'publish_direct',
}
const SPACE_CAP_RELATIONS: Partial<Record<RoleCapability, string[]>> = {
  view: ['viewer', 'viewer_member'], // the #258 pair — same tuples the member view grant writes
  edit: ['editor_member'],
  moderate: ['moderator'],
  delete: ['deleter'], share: ['sharer'], settings: ['settings_editor'], publish: ['publisher'],
}

function expansionTuples(resourceType: 'page' | 'space', resourceId: string, principal: string, cap: RoleCapability): { user: string; relation: string; object: string }[] {
  if (resourceType === 'page') return [{ user: principal, relation: PAGE_CAP_RELATION[cap], object: `page:${resourceId}` }]
  const rels = SPACE_CAP_RELATIONS[cap]
  if (!rels) throw Object.assign(new Error(`capability "${cap}" is not assignable at space scope`), { statusCode: 400 })
  return rels.map((relation) => ({ user: principal, relation, object: `space:${resourceId}` }))
}

// The validateGrant principal rule (pages.ts): a member or a group member-set — never share_link /
// user:* / other object types (guest boundary; the FGA model backstops for the new leaves).
function validatePrincipal(principal: string): void {
  if (!/^user:[^*\s]+$/.test(principal) && !/^group:[^\s]+#member$/.test(principal)) {
    throw Object.assign(new Error('principal must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

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
        // assignment (Fork B1, with the tuple reference count). Increment 2 has no
        // assignment write-path, so editing a definition affects no tuples yet.
        await tx`UPDATE roles SET name = ${def.name}, capabilities = ${def.capabilities as string[]}, updated_at = now() WHERE id = ${req.params.roleId}`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.updated', target: `role:${req.params.roleId}` })
      })
      return { id: req.params.roleId, name: def.name, capabilities: def.capabilities }
    })

  // ---- increment 3: ASSIGNMENTS (expand a role to fixed-relation tuples; provenance rows) ----

  app.get<{ Querystring: { resourceType?: string; resourceId?: string } }>('/admin/roles/assignments', async (req) => {
    await adminGate(req)
    const { resourceType, resourceId } = req.query
    if ((resourceType !== 'page' && resourceType !== 'space') || !resourceId) {
      throw Object.assign(new Error('resourceType (page|space) and resourceId required'), { statusCode: 400 })
    }
    const rows = await req.db.sql<{ id: string; role_id: string; name: string; principal: string }[]>`
      SELECT a.id, a.role_id, r.name, a.principal FROM role_assignments a JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = ${resourceType} AND a.resource_id = ${resourceId} ORDER BY r.name, a.principal`
    return rows.map((r) => ({ id: r.id, roleId: r.role_id, roleName: r.name, principal: r.principal }))
  })

  app.post<{ Params: { roleId: string }; Body: { resourceType?: string; resourceId?: string; principal?: string } }>(
    '/admin/roles/:roleId/assignments', async (req, reply) => {
      await writeGates(req)
      const { resourceType, resourceId, principal } = req.body ?? {}
      if ((resourceType !== 'page' && resourceType !== 'space') || !resourceId || !principal) {
        throw Object.assign(new Error('resourceType (page|space), resourceId, principal required'), { statusCode: 400 })
      }
      validatePrincipal(principal)
      const [role] = await req.db.sql<RoleRow[]>`SELECT id, name, capabilities, created_at, updated_at FROM roles WHERE id = ${req.params.roleId}`
      if (!role) throw Object.assign(new Error('not found'), { statusCode: 404 })
      // Resource existence through the tenant handle (RLS) — a cross-tenant / unknown id is a uniform 404.
      const exists = resourceType === 'page'
        ? await req.db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ${resourceId} AND deleted_at IS NULL`
        : await req.db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${resourceId}`
      if (!exists.length) throw Object.assign(new Error('not found'), { statusCode: 404 })
      // Validate EVERY capability maps at this scope BEFORE any write (no partial expansion).
      const caps = role.capabilities as RoleCapability[]
      const allTuples = caps.map((c) => ({ cap: c, tuples: expansionTuples(resourceType, resourceId, principal, c) }))

      // Ownership via a PRE-READ: a capability whose tuples ALL already exist (e.g. a prior
      // direct grant) is left in place and NOT owned — unassign will never delete it. A partially
      // existing pair (legacy space view grants) gets its missing half written but stays un-owned
      // (conservative: unassign never deletes what it might not fully own — over-permission bounded
      // to the pre-existing grant the admin made deliberately).
      // Principal-scoped read (F4): an object-wide read is unpaginated and a big space's tuple set
      // overflows one page — a missed existing tuple would poison the batch write (already-exists →
      // 500). Filtering by (user, object) returns only this principal's few tuples, no paging needed.
      const { tuples: existingTuples } = await app.fga.read({ user: principal, object: `${resourceType}:${resourceId}` })
      const existing = new Set((existingTuples ?? []).map((t) => `${t.key?.relation}|${t.key?.user}`))
      const owned: RoleCapability[] = []
      const toWrite: { user: string; relation: string; object: string }[] = []
      for (const { cap, tuples } of allTuples) {
        const missing = tuples.filter((t) => !existing.has(`${t.relation}|${t.user}`))
        toWrite.push(...missing)
        if (missing.length === tuples.length) owned.push(cap)
      }

      const id = randomUUID()
      // One tx, FGA LAST (the grantPageAccess pattern / ADR-164 increment 3): a batched-write failure
      // rolls the provenance + audit + outbox back, and the single FGA Write call is atomic — no
      // partially-expanded, unrecorded tuples.
      const oid = await req.db.tx(async (tx) => {
        const dup = await tx<{ id: string }[]>`
          SELECT id FROM role_assignments WHERE role_id = ${role.id} AND resource_type = ${resourceType} AND resource_id = ${resourceId} AND principal = ${principal}`
        if (dup.length) throw Object.assign(new Error('already assigned'), { statusCode: 409 })
        await tx`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal, owned_capabilities)
                 VALUES (${id}, ${req.tenant.id}, ${role.id}, ${resourceType}, ${resourceId}, ${principal}, ${owned as string[]})`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.assigned', target: `${resourceType}:${resourceId}` })
        // Reindex so the principal appears in the stage-1 viewer set (Rider 3 denorm reads the leaves).
        const o = resourceType === 'page' ? await enqueueOutbox(tx, { tenantId: req.tenant.id, pageId: resourceId, operation: 'upsert' }) : null
        if (toWrite.length) await writeTuples(app.fga, toWrite)
        return o
      })
      if (oid) processOutboxAsync(app.searchDriver, oid, { tenantId: req.tenant.id, pageId: resourceId, operation: 'upsert' })
      // A space-scoped grant changes the viewer set of EVERY published page in the space — same
      // synchronous reindex the space grant path runs (the "revocation reindexes synchronously"
      // invariant's grant-side twin; F2).
      if (resourceType === 'space') await reindexPublishedPages(req.db, app.searchDriver, req.tenant.id, resourceId)
      return reply.code(201).send({ id, roleId: role.id, resourceType, resourceId, principal, ownedCapabilities: owned })
    })

  app.delete<{ Params: { assignmentId: string } }>('/admin/roles/assignments/:assignmentId', async (req, reply) => {
    await writeGates(req)
    interface AsgRow { id: string; role_id: string; resource_type: 'page' | 'space'; resource_id: string; principal: string; owned_capabilities: string[]; capabilities: string[] }
    // One tx, FGA LAST. All reads run INSIDE the tx with row locks (FOR UPDATE) so two concurrent
    // unassigns of co-covering assignments serialize — without the locks both would see the other as
    // a live coverer and neither would delete the shared leaf (the reference-count TOCTOU; F3).
    let resourceType = 'page' as 'page' | 'space'
    let resourceId = ''
    const oid = await req.db.tx(async (tx) => {
      const [asg] = await tx<AsgRow[]>`
        SELECT a.id, a.role_id, a.resource_type, a.resource_id, a.principal, a.owned_capabilities, r.capabilities
        FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.id = ${req.params.assignmentId} FOR UPDATE OF a`
      if (!asg) throw Object.assign(new Error('not found'), { statusCode: 404 })
      resourceType = asg.resource_type
      resourceId = asg.resource_id
      // REFERENCE COUNT: delete a leaf tuple ONLY when (a) THIS assignment owns it (it created
      // the tuple — a pre-existing direct grant is never owned) AND (b) no OTHER live assignment of
      // the same principal on the same resource still includes the capability (shared-tuple
      // protection). A kept tuple's ownership TRANSFERS to a covering assignment — otherwise
      // unassigning the owner first and the coverer second would leave the tuple orphaned forever.
      const others = await tx<{ id: string; capabilities: string[] }[]>`
        SELECT a.id, r.capabilities FROM role_assignments a JOIN roles r ON r.id = a.role_id
        WHERE a.id != ${asg.id} AND a.resource_type = ${asg.resource_type} AND a.resource_id = ${asg.resource_id} AND a.principal = ${asg.principal}
        FOR UPDATE OF a`
      const stillCovered = new Set(others.flatMap((o) => o.capabilities))
      const ownedCaps = asg.owned_capabilities as RoleCapability[]
      const toDelete = ownedCaps
        .filter((c) => !stillCovered.has(c))
        .flatMap((c) => expansionTuples(asg.resource_type, asg.resource_id, asg.principal, c))
      for (const c of ownedCaps.filter((x) => stillCovered.has(x))) {
        const heir = others.find((o) => o.capabilities.includes(c))!
        await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, ${c})
                 WHERE id = ${heir.id} AND NOT (${c} = ANY(owned_capabilities))`
      }
      await tx`DELETE FROM role_assignments WHERE id = ${asg.id}`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.unassigned', target: `${asg.resource_type}:${asg.resource_id}` })
      const o = asg.resource_type === 'page' ? await enqueueOutbox(tx, { tenantId: req.tenant.id, pageId: asg.resource_id, operation: 'upsert' }) : null
      if (toDelete.length) await deleteTuples(app.fga, toDelete)
      return o
    })
    if (oid) processOutboxAsync(app.searchDriver, oid, { tenantId: req.tenant.id, pageId: resourceId, operation: 'upsert' })
    // Space-scoped revocation reindexes synchronously (the the project design notes invariant; F2) — same call the
    // space revoke path runs.
    if (resourceType === 'space') await reindexPublishedPages(req.db, app.searchDriver, req.tenant.id, resourceId)
    return reply.code(204).send()
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

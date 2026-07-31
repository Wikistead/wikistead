// #420 / ADR-164 increment 2: custom-role DEFINITIONS (the role store CRUD).
//
// A role is a tenant-scoped NAMED bundle of atomic capabilities. FGA stays the single authz
// truth — nothing here touches a check path; a role only becomes tuples when the assignment
// write-path (increment 3) expands it. Gates on every WRITE, in the audit-viewer order
// 1. the #383 shared tenant-admin gate,
// 2. the customRoles ENTITLEMENT (EE / Cloud top tier) via the single resolver — defining is
// issuance-gated (a downgrade blocks new definitions; expanded grants are plain FGA tuples
// and keep working — the apiAccess/webhooks precedent).
// Listing is tenant-admin only (no entitlement): the UI shows the uniform role picker (built-ins
// + any custom rows retained from an entitled period) on every plan.
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient, Tuple } from '@openfga/sdk'
import { randomUUID } from 'node:crypto'
import { requireTenantAdmin, isTenantAdmin, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import { reindexPublishedPages } from './spaces.js'
import { spaceGrantTuplesFor } from '../space-grant-expansion.js' // #514 §6: the ONE capability→relation table
import { groupGrantee, groupNameByFgaId, knownGroupNames, resolveGroupName } from '../auth/group-sync.js' // #497: mappings assign the group principal; #536 names for display
import { resolveAuthorIdentities } from '../author-identity.js' // #523 / ADR-190: name user principals on the gated list
import type { TenantDb } from '../db/index.js'
import type { Sql } from 'postgres'

// The ADR-164 §1 atomic vocabulary a custom RESOURCE role may bundle. `manage` is deliberately absent
// it is the built-in SUPERSET (manager); a custom bundle wanting everything lists the atoms.
export const ROLE_CAPABILITIES = ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings', 'moderate'] as const
export type RoleCapability = (typeof ROLE_CAPABILITIES)[number]

// #445 / ADR-171: the TENANT-scope vocabulary — tenant-action capabilities (the target resource does
// not exist yet, so they cannot live on page/space). MUTUALLY EXCLUSIVE with the resource vocabulary
// a resource role cannot bundle `createSpaces`, a tenant role cannot bundle `edit` (parseDefinition
// enforces per scope). Grows later (invite members, manage templates, …).
// #485 / ADR-171 Addendum 2: the ADMIN-CLASS resource capabilities — the ones the page GRANT CEILING
// (pages.ts `ADMIN_CLASS_RELATIONS`, STRICT fork) gates behind `manage`. `manage` itself is not a
// role capability (it is the built-in superset), so the role-side set is that page set minus `manage`.
// A role assignment at PAGE scope requires the assigner's page `manage` iff the role bundles ANY of
// these — otherwise a `share`-only holder could assign a role that escalates a principal to admin class.
const ADMIN_CLASS_ROLE_CAPS = new Set<RoleCapability>(['delete', 'share', 'settings', 'publish', 'moderate'])

// #496 / ADR-181 adds `issueApiKeys` (→ the `api_key_issue` relation) as the SECOND tenant capability,
// retiring #462's api_key_issue_policy enum: who may mint an API key is now a role capability like any
// other, so authority lives in FGA alone.
export const TENANT_ROLE_CAPABILITIES = ['createSpaces', 'issueApiKeys'] as const
export type TenantRoleCapability = (typeof TENANT_ROLE_CAPABILITIES)[number]
export type AnyRoleCapability = RoleCapability | TenantRoleCapability
export type RoleScope = 'resource' | 'tenant'

// Built-in roles are VIRTUAL (reserved names, not rows) — surfaced by GET for a uniform picker,
// rejected as custom names. Their semantics stay the fixed FGA relations, not capability bundles.
const BUILT_IN_ROLES: { name: string; capabilities: string[] }[] = [
  { name: 'viewer', capabilities: ['view'] },
  // #552 (user ruling, 2026-07-30): the built-in `commenter` role #536 §6 added is GONE again — a
  // comment-only role is composed as a CUSTOM role when wanted. The `comment` CAPABILITY and its FGA
  // leaf (`space#commenter`, `comment_from_space`, …) are untouched: removing those would resurrect
  // #514's symptom (a custom role carrying `comment` refused at space scope with a 400). Only the
  // named built-in bundle and its grant-count display leave.
  { name: 'editor', capabilities: ['view', 'comment', 'edit', 'publish'] },
  { name: 'moderator', capabilities: ['moderate'] },
  { name: 'manager', capabilities: ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings'] },
]
// #552: RESERVED_NAMES derives from BUILT_IN_ROLES, so dropping `commenter` above deliberately
// FREES the name for custom roles — reserving a name no built-in carries would be a claim with no
// referent. (A tenant that wants a role called "commenter" now simply builds one.)
// #497 (088): the built-ins a group mapping may confer, and the noun each renders as (the same
// vocabulary the Members picker uses). `comment` is deliberately absent — the ruling removed
// the commenter noun from every grant surface; comment-only stays a custom-role composition.
const BUILTIN_MAPPABLE = new Set(['view', 'edit', 'moderate', 'manage'])
const BUILTIN_NOUN: Record<string, string> = { view: 'viewer', edit: 'editor', moderate: 'moderator', manage: 'manager' }
// #497 re-review N1 / ADR-199 §2 rev5: the NOUN is the unit a human picks, and `editor` means
// edit + comment (severing edit ⇒ comment left the bare capability unable to comment). The Members
// picker already grants the bundle; a GROUP MAPPING offering the same word has to mean the same
// thing, or "Engineering → editor" produces editors who cannot comment. Mirrors the web's
// COMPOSITE_BUILTINS — one table per side, same content, both pinned.
const COMPOSITE_BUILTINS: Record<string, string[]> = { edit: ['edit', 'comment'] }
export const builtinBundle = (cap: string): string[] => COMPOSITE_BUILTINS[cap] ?? [cap]
const RESERVED_NAMES = new Set([...BUILT_IN_ROLES.map((r) => r.name), 'admin', 'owner'])

interface RoleRow { id: string; name: string; capabilities: string[]; scope: RoleScope; created_at: Date; updated_at: Date }

// #420 / ADR-164 increment 3: capability → the FGA tuples an ASSIGNMENT expands to. FGA stays the
// single truth — assignment = write these fixed-relation tuples; check paths never read the tables.
// Page leaves mirror fgaRelationForCap (pages.ts); space relations mirror the member grant path
// (spaces.ts CAP_TO_RELATION + the #258 viewer/viewer_member pair). #529 / ADR-193 added the missing
// space-scoped `comment` leaf, so every capability is assignable at space scope now.
const PAGE_CAP_RELATION: Record<RoleCapability, string> = {
  view: 'view_direct', comment: 'comment_direct', edit: 'edit_direct', moderate: 'moderate',
  delete: 'delete_direct', share: 'share_direct', settings: 'settings_direct', publish: 'publish_direct',
}
// #529 / ADR-193: total now (every capability has a space leaf) — keep it a full Record so adding a
// capability without deciding its space mapping fails to compile instead of 400ing at runtime.
// #514 / ADR-188 §6: this table moved to space-grant-expansion.ts, which the BUILT-IN member grant now
// expands through as well — one table, so the assignment path and the grant path cannot disagree about
// what a capability confers (the gap between them is where the #485 bug lived). `manage` lives there too
// as a single `manager` leaf, but custom roles still cannot request it: it is not in ROLE_CAPABILITIES.

// #445 / ADR-171: tenant capability → the single tenant-relation leaf its assignment expands to.
// `space_creator` confers no page view (not in `viewable`, never in the doc-builder), so tenant
// assignments are a search-reindex NO-OP by design — the write paths must not wire one.
const TENANT_CAP_RELATION: Record<TenantRoleCapability, string> = {
  createSpaces: 'space_creator',
  issueApiKeys: 'api_key_issue', // #496 / ADR-181 — camelCase token → snake_case relation, same as above
}

// `allowSuperset` is set ONLY by the built-in grant path (#536 / ADR-188 §6 item 1). `manage` is the
// built-in superset: it is deliberately absent from ROLE_CAPABILITIES so no custom role can request it,
// and the check below is the second layer that refuses it even if a future path reaches here. Routing
// built-in grants through this mechanism means `manage` now arrives here legitimately — but only from
// that path, which is why it is a parameter rather than a row added to the vocabulary.
export function expansionTuples(resourceType: 'page' | 'space' | 'tenant', resourceId: string, principal: string, cap: AnyRoleCapability, allowSuperset = false): { user: string; relation: string; object: string }[] {
  if (resourceType === 'tenant') {
    const rel = TENANT_CAP_RELATION[cap as TenantRoleCapability]
    if (!rel) throw Object.assign(new Error(`capability "${cap}" is not assignable at tenant scope`), { statusCode: 400 })
    return [{ user: principal, relation: rel, object: `tenant:${resourceId}` }]
  }
  if (TENANT_CAP_RELATION[cap as TenantRoleCapability]) {
    throw Object.assign(new Error(`capability "${cap}" is a tenant capability — not assignable at ${resourceType} scope`), { statusCode: 400 })
  }
  if (resourceType === 'page') {
    // `manage` at page scope exists only for the built-in grant path (allowSuperset): custom roles cannot
    // request it (absent from ROLE_CAPABILITIES / PAGE_CAP_RELATION), but a direct page grant of `manage`
    // has always written the `manage_direct` leaf, and #536 review 3 routes those grants through here.
    if (cap === ('manage' as AnyRoleCapability)) {
      if (!allowSuperset) throw Object.assign(new Error(`capability "manage" is not assignable at page scope`), { statusCode: 400 })
      return [{ user: principal, relation: 'manage_direct', object: `page:${resourceId}` }]
    }
    return [{ user: principal, relation: PAGE_CAP_RELATION[cap as RoleCapability], object: `page:${resourceId}` }]
  }
  // Two-layer defence (#514 §6 review): the shared table carries `manage` because the BUILT-IN grant needs
  // it, so absence from the table no longer refuses a custom role that asks for the superset. The vocabulary
  // check in parseDefinition is the first layer and no write path bypasses it today; this is the second, so
  // a future path that reaches here with `manage` is refused rather than silently granted manager.
  if (!allowSuperset && !ROLE_CAPABILITIES.includes(cap as RoleCapability)) {
    throw Object.assign(new Error(`capability "${cap}" is not assignable at space scope`), { statusCode: 400 })
  }
  const tuples = spaceGrantTuplesFor(principal, cap, resourceId)
  if (tuples.length === 0) throw Object.assign(new Error(`capability "${cap}" is not assignable at space scope`), { statusCode: 400 })
  return tuples
}

const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 })

// #485 / ADR-171 Addendum 2: the per-scope AUTHORITY to WRITE a role ASSIGNMENT (assign / unassign).
// Replaces the flat tenant-admin gate on the assignment paths so a SPACE MANAGER can assign roles inside
// their own space, at BOTH space and page scope. The gate is the target resource's authority
// - tenant scope → tenant admin — createSpaces & co. stay closed to a global admin.
// - space scope → space `manage` (= the `manager` relation, the space SUPERSET). No per-capability
// ceiling: a manager already holds every space capability, and the base-tier space
// grant relations (sharer/deleter/…) do NOT union `manager` (model.fga:100-105), so
// the page-style `share`+ceiling would wrongly 403 a legitimate manager.
// - page scope → the page GRANT CEILING extended to the role BUNDLE: always the page `share` verb,
// plus page `manage` iff ANY bundled capability is admin-class (ADMIN_CLASS_ROLE_CAPS).
// This is `requireGrantAuthority` (pages.ts) applied to every capability at
// once — a partial grant would break the provenance/ref-count, so ANY
// over-ceiling capability rejects the WHOLE assignment.
// A TENANT ADMIN short-circuits every resource scope: they could assign anywhere before this change
// (incl. a private page, from which a space manager is correctly cut via `manage_from_space … but not
// private`), so the short-circuit preserves that non-regression. `page share` unions `manage`
// (model.fga:168), so a manager passes the page `share` check with no special case.
// #497 / ADR-183: the ASSIGN CORE, extracted so the HTTP route AND the group-mapping create path
// use ONE authz write path (the project design notes single-source). Callers do the scope/existence/authority checks
// first (a cross-tenant / unknown id must already be a uniform 404, and requireAssignmentAuthority must
// already have passed). This does the ownership pre-read + one-tx write (FGA LAST) + search reindex,
// exactly as the route did inline. `origin` labels the provenance row ('manual' | 'mapping' | 'default').
// Returns the new assignment id. Throws 409 on a duplicate (same role+resource+principal).
export async function assignRoleInTx(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  args: {
    tenant: { id: string; plan: string }; roleId: string | null; capabilities: AnyRoleCapability[];
    resourceType: 'page' | 'space' | 'tenant'; resourceId: string; principal: string;
    actorSub: string; origin?: 'manual' | 'mapping' | 'default';
    // #536 / ADR-188 §6 item 1: a BUILT-IN grant is the same mechanism with the other column set. A
    // built-in is virtual (no roles row) so it cannot be pointed at by role_id; the row carries the
    // capability instead. Set this and roleId must be null.
    builtinCapability?: string;
    // A built-in grant is idempotent — granting `view` to someone who already has it is not an error the
    // way assigning the same role twice is (the Members control offers no "already granted" state, and
    // the pre-#536 path just wrote the tuple again). 'ignore' returns the existing row's id.
    onDuplicate?: 'conflict' | 'ignore';
    // The audit action to record. Defaults to the role vocabulary; the built-in grant path keeps saying
    // `space.access_granted` so this change does not rewrite anyone's audit stream mid-flight.
    auditAction?: string;
    // The grant path is called from places that do not know the plan (no entitlement to resolve), and
    // audited nothing there before. Keep that rather than auditing under a guessed plan.
    skipAudit?: boolean;
    // #497: an optional hook run INSIDE the assign tx, right after the role_assignments INSERT, with
    // the new assignment id. The mapping-create path writes its owning group_role_mappings row here so
    // the assignment + its owning row commit ATOMICALLY (no orphaned origin='mapping' assignment on a
    // crash — the ADR-183 "one tx" invariant). A throw rolls the whole assign back.
    afterAssign?: (tx: Sql, assignmentId: string) => Promise<void>;
  },
): Promise<string> {
  const { tenant, roleId, capabilities: caps, resourceType, resourceId, principal, actorSub } = args
  const origin = args.origin ?? 'manual'
  const allTuples = caps.map((c) => ({ cap: c, tuples: expansionTuples(resourceType, resourceId, principal, c, args.builtinCapability !== undefined) }))
  // Principal-scoped read (F4): only this principal's tuples, no paging (see the route comment).
  // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
  const { tuples: existingTuples } = await fga.read({ user: principal, object: `${resourceType}:${resourceId}` })
  const existing = new Set((existingTuples ?? []).map((t: Tuple) => `${t.key?.relation}|${t.key?.user}`))
  const owned: AnyRoleCapability[] = []
  const toWrite: { user: string; relation: string; object: string }[] = []
  for (const { cap, tuples } of allTuples) {
    const missing = tuples.filter((t) => !existing.has(`${t.relation}|${t.user}`))
    toWrite.push(...missing)
    if (missing.length === tuples.length) owned.push(cap)
  }
  // #536 review finding 1 (reproduced): a BUILT-IN grant owns its capability unconditionally. The
  // presence-based rule above encodes the role semantic — "a leaf someone else already conferred is
  // not mine to delete" — which is right for a role bundling many capabilities, and wrong here: a rowless
  // tuple (a pre-086 grant, or the `manager` leaf createSpace writes for the creator) is the SAME grant,
  // untracked, not a different grantor. Deferring to it produced a row with owned = {}, and the revoke
  // then deleted the row, deleted nothing in FGA, audited, emitted the webhook, and answered success
  // on a brand-new space, via the creator path, with no legacy data at all. Shared-leaf protection on
  // revoke is the reference count's job (other ROWS), not tuple presence's.
  if (args.builtinCapability !== undefined) {
    owned.length = 0
    owned.push(...caps)
  }
  const outcome = await db.tx(async (tx) => {
    const o = await assignRoleTxCore(tx, args, { owned, toWrite })
    // FGA LAST, inside the tx, exactly as before the #553 core extraction — the composite caller
    // batches multiple arms' tuples into one write instead.
    if (o.toWrite.length) await writeTuples(fga, o.toWrite)
    return o
  })
  if (outcome.outboxId) processOutboxAsync(searchDriver, outcome.outboxId, { tenantId: tenant.id, pageId: resourceId, operation: 'upsert' })
  if (outcome.existingId) return outcome.existingId
  if (resourceType === 'space') await reindexPublishedPages(db, searchDriver, tenant.id, resourceId)
  return outcome.id!
}

// #553 / ADR-199 §2: the ONE-transaction assign body, extracted so the editor-noun composite can run
// N single-capability arms inside a single db.tx (row atomicity; the FGA tuples are collected and
// written ONCE by the caller — FGA does not roll back with the tx, so batching narrows the window
// exactly as the single-arm path always has). Byte-for-byte the former assignRoleInTx tx body, minus
// the write.
interface AssignTxOutcome { id: string | null; existingId: string | null; outboxId: string | null; toWrite: { user: string; relation: string; object: string }[] }
async function assignRoleTxCore(
  tx: Sql,
  args: {
    tenant: { id: string; plan: string }; roleId: string | null;
    resourceType: 'page' | 'space' | 'tenant'; resourceId: string; principal: string;
    actorSub: string; origin?: 'manual' | 'mapping' | 'default';
    builtinCapability?: string; onDuplicate?: 'conflict' | 'ignore'; auditAction?: string; skipAudit?: boolean;
    afterAssign?: (tx: Sql, assignmentId: string) => Promise<void>;
  },
  pre: { owned: AnyRoleCapability[]; toWrite: { user: string; relation: string; object: string }[] },
): Promise<AssignTxOutcome> {
  const { tenant, roleId, resourceType, resourceId, principal, actorSub } = args
  const origin = args.origin ?? 'manual'
  const id = randomUUID()
  const builtin = args.builtinCapability ?? null
  const dup = builtin
    ? await tx<{ id: string }[]>`
        SELECT id FROM role_assignments WHERE builtin_capability = ${builtin} AND resource_type = ${resourceType} AND resource_id = ${resourceId} AND principal = ${principal}`
    : await tx<{ id: string }[]>`
        SELECT id FROM role_assignments WHERE role_id = ${roleId} AND resource_type = ${resourceType} AND resource_id = ${resourceId} AND principal = ${principal}`
  if (dup.length) {
    // #497 re-review nit: name the capability. On a composite (the editor noun) the collision can be
    // on the arm the admin never picked — "already assigned" alone sends them looking at the wrong row.
    if (args.onDuplicate !== 'ignore') {
      throw Object.assign(new Error(builtin ? `already assigned: ${builtin}` : 'already assigned'), { statusCode: 409 })
    }
    // Idempotent: the row is already there and already owns whatever it owns. Writing the tuples again
    // would be harmless but recomputing `owned` from a stale read would not — leave the row alone.
    // The AUDIT still happens (#536 review 2): before 086 a duplicate grant audited like any other
    // successful write, and the caller's webhook still fires — an audit stream that goes quiet for a
    // subset of the events the webhook stream reports is one nobody can reconcile. The reindex is the
    // one thing legitimately skipped: nothing changed to index.
    if (!args.skipAudit) await auditIfEntitled(tx, tenant, { actor: `user:${actorSub}`, action: args.auditAction ?? 'role.assigned', target: `${resourceType}:${resourceId}` })
    return { id: null, existingId: dup[0].id, outboxId: null, toWrite: [] }
  }
  await tx`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin)
           VALUES (${id}, ${tenant.id}, ${roleId}, ${builtin}, ${resourceType}, ${resourceId}, ${principal}, ${pre.owned as string[]}, ${origin})`
  if (args.afterAssign) await args.afterAssign(tx, id)
  if (!args.skipAudit) await auditIfEntitled(tx, tenant, { actor: `user:${actorSub}`, action: args.auditAction ?? 'role.assigned', target: `${resourceType}:${resourceId}` })
  const o = resourceType === 'page' ? await enqueueOutbox(tx, { tenantId: tenant.id, pageId: resourceId, operation: 'upsert' }) : null
  return { id, existingId: null, outboxId: o, toWrite: pre.toWrite }
}

// #553 / ADR-199 §2: the editor-noun composite — N single-capability BUILT-IN grants in ONE db.tx.
// N capabilities = N rows (the rev2 lesson: a built-in row never carries more than its single
// builtin_capability); each arm keeps the unconditional built-in ownership, its own audit event
// and its own dup-idempotence (a principal already holding one arm still lands the other). Space
// scope only — the page dialog offers bare capabilities, no role noun (ADR §2).
export async function assignBuiltinCompositeInTx(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  args: {
    tenant: { id: string; plan: string }; spaceId: string; principal: string; actorSub: string;
    capabilities: string[]; auditAction?: string; skipAudit?: boolean;
    // #497 re-review N1: a GROUP MAPPING's arms are machine-managed too — same composite, different
    // origin, and the mapping row is written in the SAME tx (afterArms) so a mapping can never
    // commit owning one arm and not the other.
    origin?: 'manual' | 'mapping' | 'default';
    onDuplicate?: 'conflict' | 'ignore';
    afterArms?: (tx: Sql, ids: { cap: string; id: string }[]) => Promise<void>;
  },
): Promise<{ cap: string; id: string }[]> {
  const { tenant, spaceId, principal, actorSub } = args
  // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
  const { tuples: existingTuples } = await fga.read({ user: principal, object: `space:${spaceId}` })
  const existing = new Set((existingTuples ?? []).map((t: Tuple) => `${t.key?.relation}|${t.key?.user}`))
  const arms = args.capabilities.map((cap) => ({
    cap,
    toWrite: expansionTuples('space', spaceId, principal, cap as AnyRoleCapability, true).filter((t) => !existing.has(`${t.relation}|${t.user}`)),
  }))
  const assigned = await db.tx(async (tx) => {
    const all: { user: string; relation: string; object: string }[] = []
    const ids: { cap: string; id: string }[] = []
    for (const arm of arms) {
      const o = await assignRoleTxCore(tx, {
        tenant, roleId: null, builtinCapability: arm.cap,
        resourceType: 'space', resourceId: spaceId, principal, actorSub,
        onDuplicate: args.onDuplicate ?? 'ignore', auditAction: args.auditAction, skipAudit: args.skipAudit,
        origin: args.origin,
      }, { owned: [arm.cap as AnyRoleCapability], toWrite: arm.toWrite })
      all.push(...o.toWrite)
      ids.push({ cap: arm.cap, id: (o.id ?? o.existingId)! })
    }
    if (args.afterArms) await args.afterArms(tx, ids)
    const seen = new Set<string>()
    const deduped = all.filter((t) => { const k = `${t.relation}|${t.user}|${t.object}`; if (seen.has(k)) return false; seen.add(k); return true })
    if (deduped.length) await writeTuples(fga, deduped)
    return ids
  })
  await reindexPublishedPages(db, searchDriver, tenant.id, spaceId)
  return assigned
}

// #497 / ADR-183: the UNASSIGN CORE by assignment id, extracted for the mapping DELETE path. The
// caller has already checked authority (or, for a mapping delete, the mapping row proves ownership).
// Returns true if an assignment was deleted.
export async function unassignRoleInTx(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  args: {
    tenant: { id: string; plan: string }; assignmentId: string; actorSub: string;
    // #536: the built-in grant path revokes through here but keeps its own audit vocabulary (see the
    // matching note on assignRoleInTx).
    auditAction?: string; skipAudit?: boolean;
  },
): Promise<boolean> {
  interface AsgRow { id: string; role_id: string; resource_type: 'page' | 'space' | 'tenant'; resource_id: string; principal: string; owned_capabilities: string[]; capabilities: string[] }
  let deleted = false
  let resourceType = 'page' as 'page' | 'space' | 'tenant'
  let resourceId = ''
  const oid = await db.tx(async (tx) => {
    // #536 / ADR-188 §6 item 1: LEFT join. A built-in grant is a row with no roles entry (built-ins are
    // virtual), and an inner join would make unassign silently find nothing for it — a revoke that
    // answers success and deletes neither the row nor the tuples.
    const [asg] = await tx<AsgRow[]>`
      SELECT a.id, a.role_id, a.resource_type, a.resource_id, a.principal, a.owned_capabilities,
             COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS capabilities
      FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = ${args.assignmentId} FOR UPDATE OF a`
    if (!asg) return null
    deleted = true
    resourceType = asg.resource_type
    resourceId = asg.resource_id
    // Same LEFT join for the refcount: the capabilities a principal still holds through OTHER assignments
    // now include built-in grants. With the inner join, revoking a custom role that overlapped a built-in
    // grant deleted the shared leaves outright -- the grant was still there, and the access was not.
    const others = await tx<{ id: string; capabilities: string[] }[]>`
      SELECT a.id, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS capabilities
      FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
      WHERE a.id != ${asg.id} AND a.resource_type = ${asg.resource_type} AND a.resource_id = ${asg.resource_id} AND a.principal = ${asg.principal}
      FOR UPDATE OF a`
    const stillCovered = new Set(others.flatMap((o) => o.capabilities))
    const ownedCaps = asg.owned_capabilities as AnyRoleCapability[]
    const toDelete = ownedCaps.filter((c) => !stillCovered.has(c)).flatMap((c) => expansionTuples(asg.resource_type, asg.resource_id, asg.principal, c, asg.role_id === null))
    for (const c of ownedCaps.filter((x) => stillCovered.has(x))) {
      const heir = others.find((o) => o.capabilities.includes(c))!
      await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, ${c}) WHERE id = ${heir.id} AND NOT (${c} = ANY(owned_capabilities))`
    }
    await tx`DELETE FROM role_assignments WHERE id = ${asg.id}`
    if (!args.skipAudit) await auditIfEntitled(tx, args.tenant, { actor: `user:${args.actorSub}`, action: args.auditAction ?? 'role.unassigned', target: `${asg.resource_type}:${asg.resource_id}` })
    const o = asg.resource_type === 'page' ? await enqueueOutbox(tx, { tenantId: args.tenant.id, pageId: asg.resource_id, operation: 'upsert' }) : null
    if (toDelete.length) await deleteTuples(fga, toDelete)
    return o
  })
  if (oid) processOutboxAsync(searchDriver, oid, { tenantId: args.tenant.id, pageId: resourceId, operation: 'upsert' })
  if (deleted && resourceType === 'space') await reindexPublishedPages(db, searchDriver, args.tenant.id, resourceId)
  return deleted
}

// #497 / ADR-183 §3: the tenant DEFAULT role evaluator. A member whom NO mapping matches gets the
// tenant's `default_role_id` (a TENANT-scope custom role, origin='default'); the moment a mapping
// starts matching their groups it is removed; clearing the setting removes it. `manual` wins — the
// evaluator never creates a row where a manual/mapping one of the same role exists, and never deletes
// a row it does not own (origin='default' only). Idempotent + self-healing: it is re-run every login,
// so a transient failure corrects itself and it must never be on the login-blocking path. Runs as its
// OWN assign/unassign tx (the helpers open their own) — sequenced after the member upsert, not
// nested. Tenant scope only, so the search reindex is a genuine no-op (searchDriver is passed through
// but never dereferenced for tenant assignments).
export async function evaluateDefaultRole(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  tenant: { id: string; plan: string }, sub: string, groups: readonly string[],
): Promise<void> {
  const [settings] = await db.sql<{ default_role_id: string | null }[]>`SELECT default_role_id FROM tenant_settings WHERE tenant_id = ${tenant.id}`
  const defaultRoleId = settings?.default_role_id ?? null
  const principal = `user:${sub}`
  // A mapping "matches" when the member currently carries its group name (the same DB source the
  // orphan badge reads). Any match → the member is covered by a mapping → no default.
  const matched = groups.length > 0
    && (await db.sql`SELECT 1 FROM group_role_mappings WHERE group_name = ANY(${db.sql.array(groups as string[])}) LIMIT 1`).length > 0
  const [current] = await db.sql<{ id: string; role_id: string }[]>`
    SELECT id, role_id FROM role_assignments
    WHERE resource_type = 'tenant' AND resource_id = ${tenant.id} AND principal = ${principal} AND origin = 'default'`
  const desired = defaultRoleId && !matched ? defaultRoleId : null
  // Remove a stale default (setting cleared, a mapping now matches, or the default role changed).
  if (current && current.role_id !== desired) {
    await unassignRoleInTx(db, fga, searchDriver, { tenant, assignmentId: current.id, actorSub: sub })
  }
  if (desired && (!current || current.role_id !== desired)) {
    // manual-wins: a hand-placed (or mapping-owned) assignment of the same role blocks the default.
    const dup = await db.sql`
      SELECT 1 FROM role_assignments
      WHERE resource_type = 'tenant' AND resource_id = ${tenant.id} AND principal = ${principal} AND role_id = ${desired} AND origin <> 'default' LIMIT 1`
    if (dup.length) return
    const [role] = await db.sql<{ id: string; capabilities: string[]; scope: string }[]>`SELECT id, capabilities, scope FROM roles WHERE id = ${desired}`
    if (!role || role.scope !== 'tenant') return // the default must be a tenant-scope custom role (defensive)
    await assignRoleInTx(db, fga, searchDriver, {
      tenant, roleId: role.id, capabilities: role.capabilities as AnyRoleCapability[],
      resourceType: 'tenant', resourceId: tenant.id, principal, actorSub: sub, origin: 'default',
    })
  }
}

export async function requireAssignmentAuthority(
  fga: OpenFgaClient,
  args: { sub: string; tenantId: string; resourceType: 'page' | 'space' | 'tenant'; resourceId: string; capabilities: AnyRoleCapability[] },
): Promise<void> {
  const { sub, tenantId, resourceType, resourceId, capabilities } = args
  if (resourceType === 'tenant') { await requireTenantAdmin(fga, sub, tenantId); return }
  if (await isTenantAdmin(fga, sub, tenantId)) return // global admin keeps assigning anywhere (non-regression)
  if (resourceType === 'space') {
    if (!(await check(fga, `user:${sub}`, 'manage', { type: 'space', id: resourceId }))) throw forbidden()
    return
  }
  // page scope — the grant ceiling over the whole bundle
  if (!(await check(fga, `user:${sub}`, 'share', { type: 'page', id: resourceId }))) throw forbidden()
  if (capabilities.some((c) => ADMIN_CLASS_ROLE_CAPS.has(c as RoleCapability))) {
    if (!(await check(fga, `user:${sub}`, 'manage', { type: 'page', id: resourceId }))) throw forbidden()
  }
}

// The authority to READ (list) a resource's assignments: the target's `manage` (space manager / page
// manage), tenant → admin, tenant-admin short-circuit. Listing is a management view, so it gates on
// `manage` (not the write-side share ceiling); the endpoint answers for one resourceId, so there is no
// cross-space enumeration surface.
export async function requireListAuthority(
  fga: OpenFgaClient,
  args: { sub: string; tenantId: string; resourceType: 'page' | 'space' | 'tenant'; resourceId: string },
): Promise<void> {
  const { sub, tenantId, resourceType, resourceId } = args
  if (resourceType === 'tenant') { await requireTenantAdmin(fga, sub, tenantId); return }
  if (await isTenantAdmin(fga, sub, tenantId)) return
  if (!(await check(fga, `user:${sub}`, 'manage', { type: resourceType, id: resourceId }))) throw forbidden()
}

// The validateGrant principal rule (pages.ts): a member or a group member-set — never share_link /
// user:* / other object types (guest boundary; the FGA model backstops for the new leaves).
function validatePrincipal(principal: string): void {
  if (!/^user:[^*\s]+$/.test(principal) && !/^group:[^\s]+#member$/.test(principal)) {
    throw Object.assign(new Error('principal must be user:<sub> or group:<id>#member'), { statusCode: 400 })
  }
}

// #445 / ADR-171: scope-aware — a role's capabilities validate against ITS scope's vocabulary only
// (mutually exclusive sets: a resource role cannot bundle `createSpaces`; a tenant role cannot
// bundle `edit`). Scope is fixed at creation (PUT keeps the stored scope).
// `currentName` is the name the role ALREADY has (PUT only). Reserving a name has to stop a new role from
// taking it, but it must not brick a role that predates the reservation: #536 added `commenter` to the
// built-ins, and without this every PUT on a tenant's own pre-existing `commenter` role — even one that
// only edits capabilities — would answer 400 forever, with rename as the sole escape. Blocking the rename
// TO a reserved name is the actual rule; blocking a row from keeping the name it was legally created with
// is collateral damage from checking the two cases with one test.
function parseDefinition(body: { name?: unknown; capabilities?: unknown }, scope: RoleScope, currentName?: string): { name: string; capabilities: AnyRoleCapability[] } {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 64) {
    throw Object.assign(new Error('name (1-64 chars) required'), { statusCode: 400 })
  }
  if (RESERVED_NAMES.has(name.toLowerCase()) && name.toLowerCase() !== currentName?.toLowerCase()) {
    throw Object.assign(new Error('name collides with a built-in role'), { statusCode: 400 })
  }
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    throw Object.assign(new Error('capabilities (non-empty array) required'), { statusCode: 400 })
  }
  const vocabulary: readonly string[] = scope === 'tenant' ? TENANT_ROLE_CAPABILITIES : ROLE_CAPABILITIES
  const caps = [...new Set(body.capabilities)]
  for (const c of caps) {
    if (!vocabulary.includes(c as string)) {
      throw Object.assign(new Error(`unknown capability "${String(c)}" for a ${scope} role (allowed: ${vocabulary.join(', ')})`), { statusCode: 400 })
    }
  }
  return { name, capabilities: caps as AnyRoleCapability[] }
}

export async function rolesPlugin(app: FastifyInstance) {
  const adminGate = async (req: { user: { sub: string }; tenant: { id: string } }) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
  }
  const writeGates = async (req: { user: { sub: string }; tenant: { id: string; plan: string } }) => {
    await adminGate(req)
    if (!resolveEntitlements(req.tenant.plan).customRoles) throw entitlementDenied('customRoles')
  }
  const requireEntitlement = (req: { tenant: { plan: string } }) => {
    if (!resolveEntitlements(req.tenant.plan).customRoles) throw entitlementDenied('customRoles')
  }

  app.get('/admin/roles', async (req) => {
    await adminGate(req)
    const rows = await req.db.sql<RoleRow[]>`
      SELECT id, name, capabilities, scope, created_at, updated_at FROM roles ORDER BY name`
    return {
      builtIn: BUILT_IN_ROLES,
      custom: rows.map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities, scope: r.scope })),
    }
  })

  app.post<{ Body: { name?: string; capabilities?: string[]; scope?: string } }>('/admin/roles', async (req, reply) => {
    await writeGates(req)
    // #445 / ADR-171: scope ('resource' default | 'tenant') is fixed at creation.
    const scope = req.body?.scope ?? 'resource'
    if (scope !== 'resource' && scope !== 'tenant') {
      throw Object.assign(new Error("scope must be 'resource' or 'tenant'"), { statusCode: 400 })
    }
    const def = parseDefinition(req.body ?? {}, scope)
    const id = randomUUID()
    await req.db.tx(async (tx) => {
      const dup = await tx<{ id: string }[]>`SELECT id FROM roles WHERE name = ${def.name}`
      if (dup.length) throw Object.assign(new Error('a role with this name already exists'), { statusCode: 409 })
      await tx`INSERT INTO roles (id, tenant_id, name, capabilities, scope) VALUES (${id}, ${req.tenant.id}, ${def.name}, ${def.capabilities as string[]}, ${scope})`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.created', target: `role:${id}` })
    })
    return reply.code(201).send({ id, name: def.name, capabilities: def.capabilities, scope })
  })

  app.put<{ Params: { roleId: string }; Body: { name?: string; capabilities?: string[] } }>(
    '/admin/roles/:roleId', async (req) => {
      await writeGates(req)
      // #445: validate against the STORED scope (scope is immutable; body cannot change it) — read it
      // up front outside the tx for parse, re-read locked inside.
      const [scopeRow] = await req.db.sql<{ scope: RoleScope; name: string }[]>`SELECT scope, name FROM roles WHERE id = ${req.params.roleId}`
      if (!scopeRow) throw Object.assign(new Error('not found'), { statusCode: 404 })
      const def = parseDefinition(req.body ?? {}, scopeRow.scope, scopeRow.name)
      // #420 increment 4 (Fork B1, ruled/): a capability edit RE-EXPANDS every live
      // assignment — added capabilities are granted, removed ones revoked, LIVE. All diffing runs in
      // one tx with the assignments row-locked (the same FOR UPDATE discipline as unassign, so a
      // concurrent unassign serializes); tuple writes/deletes are batched as the tx's LAST statements
      // (FGA-last). The search reindex rides the outbox (async) per the ruling.
      interface AsgRow { id: string; resource_type: 'page' | 'space' | 'tenant'; resource_id: string; principal: string; owned_capabilities: string[] }
      const pageIds: string[] = []
      const spaceIds: string[] = []
      const outboxIds: string[] = []
      await req.db.tx(async (tx) => {
        const [row] = await tx<{ id: string; capabilities: string[] }[]>`
          SELECT id, capabilities FROM roles WHERE id = ${req.params.roleId} FOR UPDATE`
        if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
        const dup = await tx<{ id: string }[]>`SELECT id FROM roles WHERE name = ${def.name} AND id != ${req.params.roleId}`
        if (dup.length) throw Object.assign(new Error('a role with this name already exists'), { statusCode: 409 })

        const before = new Set(row.capabilities as AnyRoleCapability[])
        const after = new Set(def.capabilities)
        const added = def.capabilities.filter((c) => !before.has(c))
        const removed = (row.capabilities as AnyRoleCapability[]).filter((c) => !after.has(c))

        const toWrite: { user: string; relation: string; object: string }[] = []
        const toDelete: { user: string; relation: string; object: string }[] = []
        if (added.length || removed.length) {
          const assignments = await tx<AsgRow[]>`
            SELECT id, resource_type, resource_id, principal, owned_capabilities
            FROM role_assignments WHERE role_id = ${row.id} FOR UPDATE`
          // An ADDED capability must be expressible at EVERY assigned scope BEFORE any write (no
          // partial expansion — a space assignment cannot express `comment`).
          for (const a of assignments) for (const c of added) expansionTuples(a.resource_type, a.resource_id, a.principal, c)

          for (const a of assignments) {
            // #445: tenant assignments join NEITHER reindex list — space_creator is a search no-op.
            if (a.resource_type === 'page') pageIds.push(a.resource_id)
            else if (a.resource_type === 'space') spaceIds.push(a.resource_id)
            // ADD: principal-scoped pre-read decides ownership exactly like assign (a tuple that
            // already exists — direct grant or another role's expansion — is left and not owned).
            if (added.length) {
              // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (~15), never by tenant size.
              const { tuples: existingTuples } = await app.fga.read({ user: a.principal, object: `${a.resource_type}:${a.resource_id}` })
              const existing = new Set((existingTuples ?? []).map((t: Tuple) => `${t.key?.relation}|${t.key?.user}`))
              const ownedAdd: AnyRoleCapability[] = []
              for (const c of added) {
                const tuples = expansionTuples(a.resource_type, a.resource_id, a.principal, c)
                const missing = tuples.filter((t) => !existing.has(`${t.relation}|${t.user}`))
                toWrite.push(...missing)
                if (missing.length === tuples.length) ownedAdd.push(c)
              }
              for (const c of ownedAdd) {
                await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, ${c})
                         WHERE id = ${a.id} AND NOT (${c} = ANY(owned_capabilities))`
              }
            }
            // REMOVE: the reference count per assignment — delete an owned leaf only when no
            // OTHER assignment of this principal on this resource still covers the capability
            // (their roles keep the CURRENT capability sets; this role's removal is what we diff).
            for (const c of removed) {
              if (!a.owned_capabilities.includes(c)) continue // never owned (direct grant / other creator)
              // #536 / ADR-188 §6 item 1: LEFT join here too. A built-in grant of the same capability is a
              // coverer -- editing a custom role to drop `edit` must not delete `editor_member` from
              // someone who also holds a plain `edit` grant.
              const covering = await tx<{ id: string }[]>`
                SELECT a2.id FROM role_assignments a2 LEFT JOIN roles r2 ON r2.id = a2.role_id
                WHERE a2.id != ${a.id} AND a2.resource_type = ${a.resource_type} AND a2.resource_id = ${a.resource_id}
                  AND a2.principal = ${a.principal} AND ${c} = ANY(COALESCE(r2.capabilities, ARRAY[a2.builtin_capability]))
                FOR UPDATE OF a2`
              if (covering.length) {
                // ownership transfers to a coverer (the unassign rule — no orphaned leaf later)
                await tx`UPDATE role_assignments SET owned_capabilities = array_append(owned_capabilities, ${c})
                         WHERE id = ${covering[0]!.id} AND NOT (${c} = ANY(owned_capabilities))`
              } else {
                toDelete.push(...expansionTuples(a.resource_type, a.resource_id, a.principal, c))
              }
              await tx`UPDATE role_assignments SET owned_capabilities = array_remove(owned_capabilities, ${c}) WHERE id = ${a.id}`
            }
          }
          for (const pid of pageIds) {
            outboxIds.push(await enqueueOutbox(tx, { tenantId: req.tenant.id, pageId: pid, operation: 'upsert' }))
          }
        }

        await tx`UPDATE roles SET name = ${def.name}, capabilities = ${def.capabilities as string[]}, updated_at = now() WHERE id = ${req.params.roleId}`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.updated', target: `role:${req.params.roleId}` })
        if (toWrite.length) await writeTuples(app.fga, toWrite)
        if (toDelete.length) await deleteTuples(app.fga, toDelete)
      })
      outboxIds.forEach((oid, i) => processOutboxAsync(app.searchDriver, oid, { tenantId: req.tenant.id, pageId: pageIds[i]!, operation: 'upsert' }))
      for (const sid of new Set(spaceIds)) await reindexPublishedPages(req.db, app.searchDriver, req.tenant.id, sid)
      return { id: req.params.roleId, name: def.name, capabilities: def.capabilities }
    })

  // ---- increment 3: ASSIGNMENTS (expand a role to fixed-relation tuples; provenance rows) ----

  app.get<{ Querystring: { resourceType?: string; resourceId?: string } }>('/admin/roles/assignments', async (req) => {
    const { resourceType, resourceId } = req.query
    if ((resourceType !== 'page' && resourceType !== 'space' && resourceType !== 'tenant') || !resourceId) {
      throw Object.assign(new Error('resourceType (page|space|tenant) and resourceId required'), { statusCode: 400 })
    }
    // #445 WRITE-BIND twin on the read: a tenant listing only answers for the caller's own tenant.
    if (resourceType === 'tenant' && resourceId !== req.tenant.id) {
      throw Object.assign(new Error('not found'), { statusCode: 404 })
    }
    // #485: a space manager may list the assignments of a resource they manage (space/page); tenant
    // scope stays admin-only. No cross-space enumeration — the endpoint answers for one resourceId.
    await requireListAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType, resourceId })
    // #497 re-review N2: `managed` mirrors listSpaceAccess — a mapping-owned assignment is drawn
    // read-only-with-a-link (ADR-183 §1), so the list must SAY which rows the machine owns.
    const rows = await req.db.sql<{ id: string; role_id: string; name: string; principal: string; origin: string }[]>`
      SELECT a.id, a.role_id, r.name, a.principal, a.origin FROM role_assignments a JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = ${resourceType} AND a.resource_id = ${resourceId} ORDER BY r.name, a.principal`
    // #523 / ADR-190 (slice E): name the USER principals. This list is already authorization-bounded and
    // server-set (requireListAuthority above, one resourceId, no cross-resource enumeration), so resolving
    // `override ?? OIDC display_name` over it is the SAME precedent as the manage-gated grant list in slice
    // A — it is not an arbitrary-sub lookup, so the /members/identities oracle boundary is untouched. The
    // caller's RLS handle does the read: a cross-tenant or departed sub resolves to null and the client
    // falls back to the raw sub. Group principals are never resolved (they carry their own name).
    const userSubs = rows.filter((r) => r.principal.startsWith('user:')).map((r) => r.principal.slice(5))
    const names = userSubs.length ? await resolveAuthorIdentities(req.db, userSubs) : new Map()
    // #536 (6): a GROUP principal is a hash (groupFgaId is one-way) — resolve it back to the human
    // name server-side, the same way listSpaceAccess does (group-sync.ts stays the single id authority;
    // the client never sees a reverse table). A group that no longer appears in any member's groups
    // (renamed / emptied at the IdP) gets no groupName — the client shows its explicit orphan label and
    // the row stays revocable.
    const hasGroups = rows.some((r) => r.principal.startsWith('group:'))
    const byId = groupNameByFgaId(req.tenant.id, hasGroups ? await knownGroupNames(req.db) : [])
    return rows.map((r) => {
      const groupName = resolveGroupName(r.principal, byId)
      return {
        id: r.id, roleId: r.role_id, roleName: r.name, principal: r.principal,
        ...(r.principal.startsWith('user:') ? { displayName: names.get(r.principal.slice(5))?.displayName ?? null } : {}),
        ...(groupName ? { groupName } : {}),
        ...(r.origin === 'mapping' ? { managed: true } : {}),
      }
    })
  })

  // #485 / #514: a space MANAGER (not just a tenant admin) needs the role DEFINITION list to populate the
  // in-space assignment picker — the tenant-admin-gated GET /admin/roles is unreachable for them.
  // This is the read that lets "assign in space settings" (the #514 IA) work: gated on `manage` of the
  // space (the SAME authority the assignment write + the assignment list already use — requireListAuthority),
  // scoped to ONE space (no cross-space enumeration), READ-ONLY (no edit/create), and it returns only the
  // roles ASSIGNABLE at space/page scope — built-ins plus custom RESOURCE-scope roles. Tenant-scope roles
  // (createSpaces etc.) are deliberately excluded: they are not assignable at a resource and stay
  // admin-console-only, so a manager never learns the tenant-admin role surface here.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/assignable-roles', async (req) => {
    await requireListAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: 'space', resourceId: req.params.spaceId })
    const rows = await req.db.sql<RoleRow[]>`
      SELECT id, name, capabilities, scope FROM roles WHERE scope = 'resource' ORDER BY name`
    return {
      builtIn: BUILT_IN_ROLES,
      custom: rows.map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities, scope: r.scope })),
    }
  })

  app.post<{ Params: { roleId: string }; Body: { resourceType?: string; resourceId?: string; principal?: string; groupName?: string; replace?: boolean } }>(
    '/admin/roles/:roleId/assignments', async (req, reply) => {
      const { resourceType, resourceId, groupName } = req.body ?? {}
      // #536 a GROUP is named, never addressed. Its FGA id is a tenant-salted hash the server owns
      // (group-sync.ts: "the client never hashes"), so a caller that builds `group:<name>#member` itself
      // writes a tuple no membership points at — the assignment reports success and reaches nobody. The
      // mapping route already takes the name and derives; this one now does too, so there is one authority
      // for the id instead of one authority and one guess.
      const principal = typeof groupName === 'string' && groupName.trim()
        ? groupGrantee(req.tenant.id, groupName.trim())
        : req.body?.principal
      if ((resourceType !== 'page' && resourceType !== 'space' && resourceType !== 'tenant') || !resourceId || !principal) {
        throw Object.assign(new Error('resourceType (page|space|tenant), resourceId, and principal or groupName required'), { statusCode: 400 })
      }
      validatePrincipal(principal)
      // Entitlement (customRoles) up front — a plan gate, not an existence oracle, so it may precede the
      // resource reads (matches the original writeGates order; the entitlement anti-test pins it).
      requireEntitlement(req)
      const [role] = await req.db.sql<RoleRow[]>`SELECT id, name, capabilities, scope, created_at, updated_at FROM roles WHERE id = ${req.params.roleId}`
      if (!role) throw Object.assign(new Error('not found'), { statusCode: 404 })
      // #445: a role assigns only AT its scope — a tenant role to page/space (or vice versa) is a 400.
      if ((role.scope === 'tenant') !== (resourceType === 'tenant')) {
        throw Object.assign(new Error(`a ${role.scope} role cannot be assigned at ${resourceType} scope`), { statusCode: 400 })
      }
      // Resource existence through the tenant handle (RLS) — a cross-tenant / unknown id is a uniform 404.
      // #445 CROSS-TENANT WRITE BIND (authz-critical): FGA writes pierce RLS, so the TENANT branch must
      // bind the object to the caller's own tenant — without this a tenant admin could write
      // `tenant:<other>#space_creator` tuples into another tenant. Page/space get the equivalent bind
      // from the RLS-scoped SELECT. Uniform 404 (existence-hiding).
      if (resourceType === 'tenant') {
        if (resourceId !== req.tenant.id) throw Object.assign(new Error('not found'), { statusCode: 404 })
      } else {
        const exists = resourceType === 'page'
          ? await req.db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ${resourceId} AND deleted_at IS NULL`
          : await req.db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${resourceId}`
        if (!exists.length) throw Object.assign(new Error('not found'), { statusCode: 404 })
      }
      // Validate EVERY capability maps at this scope BEFORE any write (no partial expansion).
      const caps = role.capabilities as AnyRoleCapability[]
      // #485 / ADR-171 Addendum 2: gate on the TARGET resource's authority (space manager / page
      // grant-ceiling / tenant admin), AFTER the existence-bind (so a cross-tenant/unknown id is a
      // uniform 404, never a 403 that confirms it exists). Entitlement was already checked up front.
      await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType, resourceId, capabilities: caps })
      // #536 item 2 (space scope): ONE principal = ONE role. A machine-owned (mapping/default) row
      // refuses the manual add up front (ADR-183 §1 ownership — 409 before any write); after the new row
      // lands, the principal's OTHER manual roles (grant rows, other assignments, legacy rowless tuples)
      // are swept so a direct API double-assign converges to one role. Page/tenant scope unchanged.
      if (resourceType === 'space') {
        const { assertNoMachineSpaceRole, assertManagerReplacementConfirmed } = await import('./spaces.js')
        await assertNoMachineSpaceRole(req.db, { spaceId: resourceId, principal, keep: { roleId: role.id } })
        // #536 same wall on the custom-role door. A custom role can never bundle `manage`, so
        // assigning one to a manager is always the weaker-role case the ruling is about.
        await assertManagerReplacementConfirmed(req.db, app.fga, {
          spaceId: resourceId, principal, keepCaps: caps as string[], replace: req.body?.replace === true,
        })
      }
      // #497: the assign core is now a shared helper (the HTTP route + the mapping create path).
      const id = await assignRoleInTx(req.db, app.fga, app.searchDriver, {
        tenant: req.tenant, roleId: role.id, capabilities: caps, resourceType, resourceId, principal,
        actorSub: req.user.sub, origin: 'manual',
      })
      if (resourceType === 'space') {
        const { sweepOtherSpaceRoles } = await import('./spaces.js')
        await sweepOtherSpaceRoles(req.db, app.fga, app.searchDriver, {
          spaceId: resourceId, tenantId: req.tenant.id, userId: req.user.sub, principal,
          keep: { roleId: role.id }, keepCaps: caps as string[], plan: req.tenant.plan, replaceManage: req.body?.replace === true,
        })
      }
      // Re-read the row's owned_capabilities for the response (the helper computed them internally).
      const [saved] = await req.db.sql<{ owned_capabilities: string[] }[]>`SELECT owned_capabilities FROM role_assignments WHERE id = ${id}`
      return reply.code(201).send({ id, roleId: role.id, resourceType, resourceId, principal, ownedCapabilities: saved?.owned_capabilities ?? [] })
    })

  app.delete<{ Params: { assignmentId: string } }>('/admin/roles/assignments/:assignmentId', async (req, reply) => {
    // #485 / ADR-171 Addendum 2: unassign needs the SAME per-scope authority as assign — a space manager
    // may revoke inside their space. Entitlement up front (as on assign), then pre-read the assignment's
    // resource + role bundle on the RLS handle (a cross-tenant / unknown id is a uniform 404), then gate.
    // The mutating tx below re-reads FOR UPDATE for the ref-count discipline; the assignment's
    // resource/role are immutable, so gating on the pre-read is safe.
    requireEntitlement(req)
    const [pre] = await req.db.sql<{ resource_type: 'page' | 'space' | 'tenant'; resource_id: string; capabilities: AnyRoleCapability[]; origin: string }[]>`
      SELECT a.resource_type, a.resource_id, r.capabilities, a.origin FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.id = ${req.params.assignmentId}`
    if (!pre) throw Object.assign(new Error('not found'), { statusCode: 404 })
    // #497 re-review N2: the SAME §1 ownership the builtin branch enforces (D1) — a mapping-owned
    // assignment dies with its MAPPING, never through this route (deleting it here left the mapping
    // row pointing at nothing: access gone, console row still promising it, re-creation blocked by
    // the mapping's uniqueness). Deleting the mapping is the one real revocation.
    if (pre.origin === 'mapping') {
      throw Object.assign(new Error('managed by a group mapping — delete the mapping instead'), { statusCode: 409 })
    }
    await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: pre.resource_type, resourceId: pre.resource_id, capabilities: pre.capabilities as AnyRoleCapability[] })
    // #497: the unassign core is the shared helper (HTTP route + mapping delete).
    const gone = await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: req.params.assignmentId, actorSub: req.user.sub })
    if (!gone) throw Object.assign(new Error('not found'), { statusCode: 404 })
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

  // ---- #445 / ADR-171: DEFAULT tenant-role presets (CE — admin-gated, NO entitlement) ----
  // The member default role's `createSpaces` toggle IS the `tenant#space_creator@tenant#member`
  // grant (present = all members may create, today's default; absent = admins only via the model's
  // `or admin` arm). #471 / ADR-176: it names this tenant's MEMBERS — it used to be `user:*`, which
  // matches every user-type principal the server authenticates, not only this tenant's people. admin.createSpaces is model-hardcoded (`or admin`) — reported locked so the UI
  // never shows a toggle that cannot turn off. The object is ALWAYS the caller's own tenant (bound
  // by construction — no cross-tenant surface). Replaces the #399 §2 knob (ADR-158 superseded).
  const MEMBERS_CREATOR = (tenantId: string) => ({ user: `tenant:${tenantId}#member`, relation: 'space_creator', object: `tenant:${tenantId}` })
  // #496 / ADR-181 §2: the same member-userset tuple one relation over. Present = "all members may mint
  // an API key" (the old `members` policy); absent = admins only via the model's `or admin` (the old
  // `admins_only`). Provisioning seeds NOTHING here, so a new tenant starts admin-only.
  const MEMBERS_API_KEY_ISSUER = (tenantId: string) => ({ user: `tenant:${tenantId}#member`, relation: 'api_key_issue', object: `tenant:${tenantId}` })

  app.get('/admin/roles/tenant-defaults', async (req) => {
    await adminGate(req)
    // fga-read-ok: ONE specific subject (the tenant's member set) on ONE object — bounded by the tenant type's relation count, not by member count.
    const { tuples } = await app.fga.read({ user: `tenant:${req.tenant.id}#member`, object: `tenant:${req.tenant.id}` })
    const has = (relation: string) => (tuples ?? []).some((t: Tuple) => t.key?.relation === relation)
    return {
      member: { createSpaces: has('space_creator'), issueApiKeys: has('api_key_issue') },
      // Both are model-hardcoded for admins (`or admin`), so the UI shows them locked-on rather than a
      // toggle that cannot turn off.
      admin: { createSpaces: true, issueApiKeys: true, locked: true },
    }
  })

  app.put<{ Body: { memberCreateSpaces?: boolean; memberIssueApiKeys?: boolean } }>('/admin/roles/tenant-defaults', async (req, reply) => {
    await adminGate(req) // CE preset — deliberately NOT writeGates (no customRoles entitlement)
    // #496: the body now carries two independent member toggles. Each is optional so a caller may flip one
    // without restating the other (the UI sends only what changed); at least one must be present.
    const wantCreate = req.body?.memberCreateSpaces
    const wantIssue = req.body?.memberIssueApiKeys
    for (const v of [wantCreate, wantIssue]) {
      if (v !== undefined && typeof v !== 'boolean') return reply.code(400).send({ error: 'memberCreateSpaces / memberIssueApiKeys must be booleans' })
    }
    if (wantCreate === undefined && wantIssue === undefined) {
      return reply.code(400).send({ error: 'memberCreateSpaces or memberIssueApiKeys (boolean) required' })
    }
    // fga-read-ok: ONE specific subject (the tenant's member set) on ONE object — bounded by the tenant type's relation count, not by member count.
    const { tuples } = await app.fga.read({ user: `tenant:${req.tenant.id}#member`, object: `tenant:${req.tenant.id}` })
    const has = (relation: string) => (tuples ?? []).some((t: Tuple) => t.key?.relation === relation)
    const hadCreate = has('space_creator')
    const hadIssue = has('api_key_issue')
    await req.db.tx(async (tx) => {
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.default_preset_changed', target: `tenant:${req.tenant.id}` })
      // Idempotent flips, FGA last-in-tx (a write failure rolls the audit back).
      const add: { user: string; relation: string; object: string }[] = []
      const del: { user: string; relation: string; object: string }[] = []
      if (wantCreate === true && !hadCreate) add.push(MEMBERS_CREATOR(req.tenant.id))
      if (wantCreate === false && hadCreate) del.push(MEMBERS_CREATOR(req.tenant.id))
      if (wantIssue === true && !hadIssue) add.push(MEMBERS_API_KEY_ISSUER(req.tenant.id))
      if (wantIssue === false && hadIssue) del.push(MEMBERS_API_KEY_ISSUER(req.tenant.id))
      if (add.length) await writeTuples(app.fga, add)
      if (del.length) await deleteTuples(app.fga, del)
    })
    return {
      member: { createSpaces: wantCreate ?? hadCreate, issueApiKeys: wantIssue ?? hadIssue },
      admin: { createSpaces: true, issueApiKeys: true, locked: true },
    }
  })

  // ---- #497 / ADR-183 §3: the tenant DEFAULT role (EE — customRoles) ----
  // A TENANT-scope custom role conferred on any member no mapping matches (evaluated at login by
  // evaluateDefaultRole). NULL = today's behaviour (plain member). Setting it does NOT retro-apply to
  // every member here — each member's row is created/removed at their next login (self-healing), the
  // same freshness the #111 group sync has.
  app.get('/admin/roles/default-role', async (req) => {
    await adminGate(req)
    requireEntitlement(req)
    const [row] = await req.db.sql<{ default_role_id: string | null }[]>`SELECT default_role_id FROM tenant_settings WHERE tenant_id = ${req.tenant.id}`
    return { defaultRoleId: row?.default_role_id ?? null }
  })

  app.put<{ Body: { defaultRoleId?: string | null } }>('/admin/roles/default-role', async (req, reply) => {
    await adminGate(req)
    requireEntitlement(req)
    const roleId = req.body?.defaultRoleId ?? null
    if (roleId !== null) {
      // Must be a TENANT-scope custom role of THIS tenant (RLS SELECT → a cross-tenant/unknown id 404s;
      // a resource-scope role is a 400 — a bare role id names no resource, so only tenant scope is
      // well-defined as a default, ADR-183 §3).
      const [role] = await req.db.sql<{ scope: string }[]>`SELECT scope FROM roles WHERE id = ${roleId}`
      if (!role) throw Object.assign(new Error('not found'), { statusCode: 404 })
      if (role.scope !== 'tenant') throw Object.assign(new Error('the default role must be a tenant-scope role'), { statusCode: 400 })
    }
    await req.db.tx(async (tx) => {
      // tenant_settings always has a row per tenant, but guard with an UPSERT so a brand-new tenant
      // (no settings row yet) still records the default. Only the default_role_id column is touched.
      await tx`INSERT INTO tenant_settings (tenant_id, default_role_id) VALUES (${req.tenant.id}, ${roleId})
               ON CONFLICT (tenant_id) DO UPDATE SET default_role_id = ${roleId}`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.default_role_changed', target: `tenant:${req.tenant.id}` })
    })
    return reply.send({ defaultRoleId: roleId })
  })

  // ---- #497 / ADR-183: declarative group → role MAPPINGS (EE — customRoles entitlement) ----
  // A mapping is a ROW that OWNS a group-principal role assignment. Creating it = the existing gated
  // assign path with principal `group:<id>#member` (origin='mapping'); deleting it = the
  // ref-counted unassign. It adds NO new FGA write path — group membership already resolves LIVE at
  // check time (#111 sync). v1 maps CUSTOM roles at SPACE or TENANT scope only (built-ins are
  // virtual — no roles row — so the role lookup 404s them; page scope is out of v1). Per ADR-183 §1
  // the WRITE surface carries the SAME per-scope authority as assign (`requireAssignmentAuthority`)
  // tenant-scope mappings are admin-only; space-scope mappings are open to that space's manager (#485).

  app.post<{ Body: { groupName?: string; roleId?: string; builtinCapability?: string; resourceType?: string; resourceId?: string } }>(
    '/admin/roles/mappings', async (req, reply) => {
      // Entitlement (customRoles) up front — a plan gate, not an existence oracle (mirrors assign).
      requireEntitlement(req)
      const { groupName, roleId, builtinCapability, resourceType, resourceId } = req.body ?? {}
      if (!groupName || !groupName.trim() || (!roleId && !builtinCapability) || (roleId && builtinCapability) || (resourceType !== 'space' && resourceType !== 'tenant') || !resourceId) {
        throw Object.assign(new Error('groupName, roleId XOR builtinCapability, resourceType (space|tenant), resourceId required'), { statusCode: 400 })
      }
      // #497 (088): a mapping may name a BUILT-IN. Space scope only (the tenant built-ins — member/
      // admin — are identity tiers, not mappable roles), and `comment` is NOT in the set: the
      // ruling removed the commenter noun from every grant surface (comment-only stays a custom-role
      // composition).
      if (builtinCapability != null && (resourceType !== 'space' || !BUILTIN_MAPPABLE.has(builtinCapability))) {
        throw Object.assign(new Error('builtinCapability must be one of view|edit|moderate|manage at space scope'), { statusCode: 400 })
      }
      const [role] = roleId
        ? await req.db.sql<RoleRow[]>`SELECT id, name, capabilities, scope, created_at, updated_at FROM roles WHERE id = ${roleId}`
        : [undefined]
      if (roleId && !role) throw Object.assign(new Error('not found'), { statusCode: 404 })
      if (role && (role.scope === 'tenant') !== (resourceType === 'tenant')) {
        throw Object.assign(new Error(`a ${role.scope} role cannot be mapped at ${resourceType} scope`), { statusCode: 400 })
      }
      // Resource existence bind (RLS) — the same cross-tenant/unknown → uniform 404 as assign.
      if (resourceType === 'tenant') {
        if (resourceId !== req.tenant.id) throw Object.assign(new Error('not found'), { statusCode: 404 })
      } else {
        const exists = await req.db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${resourceId}`
        if (!exists.length) throw Object.assign(new Error('not found'), { statusCode: 404 })
      }
      const caps = (role ? role.capabilities : [builtinCapability]) as AnyRoleCapability[]
      // Per-scope authority AFTER the existence-bind (a cross-tenant/unknown id is a uniform 404, never
      // a 403 that confirms it exists) — space manager for space scope, tenant admin for tenant scope.
      await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType, resourceId, capabilities: caps })
      // The group NAME resolves to the SAME FGA id the #111 sync writes (tenant-salted hash), so the
      // mapping's assignment lands on exactly the members synced into that group.
      const principal = groupGrantee(req.tenant.id, groupName.trim())
      const id = randomUUID()
      // Create the assignment AND its owning mapping row in ONE tx (the afterAssign hook writes the
      // group_role_mappings row inside the assign tx, referencing the just-inserted assignment). A
      // duplicate group+role+resource 409s on the assignment dup-check — which mirrors the mapping's
      // own UNIQUE — so a concurrent double-create can't slip through; a mapping-row UNIQUE violation
      // rolls the whole assign back (no orphaned origin='mapping' assignment).
      // For a built-in, a pre-existing assignment for the same (group, capability, space) — e.g. a
      // DIRECT group grant from the Members tab — 409s here, exactly as a duplicate custom assign
      // does: a mapping must OWN its assignment, and one it didn't create is not its to own.
      const writeMappingRow = async (tx: Sql, asgId: string) => {
        await tx`INSERT INTO group_role_mappings (id, tenant_id, group_name, role_id, builtin_capability, resource_type, resource_id, assignment_id, created_by)
                 VALUES (${id}, ${req.tenant.id}, ${groupName.trim()}, ${role ? role.id : null}, ${role ? null : builtinCapability!}, ${resourceType}, ${resourceId}, ${asgId}, ${req.user.sub})`
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.mapping_created', target: role ? `role:${role.id}` : `role:builtin:${builtinCapability}` })
      }
      let assignmentId: string
      if (!role && builtinBundle(builtinCapability!).length > 1) {
        // #497 re-review N1 / ADR-199 §2 rev5: the NOUN is composite, so the mapping confers the whole
        // bundle — N single-capability rows, all origin='mapping', in ONE tx with the mapping row. The
        // mapping row points at the PRIMARY arm (the capability the admin picked); the siblings are
        // found by bundle on delete, so no schema grows a second foreign key.
        const ids = await assignBuiltinCompositeInTx(req.db, app.fga, app.searchDriver, {
          tenant: req.tenant, spaceId: resourceId, principal, actorSub: req.user.sub,
          capabilities: builtinBundle(builtinCapability!), origin: 'mapping', onDuplicate: 'conflict',
          afterArms: async (tx, ids) => {
            await writeMappingRow(tx, ids.find((i) => i.cap === builtinCapability)!.id)
          },
        })
        assignmentId = ids.find((i) => i.cap === builtinCapability)!.id
      } else {
        assignmentId = await assignRoleInTx(req.db, app.fga, app.searchDriver, {
          tenant: req.tenant, roleId: role ? role.id : null, builtinCapability: role ? undefined : builtinCapability,
          capabilities: caps, resourceType, resourceId, principal,
          actorSub: req.user.sub, origin: 'mapping',
          afterAssign: writeMappingRow,
        })
      }
      return reply.code(201).send({ id, groupName: groupName.trim(), roleId: role ? role.id : null, builtinCapability: role ? null : builtinCapability, roleName: role ? role.name : BUILTIN_NOUN[builtinCapability!] ?? builtinCapability, resourceType, resourceId, assignmentId })
    })

  app.get<{ Querystring: { resourceType?: string; resourceId?: string } }>('/admin/roles/mappings', async (req) => {
    requireEntitlement(req)
    // Filtered by one resource → the #485 per-resource LIST authority (a space manager sees their own
    // space's mappings). Unfiltered → the tenant-wide config view, which is admin-only (no
    // cross-space enumeration; same rule as the assignments list).
    const { resourceType, resourceId } = req.query
    if (resourceType || resourceId) {
      if ((resourceType !== 'page' && resourceType !== 'space' && resourceType !== 'tenant') || !resourceId) {
        throw Object.assign(new Error('resourceType (page|space|tenant) and resourceId required together'), { statusCode: 400 })
      }
      if (resourceType === 'tenant' && resourceId !== req.tenant.id) throw Object.assign(new Error('not found'), { statusCode: 404 })
      await requireListAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType, resourceId })
    } else {
      await adminGate(req)
    }
    const rows = await req.db.sql<{ id: string; group_name: string; role_id: string | null; builtin_capability: string | null; name: string | null; resource_type: string; resource_id: string; assignment_id: string | null }[]>`
      SELECT m.id, m.group_name, m.role_id, m.builtin_capability, r.name, m.resource_type, m.resource_id, m.assignment_id
      FROM group_role_mappings m LEFT JOIN roles r ON r.id = m.role_id
      WHERE ${resourceType ? req.db.sql`m.resource_type = ${resourceType} AND m.resource_id = ${resourceId!}` : req.db.sql`TRUE`}
      ORDER BY m.group_name, COALESCE(r.name, m.builtin_capability)`
    // Orphan badge (ADR-183 §1): a mapping whose group NAME no longer appears in any member's groups
    // (renamed/emptied at the IdP). It still owns its assignment — surfaced, never auto-migrated.
    const live = await req.db.sql<{ g: string }[]>`SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL`
    const liveSet = new Set(live.map((r) => r.g))
    return rows.map((r) => ({
      id: r.id, groupName: r.group_name, roleId: r.role_id, builtinCapability: r.builtin_capability,
      roleName: r.name ?? (r.builtin_capability ? BUILTIN_NOUN[r.builtin_capability] ?? r.builtin_capability : ''),
      resourceType: r.resource_type, resourceId: r.resource_id,
      assignmentId: r.assignment_id, orphaned: !liveSet.has(r.group_name),
    }))
  })

  app.delete<{ Params: { mappingId: string } }>('/admin/roles/mappings/:mappingId', async (req, reply) => {
    requireEntitlement(req)
    // Read the mapping + its role's scope/caps on the RLS handle first — a cross-tenant / unknown id is
    // a uniform 404. The mapping's resource/role are immutable, so gating on this pre-read is safe.
    const [m] = await req.db.sql<{ id: string; assignment_id: string | null; resource_type: 'page' | 'space' | 'tenant'; resource_id: string; capabilities: AnyRoleCapability[] }[]>`
      SELECT m.id, m.assignment_id, m.resource_type, m.resource_id,
             COALESCE(r.capabilities, ARRAY[m.builtin_capability]) AS capabilities
      FROM group_role_mappings m LEFT JOIN roles r ON r.id = m.role_id WHERE m.id = ${req.params.mappingId}`
    if (!m) throw Object.assign(new Error('not found'), { statusCode: 404 })
    // Same per-scope authority as create/assign — a space manager may remove their space's mapping.
    await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: m.resource_type, resourceId: m.resource_id, capabilities: m.capabilities as AnyRoleCapability[] })
    // Remove the owned assignment via the ref-counted unassign (a NULL assignment_id — a
    // transient/orphaned mapping — just drops the row). Then delete the mapping row + audit.
    if (m.assignment_id) {
      await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: m.assignment_id, actorSub: req.user.sub })
      // #497 re-review N1/N3: a composite mapping owns MORE than the row it points at. Its sibling
      // arms are the bundle's other capabilities, mapping-owned, on the same principal + resource
      // strip them with it, or "delete the mapping" leaves a comment grant nobody can reach (the
      // Members surface refuses to revoke machine-managed rows, correctly).
      const [mapRow] = await req.db.sql<{ builtin_capability: string | null; group_name: string }[]>`
        SELECT builtin_capability, group_name FROM group_role_mappings WHERE id = ${m.id}`
      const siblings = mapRow?.builtin_capability ? builtinBundle(mapRow.builtin_capability).filter((c) => c !== mapRow.builtin_capability) : []
      if (siblings.length) {
        const principal = groupGrantee(req.tenant.id, mapRow!.group_name)
        const rows = await req.db.sql<{ id: string }[]>`
          SELECT id FROM role_assignments
          WHERE resource_type = ${m.resource_type} AND resource_id = ${m.resource_id} AND principal = ${principal}
            AND origin = 'mapping' AND builtin_capability = ANY(${siblings})`
        for (const r of rows) {
          await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: r.id, actorSub: req.user.sub })
        }
      }
    }
    await req.db.tx(async (tx) => {
      await tx`DELETE FROM group_role_mappings WHERE id = ${req.params.mappingId}`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'role.mapping_deleted', target: `role:mapping:${req.params.mappingId}` })
    })
    return reply.code(204).send()
  })
}

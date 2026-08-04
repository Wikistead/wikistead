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
import { requireTenantAdmin, requireRoleManager, isTenantAdmin, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import { reindexPublishedPages } from './spaces.js'
import { spaceGrantTuplesFor, ADMIN_CLASS_ROLE_CAPS } from '../space-grant-expansion.js' // #514 §6: the ONE capability→relation table (+ the ONE admin-class set)
import { groupGrantee, groupNameByFgaId, knownGroupNames, confirmedGroupNames, resolveGroupName } from '../auth/group-sync.js' // #497: mappings assign the group principal; #536names for display
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
// (pages.ts `ADMIN_CLASS_RELATIONS`,STRICT fork) gates behind `manage`. `manage` itself is not a
// role capability (it is the built-in superset), so the role-side set is that page set minus `manage`.
// A role assignment at PAGE scope requires the assigner's page `manage` iff the role bundles ANY of
// these — otherwise a `share`-only holder could assign a role that escalates a principal to admin class.
// (definition moved to space-grant-expansion.ts — ADR-209 needed it in spaces.ts too, and the two
// route modules only reach each other dynamically)
export { ADMIN_CLASS_ROLE_CAPS } from '../space-grant-expansion.js'

// #496 / ADR-181 adds `issueApiKeys` (→ the `api_key_issue` relation) as the SECOND tenant capability,
// retiring #462's api_key_issue_policy enum: who may mint an API key is now a role capability like any
// other, so authority lives in FGA alone.
export const TENANT_ROLE_CAPABILITIES = ['createSpaces', 'issueApiKeys', 'manageConnections', 'manageRoles', 'viewAudit'] as const
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
  // ADR-209 (#607): the membership verb — runs the roster of readers and editors, cannot appoint or
  // remove a moderator, a manager, or another holder of itself (the spaces.ts ceiling). The declared
  // list is minimal like moderator's; what it CONFERS is measured (role-capability-truth-586).
  { name: 'access-manager', capabilities: ['manageAccess'] },
  // #604 C (user ruling (a)): the three admin-class leaves, under the model's own names — they were
  // grantable via custom roles all along, and the built-in door now says so too. Declarations are
  // minimal like moderator's; what each CONFERS is measured (role-capability-truth-586). All three sit
  // inside the ADR-209 ceiling: a manager hands them out, an access-manager cannot.
  { name: 'deleter', capabilities: ['delete'] },
  { name: 'sharer', capabilities: ['share'] },
  { name: 'settings-editor', capabilities: ['settings'] },
]
// #552: RESERVED_NAMES derives from BUILT_IN_ROLES, so dropping `commenter` above deliberately
// FREES the name for custom roles — reserving a name no built-in carries would be a claim with no
// referent. (A tenant that wants a role called "commenter" now simply builds one.)
// #497 (088): the built-ins a group mapping may confer, and the noun each renders as (the same
// vocabulary the Members picker uses). `comment` is deliberately absent — theruling removed
// the commenter noun from every grant surface; comment-only stays a custom-role composition.
const BUILTIN_MAPPABLE = new Set(['view', 'edit', 'moderate', 'manage', 'manageAccess'])
const BUILTIN_NOUN: Record<string, string> = { view: 'viewer', edit: 'editor', moderate: 'moderator', manage: 'manager', manageAccess: 'access-manager' }
// #497 re-review N1 / ADR-199 §2 rev5: the NOUN is the unit a human picks, and `editor` means
// edit + comment (severing edit ⇒ comment left the bare capability unable to comment). The Members
// picker already grants the bundle; a GROUP MAPPING offering the same word has to mean the same
// thing, or "Engineering → editor" produces editors who cannot comment. Mirrors the web's
// COMPOSITE_BUILTINS: one table per side, same content, compared by
// apps/web/src/settings/composite-builtins-lockstep.test.ts (the claim that they were "both pinned"
// was true of each side alone and of neither together, until that test).
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
  // #604 / ADR-208 (ruling B): the first verb carved out of `admin`. A tenant role carrying it lets
  // somebody run the sign-in methods without being handed the tenant.
  manageConnections: 'manage_connections',
  manageRoles: 'manage_roles',
  viewAudit: 'view_audit',
}

// `allowSuperset` is set ONLY by the built-in grant path (#536 / ADR-188 §6 item 1). `manage` is the
// built-in superset: it is deliberately absent from ROLE_CAPABILITIES so no custom role can request it,
// and the check below is the second layer that refuses it even if a future path reaches here. Routing
// built-in grants through this mechanism means `manage` now arrives here legitimately — but only from
// that path, which is why it is a parameter rather than a row added to the vocabulary.
export function expansionTuples(resourceType: 'page' | 'space' | 'tenant', resourceId: string, principal: string, cap: AnyRoleCapability, allowSuperset = false): { user: string; relation: string; object: string }[] {
  if (resourceType === 'tenant') {
    // ADR-207 §R4-2 (#603): the tenant TIERS are the tenant superset. They are deliberately absent from
    // TENANT_CAP_RELATION — the vocabulary a custom role may bundle — because a `manageRoles` holder who
    // could define a role carrying `admin` would be a confused deputy (#536 kept `manage` out of the
    // space vocabulary for the same reason). Only the BUILT-IN grant path (allowSuperset) writes these
    // leaves; this is the second layer, matching the page/space branches below.
    if ((cap as string) === 'admin' || (cap as string) === 'member') {
      if (!allowSuperset) throw Object.assign(new Error(`capability "${cap}" is not assignable at tenant scope`), { statusCode: 400 })
      return [{ user: principal, relation: cap, object: `tenant:${resourceId}` }]
    }
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
// This is `requireGrantAuthority` (pages.ts,) applied to every capability at
// once — a partial grant would break theprovenance/ref-count, so ANY
// over-ceiling capability rejects the WHOLE assignment.
// A TENANT ADMIN short-circuits every resource scope: they could assign anywhere before this change
// (incl. a private page, from which a space manager is correctly cut via `manage_from_space … but not
// private`), so the short-circuit preserves that non-regression. `page share` unions `manage`
// (model.fga:168), so a manager passes the page `share` check with no special case.
// #497 / ADR-183: theASSIGN CORE, extracted so the HTTP route AND the group-mapping create path
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
    actorSub: string; origin?: 'manual' | 'mapping' | 'default' | 'invite';
    // #578 bounce ①: the NAME the grant was made with, when the principal is a group. A group's FGA id
    // is a one-way hash, so a listing can only name it by reversing against names the product knows
    // and after the mappings were retired, a group nobody carries yet had nowhere to keep its name.
    // Stored here, next to the grant it belongs to, so it dies with the grant.
    groupName?: string;
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
  // presence-based rule above encodes therole semantic — "a leaf someone else already conferred is
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

// #582 / ADR-202 §2: assign INSIDE a transaction the caller already owns.
//
// Invite acceptance is one tx — the invite flip, the seat check and the member INSERT commit together
// (ADR-003) — and `assignRoleInTx` opens its OWN tx, so calling it from there would put the role in a
// second transaction: a crash in between leaves a member without the role they were invited with. The
// ADR named exporting this as a condition, in the same shape `unassignRoleTxCore` was exported for
// #536.
//
// Same body as `assignRoleInTx`'s: the principal-scoped pre-read, the core, then the tuples LAST.
export async function assignRoleWithinTx(
  tx: Sql, fga: OpenFgaClient,
  args: {
    tenant: { id: string; plan: string }; roleId: string | null; capabilities: AnyRoleCapability[];
    resourceType: 'page' | 'space' | 'tenant'; resourceId: string; principal: string;
    actorSub: string; origin?: 'manual' | 'mapping' | 'default' | 'invite';
    // #578 bounce ①: the NAME the grant was made with, when the principal is a group. A group's FGA id
    // is a one-way hash, so a listing can only name it by reversing against names the product knows
    // and after the mappings were retired, a group nobody carries yet had nowhere to keep its name.
    // Stored here, next to the grant it belongs to, so it dies with the grant.
    groupName?: string;
    auditAction?: string; onDuplicate?: 'conflict' | 'ignore';
  },
): Promise<string | null> {
  const tuples = args.capabilities.flatMap((c) => expansionTuples(args.resourceType, args.resourceId, args.principal, c, false))
  // fga-read-ok: ONE principal on ONE object — bounded by the type's relation count, never by tenant size.
  const { tuples: existingTuples } = await fga.read({ user: args.principal, object: `${args.resourceType}:${args.resourceId}` })
  const existing = new Set((existingTuples ?? []).map((t: Tuple) => `${t.key?.relation}|${t.key?.user}`))
  const toWrite = tuples.filter((t) => !existing.has(`${t.relation}|${t.user}`))
  const outcome = await assignRoleTxCore(tx, args, { owned: args.capabilities, toWrite })
  if (outcome.toWrite.length) await writeTuples(fga, outcome.toWrite)
  return outcome.id ?? outcome.existingId
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
    actorSub: string; origin?: 'manual' | 'mapping' | 'default' | 'invite';
    // #578 bounce ①: the NAME the grant was made with, when the principal is a group. A group's FGA id
    // is a one-way hash, so a listing can only name it by reversing against names the product knows
    // and after the mappings were retired, a group nobody carries yet had nowhere to keep its name.
    // Stored here, next to the grant it belongs to, so it dies with the grant.
    groupName?: string;
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
  await tx`INSERT INTO role_assignments (id, tenant_id, role_id, builtin_capability, resource_type, resource_id, principal, owned_capabilities, origin, group_name)
           VALUES (${id}, ${tenant.id}, ${roleId}, ${builtin}, ${resourceType}, ${resourceId}, ${principal}, ${pre.owned as string[]}, ${origin}, ${args.groupName?.trim() || null})`
  if (args.afterAssign) await args.afterAssign(tx, id)
  if (!args.skipAudit) await auditIfEntitled(tx, tenant, { actor: `user:${actorSub}`, action: args.auditAction ?? 'role.assigned', target: `${resourceType}:${resourceId}` })
  const o = resourceType === 'page' ? await enqueueOutbox(tx, { tenantId: tenant.id, pageId: resourceId, operation: 'upsert' }) : null
  return { id, existingId: null, outboxId: o, toWrite: pre.toWrite }
}

// #553 / ADR-199 §2: the editor-noun composite — N single-capability BUILT-IN grants in ONE db.tx.
// N capabilities = N rows (the rev2 lesson: a built-in row never carries more than its single
// builtin_capability); each arm keeps's unconditional built-in ownership, its own audit event
// and its own dup-idempotence (a principal already holding one arm still lands the other). Space
// scope only — the page dialog offers bare capabilities, no role noun (ADR §2).
export async function assignBuiltinCompositeInTx(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  args: {
    tenant: { id: string; plan: string }; spaceId: string; principal: string; actorSub: string;
    capabilities: string[]; auditAction?: string; skipAudit?: boolean;
    groupName?: string; // #578 bounce ①: the typed name, carried onto every arm of the noun
    // #497 re-review N1: a GROUP MAPPING's arms are machine-managed too — same composite, different
    // origin, and the mapping row is written in the SAME tx (afterArms) so a mapping can never
    // commit owning one arm and not the other.
    origin?: 'manual' | 'mapping' | 'default' | 'invite';
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
        origin: args.origin, groupName: args.groupName,
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

// #497 / ADR-183: theUNASSIGN CORE by assignment id, extracted for the mapping DELETE path. The
// caller has already checked authority (or, for a mapping delete, the mapping row proves ownership).
// #596: the outcome names what the principal STILL retains through other assignments (stillCovered),
// so a surface can say "removed, but X still grants this" instead of a bare success that reads as
// "they lost access" when they did not.
export interface UnassignOutcome {
  deleted: boolean
  // `via` names the covering assignment (a custom role's name, or the built-in capability a direct
  // grant is). #596 review F1: it is OMITTED for a caller who may not read role definitions on this
  // resource — see redactCoverage.
  stillCovered: { capability: string; via?: string }[]
}

// #596 review F1: role NAMES are tenant-wide information. ADR-202 §1 deliberately gated reading them
// on the target's `manage` (the page grant/revoke verb is the wider `share`), so a coverage report
// must not become the back door that hands a share-only holder the tenant's role names. The refusal
// and the "still granted" fact stay — they are about the page the caller already administers — but
// the NAME travels only to callers who could read it from the role endpoints anyway.
export function redactCoverage<T extends { capability: string; via?: string }>(
  covered: T[], mayReadNames: boolean,
): { capability: string; via?: string }[] {
  return mayReadNames ? covered : covered.map((c) => ({ capability: c.capability }))
}
export async function unassignRoleInTx(
  db: TenantDb, fga: OpenFgaClient, searchDriver: SearchDriver,
  args: {
    tenant: { id: string; plan: string }; assignmentId: string; actorSub: string;
    // #536: the built-in grant path revokes through here but keeps its own audit vocabulary (see the
    // matching note on assignRoleInTx).
    auditAction?: string; skipAudit?: boolean;
  },
): Promise<UnassignOutcome> {
  let deleted = false
  let stillCovered: { capability: string; via?: string }[] = []
  let resourceType = 'page' as 'page' | 'space' | 'tenant'
  let resourceId = ''
  // #596 review F2: coverage must be decided from what FGA ACTUALLY HOLDS, not from assignment rows
  // alone. A pre-086 rowless tuple confers the capability with no row to count, so a row-only rule
  // answered "nothing else grants this" while the access plainly remained. Read the principal's live
  // tuples BEFORE the transaction (the shape revokeSpaceAccessComposite already uses) and let the core
  // decide per capability. The pre-read needs the principal, so resolve the row first — the tx re-reads
  // it FOR UPDATE, which stays the authority.
  const [pre] = await db.sql<{ principal: string; resource_type: 'page' | 'space' | 'tenant'; resource_id: string }[]>`
    SELECT principal, resource_type, resource_id FROM role_assignments WHERE id = ${args.assignmentId}`
  let held: Set<string> | undefined
  if (pre) {
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so this is bounded by the type's relation count, never by tenant size.
    const { tuples } = await fga.read({ user: pre.principal, object: `${pre.resource_type}:${pre.resource_id}` })
    held = new Set((tuples ?? []).map((t: Tuple) => t.key?.relation ?? ''))
  }
  const oid = await db.tx(async (tx) => {
    const r = await unassignRoleTxCore(tx, { ...args, heldRelations: held })
    if (!r) return null
    deleted = true
    stillCovered = r.stillCovered
    resourceType = r.resourceType
    resourceId = r.resourceId
    // FGA LAST, inside the tx — a failure here rolls the row deletions back, and the composite caller
    // batches every arm's tuples into ONE delete instead of a call per arm.
    if (r.toDelete.length) await deleteTuples(fga, r.toDelete)
    return r.outboxId
  })
  if (oid) processOutboxAsync(searchDriver, oid, { tenantId: args.tenant.id, pageId: resourceId, operation: 'upsert' })
  if (deleted && resourceType === 'space') await reindexPublishedPages(db, searchDriver, args.tenant.id, resourceId)
  return { deleted, stillCovered }
}

// #553(a): the ONE-transaction unassign body, extracted for the same reason its assign twin was
// — the folded `editor` row is two rows underneath, and revoking it as two requests could leave the
// comment arm standing after the edit arm went. "Deleted, but they can still comment" is a leftover
// nobody goes looking for, so it must not be reachable by a client that stops halfway, loses its
// connection, or is closed between the two calls. Rows go in one tx; the tuples are collected and
// deleted ONCE by the caller (FGA does not roll back with the tx, so batching narrows the window to
// exactly what the single-arm path has always had).
interface UnassignTxOutcome {
  resourceType: 'page' | 'space' | 'tenant'; resourceId: string; outboxId: string | null
  toDelete: { user: string; relation: string; object: string }[]
  // #596: the capabilities THIS assignment conferred that the principal still retains through other
  // assignments, labelled by what retains them (a custom role's name / a built-in capability). The
  // row deletion is a real change and stays a success — but "removed and they still have access" must
  // reach the surface as words, not as a success toast that implies the opposite.
  stillCovered: { capability: string; via?: string }[]
}
export async function unassignRoleTxCore(
  tx: Sql,
  args: {
    tenant: { id: string; plan: string }; assignmentId: string; actorSub: string; auditAction?: string; skipAudit?: boolean
    // #596: the principal's LIVE relations on the resource, read by the caller before the tx. Coverage
    // is then decided from FGA truth (a rowless legacy tuple counts) rather than from rows alone.
    // Absent = row-only reasoning (the composite caller computes its own delete set from live tuples).
    heldRelations?: Set<string>
  },
): Promise<UnassignTxOutcome | null> {
  interface AsgRow { id: string; role_id: string; resource_type: 'page' | 'space' | 'tenant'; resource_id: string; principal: string; owned_capabilities: string[]; capabilities: string[] }
  {
    // #536 / ADR-188 §6 item 1: LEFT join. A built-in grant is a row with no roles entry (built-ins are
    // virtual), and an inner join would make unassign silently find nothing for it — a revoke that
    // answers success and deletes neither the row nor the tuples.
    const [asg] = await tx<AsgRow[]>`
      SELECT a.id, a.role_id, a.resource_type, a.resource_id, a.principal, a.owned_capabilities,
             COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS capabilities
      FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = ${args.assignmentId} FOR UPDATE OF a`
    if (!asg) return null
    // ADR-207 §R4-5 (#603): SECOND line under the last-admin FLOOR. In production this never fires
    // the members routes keep at least one row admin (the floor), so a group's `admin` grant is never
    // the last path and revoking it is never refused. It exists so a future change that breaks the
    // floor cannot ALSO silently delete the final admin power; it is deliberately not pinned by a test,
    // because reaching it means hand-writing a members table no route can produce (§R4-5).
    if (asg.resource_type === 'tenant' && asg.role_id === null && (asg.capabilities ?? []).includes('admin')) {
      const [adm] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM members WHERE role = 'admin' AND deactivated_at IS NULL`
      if ((adm?.n ?? 0) === 0) throw Object.assign(new Error('cannot remove the last admin'), { statusCode: 409 })
    }
    // Same LEFT join for the refcount: the capabilities a principal still holds through OTHER assignments
    // now include built-in grants. With the inner join, revoking a custom role that overlapped a built-in
    // grant deleted the shared leaves outright -- the grant was still there, and the access was not.
    // #596: `via` labels the covering assignment for the response (role name / built-in capability).
    const others = await tx<{ id: string; capabilities: string[]; via: string }[]>`
      SELECT a.id, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS capabilities,
             COALESCE(r.name, a.builtin_capability) AS via
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
    // #596: report on the CONFERRED set (asg.capabilities), not just the owned set — an assignment
    // that owned nothing (its leaves pre-existed) still conferred; after its removal the principal
    // keeps those capabilities through whoever covers them, and the surface must say so.
    //
    // review F2: a capability survives this removal when a SURVIVING ROW confers it (named by that
    // row) OR when its leaves are simply still in FGA after the delete set is applied — the rowless
    // pre-086 grant, which no row can speak for. A rowless holder is named by the capability itself
    // that is exactly what a direct grant of it is called (the client renders it as the same noun the
    // pickers use).
    const goingAway = new Set(toDelete.map((t) => t.relation))
    const survivesInFga = (c: AnyRoleCapability): boolean => {
      if (!args.heldRelations) return false
      const leaves = expansionTuples(asg.resource_type, asg.resource_id, asg.principal, c, asg.role_id === null)
      return leaves.length > 0 && leaves.every((t) => args.heldRelations!.has(t.relation) && !goingAway.has(t.relation))
    }
    const kept = (asg.capabilities ?? []).filter((c) => stillCovered.has(c) || survivesInFga(c as AnyRoleCapability))
      .map((c) => ({ capability: c, via: others.find((o) => o.capabilities.includes(c))?.via ?? c }))
    // #596 review F3: the audit ACTION must describe what happened. `page.access_revoked` /
    // `space.access_revoked` mean "a principal LOST a relation" (the event catalog says so); writing
    // one while the principal keeps every capability the row conferred is the same class of lie this
    // ticket removes — a hash-chained ledger makes it permanent. The removal is real, so it is still
    // recorded, under the vocabulary that is true of it: the ASSIGNMENT was unassigned.
    const lostSomething = (asg.capabilities ?? []).some((c) => !kept.some((k) => k.capability === c))
    const action = lostSomething ? (args.auditAction ?? 'role.unassigned') : 'role.unassigned'
    if (!args.skipAudit) await auditIfEntitled(tx, args.tenant, { actor: `user:${args.actorSub}`, action, target: `${asg.resource_type}:${asg.resource_id}` })
    const o = asg.resource_type === 'page' ? await enqueueOutbox(tx, { tenantId: args.tenant.id, pageId: asg.resource_id, operation: 'upsert' }) : null
    return { resourceType: asg.resource_type, resourceId: asg.resource_id, outboxId: o, toDelete, stillCovered: kept }
  }
}

// #497 / ADR-183 §3: the tenant DEFAULT role evaluator. A member whom NO mapping matches gets the

export async function requireAssignmentAuthority(
  fga: OpenFgaClient,
  args: { sub: string; tenantId: string; resourceType: 'page' | 'space' | 'tenant'; resourceId: string; capabilities: AnyRoleCapability[]; replace?: boolean },
): Promise<void> {
  const { sub, tenantId, resourceType, resourceId, capabilities } = args
  if (resourceType === 'tenant') { await requireTenantAdmin(fga, sub, tenantId); return }
  if (await isTenantAdmin(fga, sub, tenantId)) return // global admin keeps assigning anywhere (non-regression)
  if (resourceType === 'space') {
    // ADR-209 (#607): the roles door takes the SAME two-question gate as the built-in door. The old
    // comment here said no per-capability ceiling is needed because "a manager already holds every
    // space capability" — a sentence that stopped being true the moment a weaker principal
    // (access_manager) could hold this gate. A role whose capabilities intersect the admin-class set,
    // or an assignment made with `replace`, still requires `manage`; roster roles need only the verb.
    const movesAdminClass = args.replace === true || capabilities.some((c) => ADMIN_CLASS_ROLE_CAPS.has(c as RoleCapability) || c === ('manage' as AnyRoleCapability) || c === ('manageAccess' as AnyRoleCapability))
    const rel = movesAdminClass ? 'manage' : 'manageAccess'
    if (!(await check(fga, `user:${sub}`, rel, { type: 'space', id: resourceId }))) throw forbidden()
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
  // ADR-209 (#607): at SPACE scope the roster verb may read who holds what and which roles are
  // assignable — without the two reads the verb can grant but not see (rev0 finding 4). Pages stay
  // on `manage`.
  const rel = resourceType === 'space' ? 'manageAccess' : 'manage'
  if (!(await check(fga, `user:${sub}`, rel, { type: resourceType, id: resourceId }))) throw forbidden()
}

// #603: the typed name a group's EXISTING rows carry, for a re-assign that arrives by principal.
// The row being replaced is the only thing that knows what was typed (#578 bounce ① — the id is a
// one-way hash), so the replacement inherits it rather than demoting the group to "unknown group".
async function carriedGroupName(sql: Sql, principal: string): Promise<string | undefined> {
  if (!principal.startsWith('group:')) return undefined
  const [row] = await sql<{ group_name: string }[]>`
    SELECT group_name FROM role_assignments
    WHERE principal = ${principal} AND group_name IS NOT NULL LIMIT 1`
  return row?.group_name ?? undefined
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
    // #604 (ruling B): defining and handing out roles is its own power now (`or admin` unchanged)
    await requireRoleManager(app.fga, req.user.sub, req.tenant.id)
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
            // REMOVE: thereference count per assignment — delete an owned leaf only when no
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
    // ADR-207 §R4-3 (#603): LEFT join, for TENANT scope. A BUILT-IN grant is a row with `role_id IS
    // NULL`, and the inner join silently dropped every one of them — the tenant tier a group holds
    // never came back, so the screen computed provenance over an empty set. The row carries the
    // built-in capability as its name. Space/page scope deliberately keeps the old projection
    // (role rows only): their built-in grants are already listed by the ACCESS listing, and returning
    // them here too would draw every grant twice on those surfaces.
    const rows = await req.db.sql<{ id: string; role_id: string | null; name: string; builtin: string | null; principal: string; origin: string }[]>`
      SELECT a.id, a.role_id, COALESCE(r.name, a.builtin_capability) AS name, a.builtin_capability AS builtin, a.principal, a.origin
      FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id
      WHERE a.resource_type = ${resourceType} AND a.resource_id = ${resourceId}
        AND (a.role_id IS NOT NULL OR ${resourceType === 'tenant'})
      ORDER BY name, a.principal`
    // #523 / ADR-190 (slice E): name the USER principals. This list is already authorization-bounded and
    // server-set (requireListAuthority above, one resourceId, no cross-resource enumeration), so resolving
    // `override ?? OIDC display_name` over it is the SAME precedent as the manage-gated grant list in slice
    // A — it is not an arbitrary-sub lookup, so the /members/identities oracle boundary is untouched. The
    // caller's RLS handle does the read: a cross-tenant or departed sub resolves to null and the client
    // falls back to the raw sub. Group principals are never resolved (they carry their own name).
    const userSubs = rows.filter((r) => r.principal.startsWith('user:')).map((r) => r.principal.slice(5))
    const names = userSubs.length ? await resolveAuthorIdentities(req.db, userSubs) : new Map()
    // #536(6): a GROUP principal is a hash (groupFgaId is one-way) — resolve it back to the human
    // name server-side, the same way listSpaceAccess does (group-sync.ts stays the single id authority;
    // the client never sees a reverse table). A group that no longer appears in any member's groups
    // (renamed / emptied at the IdP) gets no groupName — the client shows its explicit orphan label and
    // the row stays revocable.
    const hasGroups = rows.some((r) => r.principal.startsWith('group:'))
    const byId = groupNameByFgaId(req.tenant.id, hasGroups ? await knownGroupNames(req.db) : [])
    // #578 bounce ①: same distinction as the space listing — a typed name is shown, and marked.
    const confirmed = hasGroups ? await confirmedGroupNames(req.db) : new Set<string>()
    return rows.map((r) => {
      const groupName = resolveGroupName(r.principal, byId)
      return {
        id: r.id, roleId: r.role_id, roleName: r.name, principal: r.principal,
        // ADR-207: the client tells a built-in tier apart from a custom role that took its name by
        // MECHANISM, never by string comparison (the same guard the row picker's value prefix gives).
        ...(r.builtin ? { builtin: r.builtin } : {}),
        ...(r.principal.startsWith('user:') ? { displayName: names.get(r.principal.slice(5))?.displayName ?? null } : {}),
        ...(groupName ? { groupName } : {}),
        ...(groupName && !confirmed.has(groupName) ? { groupUnconfirmed: true } : {}),
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

  // #582 / ADR-202 §1: the PAGE equivalent of `/spaces/:spaceId/assignable-roles`. The page dialog
  // offers custom roles beside the built-in capabilities, and a PAGE-only manager (someone holding
  // `manage_direct` on the page, which that very dialog can grant) could not fetch the list: the space
  // endpoint is gated on SPACE manage and `/admin/roles` on tenant admin. #485 added the space one for
  // exactly this reason ("the tenant-admin-gated GET /admin/roles is unreachable for them").
  //
  // Gated on the page's `manage` — deliberately NARROWER than the `share` that suffices to assign
  // (share unions manage in the model). At space scope list and assign are both `manage` so the
  // question never arose; here it is a choice, and the narrower one is taken because a role's
  // capability list is tenant-wide information and `share` is a wider audience.
  //
  // NO EXISTENCE ORACLE: a non-admin without `manage` is refused whether or not the page exists, and
  // the body is tenant-wide role DEFINITIONS with nothing derived from the page — so the tenant-admin
  // short-circuit inside requireListAuthority, which answers before reading the page at all,
  // distinguishes nothing either.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/assignable-roles', async (req) => {
    await requireListAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: 'page', resourceId: req.params.pageId })
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
      // #536a GROUP is named, never addressed. Its FGA id is a tenant-salted hash the server owns
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
      // resource reads (matches the original writeGates order; theentitlement anti-test pins it).
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
      await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType, resourceId, capabilities: caps, replace: req.body?.replace === true })
      // #536item 2 (space scope): ONE principal = ONE role. A machine-owned (mapping/default) row
      // refuses the manual add up front (ADR-183 §1 ownership — 409 before any write); after the new row
      // lands, the principal's OTHER manual roles (grant rows, other assignments, legacy rowless tuples)
      // are swept so a direct API double-assign converges to one role. Page/tenant scope unchanged.
      if (resourceType === 'space') {
        const { assertNoMachineSpaceRole, assertManagerReplacementConfirmed } = await import('./spaces.js')
        await assertNoMachineSpaceRole(req.db, { spaceId: resourceId, principal, keep: { roleId: role.id } })
        // #536same wall on the custom-role door. A custom role can never bundle `manage`, so
        // assigning one to a manager is always the weaker-role case the ruling is about.
        await assertManagerReplacementConfirmed(req.db, app.fga, {
          spaceId: resourceId, principal, keepCaps: caps as string[], replace: req.body?.replace === true,
        })
      }
      // #497: theassign core is now a shared helper (the HTTP route + the mapping create path).
      const id = await assignRoleInTx(req.db, app.fga, app.searchDriver, {
        tenant: req.tenant, roleId: role.id, capabilities: caps, resourceType, resourceId, principal,
        actorSub: req.user.sub, origin: 'manual',
        // #578 bounce ①: the name travels with the grant. Without it a role given to a group nobody
        // carries yet comes back as "unknown group" — the id is a one-way hash and this row is the
        // only thing that knows what was typed.
        // #603: and it travels ACROSS a replacement. A row's Select re-assigns by PRINCIPAL (the id it
        // got from the listing), so a typed name would die with the folded row and the group would
        // come back as "unknown group" one pick later — measured in the #603 e2e before this lookup.
        groupName: (typeof groupName === 'string' && groupName.trim()) || await carriedGroupName(req.db.sql, principal),
      })
      if (resourceType === 'space') {
        const { sweepOtherSpaceRoles } = await import('./spaces.js')
        await sweepOtherSpaceRoles(req.db, app.fga, app.searchDriver, {
          spaceId: resourceId, tenantId: req.tenant.id, userId: req.user.sub, principal,
          keep: { roleId: role.id }, keepCaps: caps as string[], plan: req.tenant.plan, replaceManage: req.body?.replace === true,
        })
      }
      // #579 (user ruling, twice): ROLES DO NOT STACK — and until now that was only true at space scope.
      //
      // — the tenant screen had grown an additive
      // model (chips, an "add role" control) on top of a mechanism that never promised it, and the same
      // ruling was already recorded once at #536 ("1 principal = 1 role; the SERVER converges too, not
      // just the UI"). Space scope implemented it; tenant scope did not, so a direct API call could give
      // one principal two tenant roles and the screen then had to invent a way to show them.
      //
      // Convergence, not refusal: the new role is written first and the principal's OTHER tenant-scope
      // assignments are unassigned after, so there is no instant where they hold nothing. Same order as
      // the space sweep, for the same reason.
      //
      // EXISTING multi-holdings are NOT bulk-migrated, and that is a decision rather than an omission
      // the space sweep set the precedent (#536 — "cleaned up on the next add for that principal; no
      // bulk backfill"), a migration would silently pick a winner for people who are not looking, and
      // this path folds them the moment anyone touches that principal again. Nothing is removed quietly
      // every unassign here goes through the audited, ref-counted core.
      if (resourceType === 'tenant') {
        const others = await req.db.sql<{ id: string }[]>`
          SELECT id FROM role_assignments
          WHERE resource_type = 'tenant' AND resource_id = ${resourceId} AND principal = ${principal}
            AND origin = 'manual' AND id <> ${id}`
        for (const o of others) {
          await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: o.id, actorSub: req.user.sub })
        }
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
    // ADR-207 §R4-3 (#603): NO entitlement gate on removal. A downgraded tenant must still be able to
    // take `admin` off a group — a plan gate that blocks REVOKING is a fail-open shape (the power stays
    // because the tenant stopped paying). The gate stays on granting, where refusing is the safe answer.
    // Same LEFT join as the unassign core: a built-in grant has `role_id IS NULL` and the inner join
    // 404'd exactly the rows this ticket creates.
    const [pre] = await req.db.sql<{ resource_type: 'page' | 'space' | 'tenant'; resource_id: string; capabilities: AnyRoleCapability[]; origin: string }[]>`
      SELECT a.resource_type, a.resource_id, COALESCE(r.capabilities, ARRAY[a.builtin_capability]) AS capabilities, a.origin
      FROM role_assignments a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = ${req.params.assignmentId}`
    if (!pre) throw Object.assign(new Error('not found'), { statusCode: 404 })
    // #497 re-review N2: the SAME §1 ownership the builtin branch enforces (D1) — a mapping-owned
    // assignment dies with its MAPPING, never through this route (deleting it here left the mapping
    // row pointing at nothing: access gone, console row still promising it, re-creation blocked by
    // the mapping's uniqueness). Deleting the mapping is the one real revocation.
    if (pre.origin === 'mapping') {
      throw Object.assign(new Error('managed by a group mapping — delete the mapping instead'), { statusCode: 409 })
    }
    await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: pre.resource_type, resourceId: pre.resource_id, capabilities: pre.capabilities as AnyRoleCapability[] })
    // #497: theunassign core is the shared helper (HTTP route + mapping delete).
    const gone = await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: req.params.assignmentId, actorSub: req.user.sub })
    if (!gone.deleted) throw Object.assign(new Error('not found'), { statusCode: 404 })
    // #596: 200 with the honesty payload, not a bare 204 — when the principal keeps a capability
    // through another assignment, the client must be able to say which one instead of implying
    // the access is gone.
    // review F1: at PAGE scope this route's authority is `share` (requireAssignmentAuthority), while
    // role names are readable at `manage` (ADR-202 §1) — so the names travel only that far.
    const mayName = pre.resource_type !== 'page'
      || await check(app.fga, `user:${req.user.sub}`, 'manage', { type: 'page', id: pre.resource_id })
    return reply.code(200).send({ removed: true, stillCovered: redactCoverage(gone.stillCovered, mayName) })
  })

  // ADR-207 §R4-3 (#603): grant a TENANT TIER (admin | member) to a GROUP. This is the path that did
  // not exist — the assignment POST above takes a role id, and a tier has none. It is the BUILT-IN
  // grant mechanism (#536: built-ins ARE assignments), so
  // - the capability, not a role id, names what is granted (row: role_id NULL + builtin_capability);
  // - NO entitlement gate — tiers are core product, not the customRoles plan feature;
  // - groups only. A person's tier is their members row (PATCH /members/:sub); a second mechanism
  // for the same fact would fork the truth the last-admin floor counts.
  // Authority is the tenant branch of requireAssignmentAuthority = TENANT ADMIN. Deliberately NOT the
  // #604 `manageRoles` gate: a manage_roles holder who could hand `admin` to their own group would be
  // the confused deputy §R4-2 exists to prevent, one door over.
  app.post<{ Body: { capability?: string; groupName?: string; principal?: string } }>(
    '/admin/roles/tenant-tier-assignments', async (req, reply) => {
      const cap = req.body?.capability
      if (cap !== 'admin' && cap !== 'member') {
        throw Object.assign(new Error('capability (admin|member) required'), { statusCode: 400 })
      }
      // #536a group is NAMED, never addressed — the server owns the tenant-salted hash. A
      // principal from the assignment listing (already an id) is also accepted; a hand-built one that
      // matches no membership grants nobody, which is why the name form is preferred.
      const principal = typeof req.body?.groupName === 'string' && req.body.groupName.trim()
        ? groupGrantee(req.tenant.id, req.body.groupName.trim())
        : req.body?.principal
      if (!principal) throw Object.assign(new Error('groupName or principal required'), { statusCode: 400 })
      validatePrincipal(principal)
      if (!principal.startsWith('group:')) {
        throw Object.assign(new Error("a person's tier lives on their member row — this path grants tiers to groups"), { statusCode: 400 })
      }
      await requireAssignmentAuthority(app.fga, { sub: req.user.sub, tenantId: req.tenant.id, resourceType: 'tenant', resourceId: req.tenant.id, capabilities: [cap as AnyRoleCapability] })
      const id = await assignRoleInTx(req.db, app.fga, app.searchDriver, {
        tenant: req.tenant, roleId: null, builtinCapability: cap, capabilities: [cap as AnyRoleCapability],
        resourceType: 'tenant', resourceId: req.tenant.id, principal, actorSub: req.user.sub, origin: 'manual',
        groupName: (typeof req.body?.groupName === 'string' && req.body.groupName.trim()) || await carriedGroupName(req.db.sql, principal),
        onDuplicate: 'ignore',
      })
      // #579: ONE role per tenant principal — the same convergence the custom-role POST runs. The new
      // grant is written first, then the principal's other manual tenant assignments fold, so there is
      // no instant where the group holds nothing.
      const others = await req.db.sql<{ id: string }[]>`
        SELECT id FROM role_assignments
        WHERE resource_type = 'tenant' AND resource_id = ${req.tenant.id} AND principal = ${principal}
          AND origin = 'manual' AND id <> ${id}`
      for (const o of others) {
        await unassignRoleInTx(req.db, app.fga, app.searchDriver, { tenant: req.tenant, assignmentId: o.id, actorSub: req.user.sub })
      }
      return reply.code(201).send({ id, builtin: cap, resourceType: 'tenant', resourceId: req.tenant.id, principal })
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
  // #578 / ADR-201 slice 5: the DEFAULT ROLE is retired. It said the same thing as the every-member
  // toggles below (the tenant vocabulary is createSpaces and issueApiKeys, and both have one), so one
  // of the two had to go. Existing settings were converted rather than dropped — see migration 100 and
  // the one-shot toggle script.

  // ---- #497 / ADR-183 → RETIRED by #578 / ADR-201 (slices 3 and 7) ----
  // A mapping was a declaration row that OWNED a group-principal role assignment. It never added an FGA
  // write path: the assignment it created is the very same one the grant path writes, on the very same
  // principal. What it added was a SECOND way to reach that result, and with it the ownership rules,
  // the 409s and the drift sweep that existed to keep the two stories consistent. ADR-201 ruled one
  // mechanism; the grant is the one that survives, and since slice 1 the grant picker also accepts a
  // group nobody carries yet — the one thing this surface could do that the picker could not.
  //
  // Slice 3 closed the SPACE scope; this closes the TENANT scope, which #514 had made the only place a
  // mapping could still be created. The replacement is the tenant settings' group assignment (#579)
  // one assignment row on `group:<id>#member`, the same principal, no declaration to keep honest.
  //
  // The routes stay declared and answer 410 rather than vanishing, so a stale client (or a script) is
  // told the surface is gone and where to go, instead of getting a 404 it will read as "wrong URL".
  // Existing rows were CONVERTED, not deleted — migrations 098 (space) and 103 (tenant) re-own each
  // assignment as an ordinary manual grant, carrying the group NAME onto the row so the listing can
  // still resolve it (the one-way hash means a dropped name renders as "unknown group" — #578 bounce ①).
  const mappingRetired = (): never => {
    throw Object.assign(new Error('group mappings are retired — assign the role to the group in tenant settings, or on the space Members tab'), {
      statusCode: 410, code: 'mapping_retired',
    })
  }
  app.post('/admin/roles/mappings', async () => mappingRetired())
  app.get('/admin/roles/mappings', async () => mappingRetired())
  app.delete('/admin/roles/mappings/:mappingId', async () => mappingRetired())
}

// #514 / ADR-188 §6: ONE table saying what a space-scope capability grants.
//
// Two paths used to answer that question separately — the built-in member grant (spaces.ts CAP_TO_RELATION
// + its viewer/viewer_member pairing) and the custom-role assignment (roles.ts SPACE_CAP_RELATIONS). They
// agreed, but only because two people kept them agreeing; the #485 bug came from exactly the gap between
// them (a capability the assignment path refused while the grant path allowed it through another name).
// A single table cannot drift from itself.
//
// THE `manage` ENTRY IS NOT A BUNDLE, and that is the whole subtlety the design review caught. `manager`
// is a SUPERSET LEAF in the model: the built-in manager role's listed capabilities do not include `manage`
// at all, and do not even list `moderate` — those come from the leaf itself
// (`model.fga`: space#moderator = [...] or manager, page manage_from_space = manager from space).
// Expanding `manage` into the listed capabilities would silently strip space manage, page
// manage_from_space and moderator from every manager grant. So `manage` short-circuits to the single
// `manager` leaf, and custom roles still cannot request it (it is absent from ROLE_CAPABILITIES).
//
// Equivalence is pinned in __tests__/builtin-grant-equivalence-514.test.ts against a real OpenFGA store.
import type { SpaceCapability } from './routes/spaces.js'
import type { RoleCapability } from './routes/roles.js'

// ADR-164 / ADR-209: THE admin-class capability set — one definition, shared by the page-scope role
// ceiling (roles.ts), the space membership ceiling (spaces.ts, ADR-209 §2) and nothing else. It lives
// here because both route modules import this file already (they reach each other only dynamically),
// and a third hand-written copy is the drift this module exists to prevent.
export const ADMIN_CLASS_ROLE_CAPS = new Set<RoleCapability>(['delete', 'share', 'settings', 'publish', 'moderate'])

// The Record constraint below is load-bearing, not decoration: it is the COMPILE-TIME guard the two old
// tables had. Adding a capability to `SpaceCapability` (spaces.ts) or `RoleCapability` (roles.ts) without a
// row here must fail the build — otherwise the expansion silently returns NO tuples, and a revoke would
// delete nothing while answering 204 (a grant that cannot be taken away, reported as success).
export const SPACE_GRANT_RELATIONS = {
  // the #258 pair — a view grant writes both, so member-only visibility resolves without widening `viewer`
  view: ['viewer', 'viewer_member'],
  comment: ['commenter'], // #529 / ADR-193: the per-principal space comment leaf pages inherit
  edit: ['editor_member'],
  moderate: ['moderator'],
  delete: ['deleter'],
  share: ['sharer'],
  settings: ['settings_editor'],
  publish: ['publisher'],
  manage: ['manager'], // superset leaf — see the note above; never expanded into the bundle
  manageAccess: ['access_manager'], // ADR-209 (#607): the membership verb — built-in only, admin-class
} as const satisfies Record<SpaceCapability | RoleCapability, readonly string[]>

export type SpaceGrantCapability = keyof typeof SPACE_GRANT_RELATIONS

export function spaceGrantRelations(capability: string): readonly string[] | undefined {
  // `hasOwn`, not a bare index: this is an authz table, and a bare lookup answers truthily for inherited
  // keys like `constructor` (harmless today — the caller would throw — but not a property to rely on).
  return Object.hasOwn(SPACE_GRANT_RELATIONS, capability)
    ? SPACE_GRANT_RELATIONS[capability as SpaceGrantCapability]
    : undefined
}

// The tuples a grant of `capability` on `spaceId` writes for `grantee`. Both the built-in grant path and
// the custom-role assignment path build their writes from this, so a change lands on both at once.
export function spaceGrantTuplesFor(
  grantee: string,
  capability: string,
  spaceId: string,
): { user: string; relation: string; object: string }[] {
  const rels = spaceGrantRelations(capability)
  if (!rels) return []
  return rels.map((relation) => ({ user: grantee, relation, object: `space:${spaceId}` }))
}

// ADR-252 §1 / "Both operations" / #810: the FGA object ids `tenant_sweep_manifests.fga_object_ids`
// must hold before a reset destroys anything, so the executor can call `deleteObjectTuples` (already
// used elsewhere "when deleting a space or page to remove all FGA grants in one sweep",
// packages/authz/src/tuples.ts) per object without re-deriving the doomed set from a database that no
// longer has the rows to derive it from.
//
// `page: [space]` and `template: [space]`/`[page]`-shaped relations in infra/openfga/model.fga mean a
// space/page's OWN object entry carries the "belongs to this space/page" link tuple too (the FGA tuple
// for "page P is in space S" is `(user: space:S, relation: space, object: page:P)` — its OBJECT is the
// page, so `deleteObjectTuples(fga, 'page:P')` clears it along with every direct grant on P). Reset
// therefore needs no separate step for those links: collecting the object id is enough.
//
// Scoped conservatively — only the two object types §1's own text leaves unambiguous:
//   `space:<id>`   — DOOMED spaces only (kept spaces' space row, and its FGA object, survive)
//   `page:<id>`    — EVERY page (kept space or not — §1: "it empties the pages inside")
// NOT collected here:
//   `template:<id>` — this WAS left open pending a design question ("does a kept space's template get
//     swept along with its pages"), resolved by re-reading migration 051's own column comments while
//     answering it (see derive.ts's NAMED_EXCLUSIONS): a template's `body_md` is a FROZEN SNAPSHOT and
//     `source_page_id`/`space_id` are explicitly "no FK / no cascade — snapshot stays" by design. A
//     template survives its source page or space regardless, the same way `api_keys.space_ids` is
//     meant to go stale rather than be swept — not an open question any more, a "never" the schema
//     itself already answers. No `template:` object is ever collected here.
//   `group:<hash>` — reset does not touch member_connection_groups / group-sync data at all (members
//     and their group claims survive reset unconditionally), so no group object is affected.
//   `tenant:<id>`  — the tenant itself survives reset by definition; only §2 (full removal, not yet
//     built) touches it.
//
// Pure (no DB/FGA call) — deliberately: it takes the SAME `DoomedIds` `manifest-keys.ts`'s
// `collectResetStorageKeys` already derives its own way (reused here rather than a near-duplicate
// type — `spaceIds` is the doomed-only set, `pageIds` is every page, see that file's own doc comment
// for why they answer different questions), so this stays a formatting step over an already-computed
// scope rather than a second, possibly-divergent derivation of what's doomed.
import type { DoomedIds } from './manifest-keys.js'

export function collectResetFgaObjectIds(doomed: DoomedIds): string[] {
  return [
    ...doomed.spaceIds.map((id) => `space:${id}`),
    ...doomed.pageIds.map((id) => `page:${id}`),
  ]
}

// The polymorphic-table sweep (derive.ts's `derivePolymorphicTables`) needs the space/page IDS
// THEMSELVES (not the `space:`/`page:`-prefixed FGA object strings) to match `resource_id` correctly
// per §1's own warning: a `share_links` row with `resource_type = 'space'` must be matched against
// `doomed.spaceIds` ONLY (a kept space keeps its share links), while a `resource_type = 'page'` row is
// matched against the full `doomed.pageIds` set. `doomed` already carries exactly that distinction —
// this function exists so a caller doesn't have to know WHICH field maps to WHICH resource_type.
export function resourceIdSetsForPolymorphicSweep(doomed: DoomedIds): { space: readonly string[]; page: readonly string[] } {
  return { space: doomed.spaceIds, page: doomed.pageIds }
}

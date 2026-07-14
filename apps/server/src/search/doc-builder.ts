import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { checkRelation } from '@wikistead/authz'
import type { SearchDoc } from '@wikistead/types'

// #218 / ADR-103: how deep the inherited-grant walk goes (matches MAX_PAGE_DEPTH — the create/move depth guard),
// so a member granted on an ancestor folder is denormalised as a viewer of a deep descendant.
const MAX_ANCESTOR_WALK = 11

// #218 / ADR-103: the DIRECT grant leaves (member/group/link grants live here now — they cascade down the
// parent chain). `comment` keeps its own direct types. `view_base@user:*` (public) is read separately.
const DIRECT_GRANT_RELATIONS = ['manage_direct', 'edit_direct', 'view_direct', 'comment']

interface PageRow { id: string; tenant_id: string; space_id: string; title: string; published_md: string | null; updated_at: Date }

function categorize(
  user: string,
  viewerUsers: Set<string>,
  viewerGroups: Set<string>,
  setPublic: () => void,
) {
  if (user === 'user:*') { setPublic(); return }
  if (user.startsWith('share_link:')) return  // anonymous links excluded from viewer set
  if (user.startsWith('user:')) { viewerUsers.add(user); return }
  // "group:G#member" → strip #member → viewerGroups records the group id
  if (user.includes('#member')) { viewerGroups.add(user.replace(/#member$/, '')); return }
}

// Build a Meilisearch document by reading FGA tuples to compute viewer sets
// and taking the body from the page's PUBLISHED content (published_md) — the live
// draft is never indexed.
// Returns null if the page no longer exists (caller should issue a 'delete' instead).
//
// FGA is read 3 times (space, page, tenant tuples). Acceptable at Phase 0 data volume.
// TODO(phase: search): batch into a single ListObjects call or cache space/tenant
//   tuple reads when page count per space grows large.
export async function buildSearchDoc(
  pool: Sql,
  fga: OpenFgaClient,
  pageId: string,
  tenantId: string,
): Promise<SearchDoc | null> {
  // Use pool.begin with SET LOCAL so RLS filters to the correct tenant.
  const page = await (pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const [r] = await tx<PageRow[]>`
      SELECT id, tenant_id, space_id, title, published_md, updated_at FROM pages WHERE id = ${pageId}
    `
    return r ?? null
  }) as Promise<PageRow | null>)

  if (!page) return null

  const viewerUsers = new Set<string>()
  const viewerGroups = new Set<string>()
  let isPublic = false
  const setPublic = () => { isPublic = true }

  // 1. Page-level grants. Direct view/edit/manage grants always apply; the
  //    `page#space` link (written only at publish — the visibility gate) tells us
  //    whether SPACE inheritance is active. A DRAFT has no page#space, so space
  //    members must NOT be denormalized as viewers (else an unpublished page's title
  //    would surface to space members in stage-1 search). stage-2 FGA is the real
  //    gate, but excluding them from stage-1 keeps drafts out of space search.
  const { tuples: pageTuples } = await fga.read({ object: `page:${pageId}` })
  let linkedToSpace = false
  let parentId: string | null = null
  for (const { key } of pageTuples ?? []) {
    if (!key) continue
    if (key.relation === 'space' && key.user === `space:${page.space_id}`) { linkedToSpace = true; continue }
    // #218 / ADR-103: this page's parent (for the inherited-grant walk below).
    if (key.relation === 'parent' && key.user?.startsWith('page:')) { parentId = key.user.slice('page:'.length); continue }
    // is_public: the public grant is still the DIRECT `view_base@user:*` tuple (view_base keeps user:* as a
    // direct type; only member/group/link grants moved to the *_direct leaves). Read it for is_public.
    if (key.relation === 'view_base' && key.user === 'user:*') { setPublic(); continue }
    // #218 / ADR-103: direct member/group/link view/edit/manage grants live on the *_direct LEAVES now; a
    // direct `comment` grant also confers view (comment ⊃ view). Only DIRECT grants denormalize (computed
    // view/edit/manage and view_base@user:* handled separately).
    if (!DIRECT_GRANT_RELATIONS.includes(key.relation)) continue
    categorize(key.user, viewerUsers, viewerGroups, setPublic)
  }

  // #218 / ADR-103: EFFECTIVE private — the page's own marker OR one inherited from a private ANCESTOR
  // (`private: [...] or private from parent`). A single FGA check resolves the whole chain (probe user matches
  // the `[user:*]` direct type), so this never drifts from the model. Effective-private cuts space inheritance
  // in the denorm (below) exactly as the model cuts view_base_from_space `but not private`.
  const isPrivate = (await checkRelation(fga, 'user:__isprivate_probe__', 'private', { type: 'page', id: pageId })) === true
  if (isPrivate) isPublic = false // effective-private is never public (belt; the write-boundary also strips the grant)

  // #218 / ADR-103: INHERITED direct grants — a grant on an ancestor folder cascades to this page
  // (`view_direct from parent` etc.), so a folder-granted member must be denormalised as a viewer here too or
  // stage-1 search would drop them (decision 1, index-side inheritance). Walk the parent chain (bounded by
  // MAX_ANCESTOR_WALK) collecting each ancestor's *_direct grants. Public (view_base@user:*) does NOT cascade,
  // so ancestor grants never set is_public. Inherited direct grants are NOT gated by private (they apply on a
  // private child by design — the corrected DSL cascades the *_direct leaf regardless of private).
  // #218 / ADR-103 addendum (DRAFT GATE): the inherited-grant cascade is `*_from_parent AND published`, so it
  // applies ONLY to a PUBLISHED page. A draft (no page#space) does NOT receive ancestor grants — mirror that
  // here (`linkedToSpace`) so a folder-granted member is never denormalised onto an unpublished child.
  let ancestor = linkedToSpace ? parentId : null
  for (let depth = 0; ancestor && depth < MAX_ANCESTOR_WALK; depth++) {
    const { tuples: ancTuples } = await fga.read({ object: `page:${ancestor}` })
    let next: string | null = null
    for (const { key } of ancTuples ?? []) {
      if (!key) continue
      if (key.relation === 'parent' && key.user?.startsWith('page:')) { next = key.user.slice('page:'.length); continue }
      if (!DIRECT_GRANT_RELATIONS.includes(key.relation)) continue
      categorize(key.user, viewerUsers, viewerGroups, () => {}) // ancestor grants never make the child public
    }
    ancestor = next
  }

  // 2. Space inheritance + tenant admins — ONLY for a PUBLISHED page (page#space
  //    present) that is NOT (effective-)private (ADR-098/#218 cuts space inheritance). For a draft
  //    (or a private page) these are withheld, matching the FGA `view` graph exactly.
  if (linkedToSpace && !isPrivate) {
    const { tuples: spaceTuples } = await fga.read({ object: `space:${page.space_id}` })
    for (const { key } of spaceTuples ?? []) {
      if (!key || !['manager', 'editor', 'viewer'].includes(key.relation)) continue
      categorize(key.user, viewerUsers, viewerGroups, setPublic)
    }
    const { tuples: tenantTuples } = await fga.read({ object: `tenant:${tenantId}` })
    for (const { key } of tenantTuples ?? []) {
      if (!key || key.relation !== 'admin') continue
      categorize(key.user, viewerUsers, viewerGroups, setPublic)
    }
  }

  // Index the PUBLISHED body only — never the live draft. published_md is set by
  // POST /pages/:id/publish; it is null/'' until first publish, so a draft's
  // in-progress content is never searchable until the author publishes it.
  const body = page.published_md ?? ''

  return {
    id: pageId,
    tenantId: page.tenant_id,
    spaceId: page.space_id,
    title: page.title,
    body,
    viewerUsers: [...viewerUsers],
    viewerGroups: [...viewerGroups],
    isPublic,
    updatedAt: page.updated_at.getTime(),
  }
}

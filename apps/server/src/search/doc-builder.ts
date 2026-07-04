import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import type { SearchDoc } from '@wikistead/types'

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
  let isPrivate = false // #109 / ADR-098: a private page cuts space inheritance — see below
  for (const { key } of pageTuples ?? []) {
    if (!key) continue
    if (key.relation === 'space' && key.user === `space:${page.space_id}`) { linkedToSpace = true; continue }
    // #109 / ADR-098: the private marker (private@user:*) cuts space inheritance for this page, so space
    // members must NOT be denormalised as viewers (only the direct grants below are the allow list). This
    // keeps stage-1 accurate — a member who lost access on privatisation drops from search immediately,
    // not only at the stage-2 FGA gate. Not a viewer/public tuple itself, so it never enters the sets.
    if (key.relation === 'private' && key.user === 'user:*') { isPrivate = true; continue }
    // #100 / ADR-029: `view` is now a computed relation (view_base or comment); direct page view
    // grants live on `view_base`, so read THAT for the viewer set + is_public (view_base@user:*). A
    // direct `comment` grant also confers view (comment ⊃ view), so a comment-granted member is a
    // viewer too. `comment_open`/`view` (computed) are NOT read here — only direct grants denormalize.
    if (!['manage', 'edit', 'view_base', 'comment'].includes(key.relation)) continue
    categorize(key.user, viewerUsers, viewerGroups, setPublic)
  }

  // 2. Space inheritance + tenant admins — ONLY for a PUBLISHED page (page#space
  //    present) that is NOT private (ADR-098 cuts space inheritance). For a draft
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

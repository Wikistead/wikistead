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

  // 1. Space-level direct grants (viewer/editor/manager → all grant view access)
  const { tuples: spaceTuples } = await fga.read({ object: `space:${page.space_id}` })
  for (const { key } of spaceTuples ?? []) {
    if (!key || !['manager', 'editor', 'viewer'].includes(key.relation)) continue
    categorize(key.user, viewerUsers, viewerGroups, setPublic)
  }

  // 2. Page-level direct grants (view/edit/manage); share_link subjects excluded
  const { tuples: pageTuples } = await fga.read({ object: `page:${pageId}` })
  for (const { key } of pageTuples ?? []) {
    if (!key || !['manage', 'edit', 'view'].includes(key.relation)) continue
    categorize(key.user, viewerUsers, viewerGroups, setPublic)
  }

  // 3. Tenant admins (have manager access on all spaces via model inheritance)
  const { tuples: tenantTuples } = await fga.read({ object: `tenant:${tenantId}` })
  for (const { key } of tenantTuples ?? []) {
    if (!key || key.relation !== 'admin') continue
    categorize(key.user, viewerUsers, viewerGroups, setPublic)
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

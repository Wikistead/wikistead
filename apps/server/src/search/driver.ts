import { MeiliSearch } from 'meilisearch'
import type { SearchDoc } from '@kb/types'

export interface SearchHit {
  id: string
  tenantId: string
  spaceId: string
  title: string
}

export interface SearchDriver {
  // Called at app startup to configure index settings (idempotent).
  ensureIndex(): Promise<void>
  search(params: {
    tenantId: string
    userId: string
    groups: string[]
    q: string
    spaceId?: string
  }): Promise<SearchHit[]>
  upsertDoc(doc: SearchDoc): Promise<void>
  deleteDoc(pageId: string): Promise<void>
}

// Logical isolation: all tenants share a single 'pages' index.
// tenant_id attribute + filter enforces per-tenant scoping at query time.
//
// TODO(phase: tenancy-namespace): NamespaceSearchDriver routes to a dedicated
// index (pages_<tenantId>) or separate Meilisearch instance for namespace tenants.
export class LogicalSearchDriver implements SearchDriver {
  private readonly client: MeiliSearch
  private readonly INDEX = 'pages'

  constructor() {
    this.client = new MeiliSearch({
      host: process.env.MEILI_HOST ?? 'http://localhost:7700',
      apiKey: process.env.MEILI_MASTER_KEY,
    })
  }

  // Configure filterable/searchable attributes. Awaits task completion so the
  // index is ready before the app starts serving search requests.
  async ensureIndex(): Promise<void> {
    const index = this.client.index(this.INDEX)
    const t1 = await index.updateFilterableAttributes([
      'tenantId', 'viewerUsers', 'viewerGroups', 'isPublic', 'spaceId',
    ])
    const t2 = await index.updateSearchableAttributes([
      'title',
      // TODO(phase: collab): add 'body' after ydoc snapshot persistence is added
    ])
    await this.client.waitForTasks([t1.taskUid, t2.taskUid])
  }

  async search({ tenantId, userId, groups, q, spaceId }: {
    tenantId: string; userId: string; groups: string[]
    q: string; spaceId?: string
  }): Promise<SearchHit[]> {
    // Tenant isolation via filter (single shared index, no per-tenant indexes).
    // Phase 0: server-side proxy only; no client-side Meilisearch tenant tokens yet.
    // TODO(phase: tenancy-namespace): route to NamespaceSearchDriver when tenant.isolation === 'namespace'
    const visibilityFilter = [
      `viewerUsers = "user:${userId}"`,
      ...groups.map(g => `viewerGroups = "group:${g}"`),
      'isPublic = true',
    ].join(' OR ')

    const filters = [`tenantId = "${tenantId}"`, `(${visibilityFilter})`]
    if (spaceId) filters.push(`spaceId = "${spaceId}"`)

    const index = this.client.index(this.INDEX)
    const result = await index.search<SearchDoc>(q, {
      filter: filters.join(' AND '),
      limit: 20,
      attributesToRetrieve: ['id', 'tenantId', 'spaceId', 'title'],
    })
    return result.hits as SearchHit[]
  }

  async upsertDoc(doc: SearchDoc): Promise<void> {
    // Wait for the indexing task so the document is immediately searchable
    // after this call returns. Required for test reliability; also correct
    // in production since the caller (processOutboxAsync) is fire-and-forget.
    // primaryKey must be explicit: Meilisearch auto-detection fails when multiple
    // fields end with 'id' (e.g. 'id' and 'tenantId').
    const task = await this.client.index(this.INDEX).addDocuments([doc], { primaryKey: 'id' })
    await this.client.waitForTask(task.taskUid)
  }

  async deleteDoc(pageId: string): Promise<void> {
    const task = await this.client.index(this.INDEX).deleteDocument(pageId)
    await this.client.waitForTask(task.taskUid)
  }
}

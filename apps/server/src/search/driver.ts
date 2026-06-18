// SearchDriver and SearchHit are the CE-published extension point defined in
// @kb/hooks. LogicalSearchDriver is CE's built-in implementation.
// EE registers an alternative via registerSearchDriver() from @kb/hooks.
import { MeiliSearch } from 'meilisearch'
import type { SearchDoc } from '@kb/types'
import type { SearchDriver, SearchHit } from '@kb/hooks'

export type { SearchDriver, SearchHit }

// Logical isolation: all tenants share a single 'pages' index.
// TODO(phase: tenancy-namespace): NamespaceSearchDriver in a dedicated
// index / Meilisearch instance for namespace-isolated tenants.
export class LogicalSearchDriver implements SearchDriver {
  private readonly client: MeiliSearch
  private readonly INDEX = 'pages'

  constructor() {
    this.client = new MeiliSearch({
      host: process.env.MEILI_HOST ?? 'http://localhost:7700',
      apiKey: process.env.MEILI_MASTER_KEY,
    })
  }

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
    tenantId: string; userId: string; groups: string[]; q: string; spaceId?: string
  }): Promise<SearchHit[]> {
    // TODO(phase: tenancy-namespace): route to NamespaceSearchDriver
    const visibilityFilter = [
      `viewerUsers = "user:${userId}"`,
      ...groups.map(g => `viewerGroups = "group:${g}"`),
      'isPublic = true',
    ].join(' OR ')
    const filters = [`tenantId = "${tenantId}"`, `(${visibilityFilter})`]
    if (spaceId) filters.push(`spaceId = "${spaceId}"`)

    const result = await this.client.index(this.INDEX).search<SearchDoc>(q, {
      filter: filters.join(' AND '),
      limit: 20,
      attributesToRetrieve: ['id', 'tenantId', 'spaceId', 'title'],
    })
    return result.hits as SearchHit[]
  }

  async upsertDoc(doc: SearchDoc): Promise<void> {
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

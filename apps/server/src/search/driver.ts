// SearchDriver and SearchHit are the CE-published extension point defined in
// @wikistead/hooks. LogicalSearchDriver is CE's built-in implementation.
// EE registers an alternative via registerSearchDriver from @wikistead/hooks.
import { MeiliSearch } from 'meilisearch'
import type { SearchDoc } from '@wikistead/types'
import type { SearchDriver, SearchHit } from '@wikistead/hooks'
import { SEARCH_CANDIDATE_LIMIT } from './paginate.js'

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
      // Order = ranking priority: title outranks body. body is the page text
      // extracted from the ydoc snapshot (doc-builder). Making it searchable is
      // what enables in-body matches, including CJK — Meili's default tokenizer
      // segments Japanese (charabia/lindera), so matches body .
      'title',
      'body',
    ])
    // CJK / Japanese tokenization (#115): pin the segmenter for title + body to the CJK
    // locales + English instead of relying on per-document language auto-detection, which is
    // unreliable for short or mixed-script text (a 2-3 char Japanese query, or JP body with a
    // few ASCII words). localizedAttributes (Meili 1.10) applies the jpn/cmn/kor segmenters
    // deterministically so reliably matches a body containing it.
    const t3 = await index.updateLocalizedAttributes([
      { attributePatterns: ['title', 'body'], locales: ['jpn', 'cmn', 'kor', 'eng'] },
    ])
    await this.client.waitForTasks([t1.taskUid, t2.taskUid, t3.taskUid])
  }

  async search({ tenantId, userId, groups, q, spaceId, offset, limit }: {
    tenantId: string; userId: string; groups: string[]; q: string; spaceId?: string; offset?: number; limit?: number
  }): Promise<SearchHit[]> {
    // TODO(phase: tenancy-namespace): route to NamespaceSearchDriver
    const visibilityFilter = [
      `viewerUsers = "user:${userId}"`,
      ...groups.map(g => `viewerGroups = "group:${g}"`),
      'isPublic = true',
    ].join(' OR ')
    const filters = [`tenantId = "${tenantId}"`, `(${visibilityFilter})`]
    if (spaceId) filters.push(`spaceId = "${spaceId}"`)

    // Crop a plain-text body excerpt around the match for the result snippet. No
    // attributesToHighlight → _formatted.body is cropped but NOT marked up, so the
    // UI renders it as text (no XSS). cropLength is a placeholder (tune later).
    const result = await this.client.index(this.INDEX).search<SearchDoc>(q, {
      filter: filters.join(' AND '),
      limit: limit ?? SEARCH_CANDIDATE_LIMIT, // over-fetch candidates for stage-2 FGA paging (ADR-027)
      offset: offset ?? 0,                    // #103/ADR-068: deep pagination resumes a ranked scan
      attributesToRetrieve: ['id', 'tenantId', 'spaceId', 'title'],
      attributesToCrop: ['body'],
      cropLength: 30,
    })
    return result.hits.map((h) => {
      const snippet = (h as { _formatted?: { body?: string } })._formatted?.body?.trim()
      const hit: SearchHit = { id: h.id, tenantId: h.tenantId, spaceId: h.spaceId, title: h.title }
      if (snippet) hit.snippet = snippet
      return hit
    })
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

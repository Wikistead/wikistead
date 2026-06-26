// #115: CJK/Japanese tokenization. ensureIndex pins the jpn/cmn/kor/eng segmenter on
// title+body (localizedAttributes), so a Japanese substring query matches Japanese body
// text. Real Meilisearch (shared 'pages' index; a unique tenantId isolates this test's docs).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SearchDoc } from '@wikistead/types'
import { LogicalSearchDriver } from '../search/index.js'

const driver = new LogicalSearchDriver()
const tenantId = `t-cjk-${Date.now().toString(36)}`
const docId = `cjk-${Date.now().toString(36)}`
const USER = 'cjk-viewer'

const doc: SearchDoc = {
  id: docId,
  tenantId,
  spaceId: 'cjk-space',
  title: '観光スポット',
  body: '東京都庁とスカイツリーは東京の名所です。Tokyo SkyTree is famous.',
  viewerUsers: [`user:${USER}`],
  viewerGroups: [],
  isPublic: false,
  updatedAt: 1,
}

beforeAll(async () => {
  await driver.ensureIndex()
  await driver.upsertDoc(doc) // waits for indexing
})

afterAll(async () => {
  await driver.deleteDoc(docId)
})

const find = (q: string) => driver.search({ tenantId, userId: USER, groups: [], q })

describe('#115 CJK/Japanese tokenization', () => {
  it('localizedAttributes pins the CJK + English segmenter on title/body', async () => {
    const settings = await new LogicalSearchDriver()['client'].index('pages').getLocalizedAttributes()
    expect(settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributePatterns: expect.arrayContaining(['title', 'body']) }),
    ]))
    const locales = (settings ?? []).flatMap((s) => s.locales)
    expect(locales).toEqual(expect.arrayContaining(['jpn', 'eng']))
  })

  it('matches a Japanese substring inside the body (スカイツリー)', async () => {
    const hits = await find('スカイツリー')
    expect(hits.map((h) => h.id)).toContain(docId)
  })

  it('matches a short Japanese token (東京)', async () => {
    const hits = await find('東京')
    expect(hits.map((h) => h.id)).toContain(docId)
  })

  it('still matches embedded English (SkyTree)', async () => {
    const hits = await find('SkyTree')
    expect(hits.map((h) => h.id)).toContain(docId)
  })
})

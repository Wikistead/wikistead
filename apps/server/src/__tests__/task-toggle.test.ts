// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// ADR-019: the no-revision task-checkbox toggle. The load-bearing guarantees (authz-
// critical — D3/D4 are security boundaries):
//   - edit-gated: a non-editor is rejected (403),
//   - the "checkbox-only diff" guard rejects (409) any draft that differs from the
//     published snapshot by anything other than the single expected checkbox flip
//     (so the no-revision path cannot smuggle real content past history),
//   - a successful toggle updates published_md but creates NO revision,
//   - a single checkbox flip succeeds even though the page is "dirty" by exactly that
//     flip (the normal success path).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage, getPublished, toggleTask } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

const BASE = `# Tasks\n\n- [ ] alpha\n- [ ] beta\n` // two unchecked task items: index 0, 1
// Simulate a collab draft save: persist ydoc + set the unpublished flag (as storeYdoc does).
const setDraft = (pageId: string, text: string) =>
  admin`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))}, has_unpublished_changes = true WHERE id = ${pageId}`
const revisionCount = async (pageId: string) =>
  (await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM revisions WHERE page_id = ${pageId}`)[0].n

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  const space = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'task-toggle-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Task Toggle' })
  pageId = page.id
  // Publish the baseline so published_md == draft (both unchecked). revisions = 1.
  await setDraft(pageId, BASE)
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
}, 30_000)

afterAll(async () => {
  await app.searchDriver.deleteDoc(pageId).catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

// NOTE: the success case runs LAST so published_md stays the unchecked baseline while
// the 409 cases compare against it.
describe('task-checkbox toggle (no-revision, ADR-019)', () => {
  it('is edit-gated: a non-editor is rejected (403)', async () => {
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\n`) // a valid single flip…
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:toggle-rando-xyz', createdBy: 'user:toggle-rando-xyz', index: 0 }))
      .rejects.toMatchObject({ statusCode: 403 }) // …still 403: FGA edit is checked first
  })

  it('rejects (409) when the draft mixes in non-checkbox changes', async () => {
    // a checkbox flip PLUS other content — must not slip a real edit past history
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\nstealth edit\n`)
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 })
  })

  it('rejects (409) when nothing flipped, or the flip is not at the claimed index', async () => {
    await setDraft(pageId, BASE) // identical to published → zero flips
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 })
    await setDraft(pageId, `# Tasks\n\n- [ ] alpha\n- [x] beta\n`) // beta (index 1) flipped…
    await expect(toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0 }))
      .rejects.toMatchObject({ statusCode: 409 }) // …but index 0 claimed → reject
  })

  // #830: the two causes of "the claimed box is not flipped in the draft" need different answers.
  //
  // `task_burst` was written for the fast clicker — a sibling request already folded this flip, so the
  // client keeps what the user is looking at, correctly, because the flip IS published. The other
  // cause is that the flip never reached the draft at all (the live document could not carry it), and
  // there the client is keeping a tick that stands for nothing. Reproduced in a real browser with the
  // collaboration socket refused: the box stayed ticked and `published_md` still read `- [ ] ship it`.
  //
  // The snapshots cannot tell them apart — both are "draft and published agree here" — so the caller
  // says which state it flipped TO, and that is the whole difference.
  describe('#830: a flip that never arrived is not a burst', () => {
    it('the desired state matching published is a BURST (somebody folded it) — keep the tick', async () => {
      // published holds `[ ] alpha`. A caller moving TO `false` is asking for what published already
      // says, so somebody folded a tick and then a sibling untick: nothing to do, nothing lost.
      await setDraft(pageId, BASE)
      await expect(toggleTask(db, fgaClient, app.searchDriver, {
        pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0, to: false,
      })).rejects.toMatchObject({ statusCode: 409, code: 'task_burst' })
    })

    it('the desired state DIFFERING from published means it never arrived — say so', async () => {
      // The caller is moving TO `true` (a tick), the draft never received it, and published still holds
      // `[ ]`. This is the state that leaves a tick on screen with nothing behind it.
      await setDraft(pageId, BASE)
      await expect(toggleTask(db, fgaClient, app.searchDriver, {
        pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0, to: true,
      })).rejects.toMatchObject({ statusCode: 409, code: 'task_not_stored' })
    })

    it('a caller that says nothing gets the old answer', async () => {
      // A tab open across a deploy sends no `to`. It must not meet a code it has never heard of.
      await setDraft(pageId, BASE)
      await expect(toggleTask(db, fgaClient, app.searchDriver, {
        pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0,
      })).rejects.toMatchObject({ statusCode: 409, code: 'task_burst' })
    })

    it('an index published has never heard of stays a burst, not a lost flip', async () => {
      // A stale or fabricated index is not evidence that anything went missing, and answering
      // `task_not_stored` there would make the client revert a box it cannot even see.
      await setDraft(pageId, BASE)
      await expect(toggleTask(db, fgaClient, app.searchDriver, {
        pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 99, to: true,
      })).rejects.toMatchObject({ statusCode: 409, code: 'task_burst' })
    })

    it('a flip that DID arrive still succeeds with the state attached', async () => {
      // The break-check for the whole thing: the new argument must not turn the ordinary success path
      // into a refusal. ⚠️ On its OWN page — this one folds a flip into published, and the file's
      // remaining 409 cases compare against the shared page's unchecked baseline (see the note above
      // `describe`, which is the reason the original success case runs last).
      const own = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Task Toggle 830' })
      try {
        await setDraft(own.id, BASE)
        await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: own.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
        await setDraft(own.id, `# Tasks\n\n- [x] alpha\n- [ ] beta\n`)
        await expect(toggleTask(db, fgaClient, app.searchDriver, {
          pageId: own.id, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0, to: true,
        })).resolves.toBeTruthy()
        expect((await getPublished(db, fgaClient, { pageId: own.id, subject: 'user:dev-user' })).publishedMd).toContain('- [x] alpha')
      } finally {
        await app.searchDriver.deleteDoc(own.id).catch(() => {})
        await admin`DELETE FROM revisions WHERE page_id = ${own.id}`.catch(() => {})
        await admin`DELETE FROM search_outbox WHERE page_id = ${own.id}`.catch(() => {})
        await admin`DELETE FROM checkbox_events WHERE page_id = ${own.id}`.catch(() => {})
        await admin`DELETE FROM pages WHERE id = ${own.id}`.catch(() => {})
      }
    })
  })

  it('a single checkbox flip succeeds, updates published_md, and creates NO revision', async () => {
    const before = await revisionCount(pageId)
    expect(before).toBe(1) // just the baseline publish
    // the page is now "dirty" by exactly one flip (alpha checked) — the success path
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [ ] beta\n`)
    await toggleTask(db, fgaClient, app.searchDriver, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 0 })

    const pub = await getPublished(db, fgaClient, { pageId, subject: 'user:dev-user' })
    expect(pub.publishedMd).toContain('- [x] alpha')
    expect(pub.publishedMd).toContain('- [ ] beta')
    expect(pub.hasUnpublishedChanges).toBe(false) // draft == published again
    expect(await revisionCount(pageId)).toBe(before) // NO new revision — history unpolluted

    // #97 / ADR-019 D2: a lightweight audit row records who/which/state — NOT a revision.
    const [ev] = await admin<[{ actor: string; checkbox_index: number; checked: boolean }]>`
      SELECT actor, checkbox_index, checked FROM checkbox_events WHERE page_id = ${pageId} ORDER BY created_at DESC LIMIT 1`
    expect(ev).toMatchObject({ actor: 'user:dev-user', checkbox_index: 0, checked: true })
  })

  // #481: the fold takes every pending flip, so a fast clicker publishes N changes through one
  // call. The ledger used to record only the index that arrived with the request and lose the rest,
  // which is the one thing an audit row exists not to do.
  it('records ONE audit row per folded flip, not one per request (#481)', async () => {
    // its own page: the fold refuses a draft whose task skeleton differs from published, so this needs
    // a three-checkbox baseline — and the other cases here share one page and expect the two-checkbox
    // one they were written against
    const burst = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Task Burst Audit' })
    try {
      await setDraft(burst.id, `# Tasks\n\n- [ ] alpha\n- [ ] beta\n- [ ] gamma\n`)
      await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: burst.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })

      // three flips land in the draft before the request that folds them — the burst shape
      await setDraft(burst.id, `# Tasks\n\n- [x] alpha\n- [x] beta\n- [x] gamma\n`)
      await toggleTask(db, fgaClient, app.searchDriver, { pageId: burst.id, subject: 'user:dev-user', createdBy: 'user:dev-user', index: 2 })

      const rows = await admin<{ checkbox_index: number; checked: boolean }[]>`
        SELECT checkbox_index, checked FROM checkbox_events WHERE page_id = ${burst.id} ORDER BY checkbox_index ASC`
      expect(rows.length, 'three folded flips leave three rows, not the one that carried the request').toBe(3)
      expect(rows.map((r) => r.checkbox_index), 'every folded index is named').toEqual([0, 1, 2])
      expect(rows.every((r) => r.checked), 'each row carries the state it was folded to').toBe(true)
    } finally {
      await app.searchDriver.deleteDoc(burst.id).catch(() => {})
      await admin`DELETE FROM checkbox_events WHERE page_id = ${burst.id}`.catch(() => {})
      await admin`DELETE FROM revisions WHERE page_id = ${burst.id}`.catch(() => {})
      await admin`DELETE FROM search_outbox WHERE page_id = ${burst.id}`.catch(() => {})
      await admin`DELETE FROM pages WHERE id = ${burst.id}`.catch(() => {})
    }
  })

  // #97 (review fix): the audit `actor` is the human-readable principal (createdBy =
  // `guest:`/`user:`), matching the revision attribution label — NOT the FGA `subject`
  // (`share_link:`). principalForPage ties subject↔createdBy; here we pass them split to prove
  // the INSERT records createdBy, not subject. (subject still gates the FGA edit check.)
  it('records the audit actor as createdBy (guest:), not the FGA subject (share_link:)', async () => {
    // published is now `[x] alpha, [ ] beta` (from the prior success case); flip beta (index 1).
    await setDraft(pageId, `# Tasks\n\n- [x] alpha\n- [x] beta\n`)
    await toggleTask(db, fgaClient, app.searchDriver, {
      pageId, subject: 'user:dev-user', createdBy: 'guest:demo-share-link', index: 1,
    })
    const [ev] = await admin<[{ actor: string; checkbox_index: number }]>`
      SELECT actor, checkbox_index FROM checkbox_events WHERE page_id = ${pageId} ORDER BY created_at DESC LIMIT 1`
    expect(ev).toMatchObject({ actor: 'guest:demo-share-link', checkbox_index: 1 })
    expect(ev.actor).not.toMatch(/^share_link:/)
  })
})

// Taking a page out of public view must not report success while anyone can still read it.
//
// `view_base`'s `[user:*]` arm is NOT `but not private` (model.fga): public⊥private holds at the WRITE
// boundary and nowhere else, and routes/public.ts authorises anonymous reads off that very tuple. So every
// path that removes the public grant is the only thing standing between "the caller pressed the button"
// and "the page is still world-readable" — and each of them swallowed EVERY failure, not just the harmless
// "it was not public anyway".
//
// Measured before the fix, with a store that refuses writes: unsetPagePublic returned normally, wrote
// `page.made_non_public` to the audit ledger, fired the webhook, and `check(user:anonymous, view, page)`
// was still true. The tests below assert on that check — the access itself — rather than on a status code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { onDomainEvent } from '@wikistead/events'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace, setSpacePublic, unsetSpacePublic } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePublic, unsetPagePublic, setPagePrivate, movePage } from '../routes/pages.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
const pages: string[] = []
const spaces: string[] = []

// A client that cannot write. This is what "the store is unavailable" or "the model moved" looks like from
// inside a route — the case the swallows turned into success.
const refusing = () => Object.assign(Object.create(Object.getPrototypeOf(fgaClient) as object), fgaClient, {
  write: async () => { throw new Error('the permission store is unavailable') },
}) as typeof fgaClient

// …and one that refuses ONLY deletes. #622's re-review found the blunt client above never reached the code
// under test on the paths that WRITE first: setPagePrivate's marker write threw before the strip ran, so
// reverting the strip changed nothing the tests could see. A store that accepts writes and refuses deletes
// is also the more realistic failure (a stale model rejects the relation being deleted), and it is the only
// way to reach a strip that runs AFTER a successful write.
const refusingDeletes = () => Object.assign(Object.create(Object.getPrototypeOf(fgaClient) as object), fgaClient, {
  write: async (body: { deletes?: unknown[] }, ...rest: unknown[]) => {
    if (body?.deletes?.length) throw new Error('the permission store is unavailable')
    return (fgaClient.write as (b: unknown, ...r: unknown[]) => Promise<unknown>).call(fgaClient, body, ...rest)
  },
}) as typeof fgaClient

async function freshPublicPage(tag: string): Promise<string> {
  const { id } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-${tag}-${STAMP}` })
  pages.push(id)
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  await setPagePublic(db, fgaClient, app.searchDriver, { pageId: id, tenantId: TENANT, userId: OWNER, plan: 'business' })
  return id
}

const anyoneCanRead = (pageId: string) => check(fgaClient, 'user:anonymous', 'view', { type: 'page', id: pageId })

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `pgr-${STAMP}` })).id
}, 180_000)

afterAll(async () => {
  for (const id of pages.reverse()) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: OWNER }).catch(() => {})
  for (const id of spaces) await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: id, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  for (const id of pages) await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

async function auditCount(pageId: string): Promise<number> {
  await drainAuditFor(admin, TENANT)
  const [{ n }] = await admin<[{ n: string }]>`
    SELECT count(*)::text AS n FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`page:${pageId}`}
      AND action IN ('page.made_non_public', 'page.made_private')`
  return Number(n)
}

async function eventsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const off = onDomainEvent((e) => { if (e.type === 'page.made_non_public' || e.type === 'page.made_private') seen.push(e.type) })
  try { await fn().catch(() => {}) } finally { off() }
  return seen
}

describe('a refused removal is not reported as a removal', () => {
  it('unsetPagePublic: the caller hears it, and the ledger is not written', async () => {
    const pageId = await freshPublicPage('unset')
    expect(await anyoneCanRead(pageId), 'public to begin with').toBe(true)
    const before = await auditCount(pageId)

    const events = await eventsDuring(() =>
      unsetPagePublic(db, refusing(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    expect(await anyoneCanRead(pageId), 'still public — that is the truth to report').toBe(true)
    expect(events, 'no event for a removal that did not happen').toEqual([])
    expect(await auditCount(pageId) - before, 'no audit line either').toBe(0)
    await expect(
      unsetPagePublic(db, refusing(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }),
      'and the call itself fails',
    ).rejects.toThrow()
  }, 180_000)

  it('setPagePrivate: the marker lands, the grant does not — and it does NOT pass as private', async () => {
    // The strip runs after a successful marker write, so this needs the delete-only refusal: with the
    // blunt client the marker threw first and the code under test never ran (measured in the #622
    // re-review, which is why this test used to pass with the fix reverted).
    const pageId = await freshPublicPage('private')
    const events = await eventsDuring(() =>
      setPagePrivate(db, refusingDeletes(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    expect(await anyoneCanRead(pageId), 'the grant survived, so anyone can still read it').toBe(true)
    expect(events, 'and nothing called it private').toEqual([])
    await expect(
      setPagePrivate(db, refusingDeletes(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }),
      'the caller is told, rather than being handed a page that is private in name only',
    ).rejects.toThrow(/public grant/i)
  }, 180_000)

  it('unsetSpacePublic: the widest one — a space grant that survived is not reported as removed', async () => {
    // `view_base_from_space` is `viewer from space but not private`, so this single tuple opens every
    // non-private published page under the space. The per-page fix does not cover it; this is the fifth
    // site, found in the #622 re-review after the first sweep only walked pages.ts.
    const openSpace = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `pgr-space-${STAMP}` })).id
    spaces.push(openSpace)
    const { id: pageId } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: openSpace, userId: OWNER, title: `pgr-inspace-${STAMP}` })
    pages.push(pageId)
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
    await setSpacePublic(db, fgaClient, app.searchDriver, { spaceId: openSpace, tenantId: TENANT, userId: OWNER, plan: 'business' })
    expect(await anyoneCanRead(pageId), 'the page is readable through the space grant').toBe(true)

    let spaceEvents = 0
    const off = onDomainEvent((e) => { if (e.type === 'space.made_non_public') spaceEvents++ })
    await unsetSpacePublic(db, refusingDeletes(), app.searchDriver, { spaceId: openSpace, tenantId: TENANT, userId: OWNER, plan: 'business' })
      .catch(() => {})
    off()

    expect(await anyoneCanRead(pageId), 'still readable through the space — that is what to report').toBe(true)
    expect(spaceEvents, 'no event for a removal that did not happen').toBe(0)
    await expect(
      unsetSpacePublic(db, refusingDeletes(), app.searchDriver, { spaceId: openSpace, tenantId: TENANT, userId: OWNER, plan: 'business' }),
      'and the call fails rather than answering success',
    ).rejects.toThrow()
    // clean: really take it out of public view before the suite tears down
    await unsetSpacePublic(db, fgaClient, app.searchDriver, { spaceId: openSpace, tenantId: TENANT, userId: OWNER, plan: 'business' }).catch(() => {})
  }, 180_000)

  it('a move under a private parent: the boundary raises instead of leaving the page public', async () => {
    // applyMovePrivacyBoundary had no behaviour pin at all — its raise could be deleted and every test
    // stayed green (measured in the re-review).
    const parent = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-parent-${STAMP}` })).id
    pages.push(parent)
    await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: parent, tenantId: TENANT, userId: OWNER, plan: 'business' })
    const child = await freshPublicPage('moved')

    await expect(
      movePage(db, refusingDeletes(), app.searchDriver, { pageId: child, parentId: parent, afterId: null, userId: OWNER }),
      'the move made it private but could not close it, and says so',
    ).rejects.toThrow(/public grant/i)
    expect(await anyoneCanRead(child), 'and it really is still readable').toBe(true)
  }, 180_000)

  it('the working path still works, and still says so', async () => {
    const pageId = await freshPublicPage('happy')
    const before = await auditCount(pageId)
    const events = await eventsDuring(() =>
      unsetPagePublic(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }))

    expect(await anyoneCanRead(pageId), 'the grant really went').toBe(false)
    expect(events, 'and the event fires — silence on success would be the opposite defect').toEqual(['page.made_non_public'])
    expect(await auditCount(pageId) - before, 'with its ledger line').toBe(1)
  }, 180_000)

  it('removing a grant that was never there still succeeds (convergence is not failure)', async () => {
    const { id } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-never-${STAMP}` })
    pages.push(id)
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
    await expect(
      unsetPagePublic(db, fgaClient, app.searchDriver, { pageId: id, tenantId: TENANT, userId: OWNER, plan: 'business' }),
    ).resolves.toBeUndefined()
  }, 180_000)
})

// The fifth removal site is the one inside setPagePublic: its pre-write private check is outside the tx,
// so a privatise landing in between leaves a private page carrying `view_base@user:*`. It re-reads private
// AFTER the write and revokes what it just granted — the higher-stakes self-heal, and until now the ONLY
// thing covering it was the static sweep above (measured in the #622 re-review). A swallow here reported
// the tidy outcome ("it stayed private") for the untidy one.
const raceThenRefuseDeletes = () => {
  let privateReads = 0
  return Object.assign(Object.create(Object.getPrototypeOf(fgaClient) as object), fgaClient, {
    // not private when the route asks the first time (so the grant is written), private afterwards — the
    // concurrent setPagePrivate the self-heal exists for
    read: async (body: { object?: string; relation?: string }, ...rest: unknown[]) => {
      if (body?.relation === 'private') {
        privateReads += 1
        if (privateReads > 1) return { tuples: [{ key: { user: 'user:*', relation: 'private', object: body.object } }] }
        return { tuples: [] }
      }
      return (fgaClient.read as (b: unknown, ...r: unknown[]) => Promise<unknown>).call(fgaClient, body, ...rest)
    },
    write: async (body: { deletes?: unknown[] }, ...rest: unknown[]) => {
      if (body?.deletes?.length) throw new Error('the permission store is unavailable')
      return (fgaClient.write as (b: unknown, ...r: unknown[]) => Promise<unknown>).call(fgaClient, body, ...rest)
    },
  }) as typeof fgaClient
}

describe('the self-heal inside setPagePublic', () => {
  it('a grant it could not take back is reported, not dressed up as "it stayed private"', async () => {
    const { id: pageId } = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `pgr-race-${STAMP}` })
    pages.push(pageId)
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })

    let err: unknown
    await setPagePublic(db, raceThenRefuseDeletes(), app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' })
      .catch((e: unknown) => { err = e })

    expect(err, 'the call has to fail — the page is private AND carries the public grant').toBeTruthy()
    // …and not with the calm 409, which says the page merely stayed private and nothing leaked
    expect((err as { statusCode?: number }).statusCode, `409 understates it: ${String((err as Error).message)}`).not.toBe(409)
    expect(await anyoneCanRead(pageId), 'the grant it wrote is still there, which is what the caller must hear').toBe(true)
    // put it back for the teardown
    await unsetPagePublic(db, fgaClient, app.searchDriver, { pageId, tenantId: TENANT, userId: OWNER, plan: 'business' }).catch(() => {})
  }, 180_000)
})

// Every delete of a WILDCARD grant under routes/, with the statement it belongs to.
//
// Two widenings over the version #622 shipped, both from holes the final review listed as "not blockers,
// not filed" — a second-order net with known doors is worth less than the sentence describing it:
//   - the site test was `PUBLIC_GRANT`, so a future site that spells the tuple inline would be invisible.
//     `user:*` is what actually makes one of these dangerous, so that is what is looked for.
//   - the window was a fixed 3 lines, so a catch pushed further down by a long argument list escaped. The
//     statement now ends where it ends (balanced parens, or a line that closes the expression), capped so
//     a malformed file cannot make this run away.
function publicGrantDeleteSites(): { file: string; n: number; stmt: string }[] {
  const dir = resolve(import.meta.dirname, '../routes')
  const found: { file: string; n: number; stmt: string }[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.ts')) continue
    const lines = readFileSync(join(dir, entry), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!/deleteTuples\(/.test(line)) return
      // the statement: from the call until the line that ends it (`;`, or a `}` / `)` closing at column 0
      // of the surrounding block), capped at 8 lines
      const window: string[] = []
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        window.push(lines[j]!)
        const text = lines[j]!.trimEnd()
        if (j > i && (text.endsWith(';') || /^\s{0,6}\}/.test(text))) break
        if (j === i && text.endsWith(';')) break
      }
      const stmt = window.join(' ').trim()
      // a wildcard grant, by constant OR spelled out — the `user:*` is what makes the tuple dangerous
      if (!/PUBLIC_GRANT|user:\\?\*/.test(stmt)) return
      found.push({ file: entry, n: i + 1, stmt })
    })
  }
  return found
}

describe('every path that removes a public grant, found rather than listed', () => {
  it('no site swallows the whole failure', () => {
    // The defect was copies of one line, and naming them would not catch the next. The first version of
    // this sweep walked `pages.ts` ALONE and therefore missed the fifth site — the space-scoped grant in
    // spaces.ts, the widest of them all. Walking one file is a list wearing a discovery costume, so this
    // walks the routes directory: any delete of a *PUBLIC_GRANT must either let a refusal through or
    // filter it with isAlreadyConverged. A bare `.catch(() => {})` there is the leak this file is about.
    const sites = publicGrantDeleteSites()
    // Read the STATEMENT, not the line. The first version tested the matched line alone, so putting the
    // same swallow on the next line walked straight past it — measured in the #622 re-review, on the very
    // site this sweep had just been widened to cover. The rule is: either no swallow at all (a refusal
    // propagates) or one that consults isAlreadyConverged. Anything else reports success regardless of
    // what the store said. `} catch {` counts as much as `.catch(`: the shape of the syntax was never the
    // point, and a net that only knows one of them is a net with a door in it.
    //
    // The NEGATED call, not merely a mention: `if (isAlreadyConverged(e)) throw e` reads as consulting the
    // helper while doing the exact opposite, and a rule that accepts any appearance of the name passes it
    // (measured). That prescribes a shape — `if (!isAlreadyConverged(e)) …` — which is the point: there are
    // five of these, they are authz-critical, and a differently-shaped one should have to change this rule
    // on purpose rather than slip past it.
    const swallows = ({ stmt }: { stmt: string }) => /\.catch\(|\bcatch\s*[({]/.test(stmt)
    const guarded = ({ stmt }: { stmt: string }) => /!\s*isAlreadyConverged/.test(stmt)
    const offenders = sites.filter((s) => swallows(s) && !guarded(s))
    expect(offenders, 'these report success no matter what the store said').toEqual([])
    // …and the sweep is not vacuous: the sites exist, in more than one file.
    expect(sites.length, `found: ${JSON.stringify(sites.map((s) => `${s.file}:${s.n}`))}`).toBeGreaterThanOrEqual(5)
    expect(new Set(sites.map((s) => s.file)).size, 'a one-file sweep is what missed the space grant').toBeGreaterThan(1)
  })
})

// #823: the isolated stack starts each setup from a permission store that holds only what the seed
// writes.
//
// The bootstrap reuses the store named `wikistead` forever and nothing has ever emptied it, so every
// run's fixtures pile up in the same one. Measured on a stack that had been running a while: 337,127
// tuples and 1,022,750 changelog rows, 273 MB.
//
// That is not merely untidy, which is what #788 concluded when it stopped at the database ("nothing
// walks them"). Something does walk them: `filterAuthorized` batches its checks, and a batch has a
// three-second deadline. Two files went red — the graph pin counting 28 nodes where it wanted 30, the
// link-status route answering 500 with `post write : Error Request Deadline Exceeded` — three runs in
// a row, on an idle machine, from a diff that touched neither. Single calls stayed fast throughout
// (write 21ms, check 3ms), which is why this arrives as a sudden standing red rather than a slow
// decline: the batch is the only thing that feels the size, and it either fits in the deadline or
// does not. Deleting the store and bootstrapping a new one — no code change at all — made the same
// files green.
//
// Two steps, because DeleteStore is a SOFT delete: it flips a timestamp and leaves every row where it
// was (measured — the table grew afterwards). The new store is what makes the suite fast again, since
// every query is scoped by store id; reclaiming the rows of dead ones is what stops the disk from
// growing without end.
//
// ⚠️ DESTRUCTIVE, and deliberately narrow: it refuses outside the isolated stack (#269's valve), and
// refuses an OpenFGA that is not this session's (#621's rule, applied to the permission store instead
// of the database — three sessions run side by side and the obvious hand-typed command reaches the
// wrong one).
import { OpenFgaClient } from '@openfga/sdk'
import postgres from 'postgres'
// @ts-expect-error — plain .mjs, the port map every stack script shares
import { stackOffset, serverTestPorts } from '../../scripts/stack-offset.mjs'

const STORE_NAME = 'wikistead'
// The client wants a well-formed ULID even for store-level calls that do not use one.
const ANY_STORE = '01H5M3YCPQ3ZHWT1J8RYATM4WN'

/**
 * Where OpenFGA keeps its own rows: the same postgres as the app, in its own database (the compose
 * file gives it `…/openfga`). Derived from the admin url rather than configured separately, so a
 * stack that moves its ports moves this with it.
 */
function openfgaDbUrl(adminUrl: string): string {
  const u = new URL(adminUrl)
  u.pathname = '/openfga'
  return u.toString()
}

async function main(): Promise<void> {
  if (process.env.WIKISTEAD_TEST_STACK !== 'server-test') {
    throw new Error(
      'refusing to reset a permission store outside the isolated server-test stack ' +
        '(WIKISTEAD_TEST_STACK != "server-test") — this deletes every tuple the store holds, and the ' +
        'dev store must never see it (#269).',
    )
  }
  const apiUrl = process.env.OPENFGA_API_URL
  if (!apiUrl) throw new Error('OPENFGA_API_URL is not set — nothing to reset')
  const offset = stackOffset() as number
  if (offset !== 0) {
    const port = Number(new URL(apiUrl).port)
    const expected = serverTestPorts(offset).fgaHttp as number
    if (port !== expected) {
      throw new Error(
        `WKS_STACK_OFFSET=${offset} is set, but OpenFGA is on port ${port} — that is another session's ` +
          `stack (this offset uses ${expected}). Refusing to delete its store (#621).`,
      )
    }
  }

  const fga = new OpenFgaClient({ apiUrl, storeId: ANY_STORE })
  const { stores } = await (fga as unknown as { api: { listStores(): Promise<{ stores?: { id: string; name: string }[] }> } }).api.listStores()
  const mine = (stores ?? []).filter((s) => s.name === STORE_NAME)
  for (const s of mine) {
    await (fga as unknown as { api: { deleteStore(id: string): Promise<unknown> } }).api.deleteStore(s.id)
  }
  console.log(`[fga-reset] retired ${mine.length} store(s) named ${STORE_NAME}${mine.length ? `: ${mine.map((s) => s.id).join(', ')}` : ''}`)

  // Reclaim what the retired ones left behind. This reads OpenFGA's OWN tables, which belong to it and
  // not to us, so a version that renames them has to make this go quiet rather than take the setup
  // down with it — the fresh store above is what the suite actually needs.
  const adminUrl = process.env.DATABASE_ADMIN_URL
  if (!adminUrl) {
    console.log('[fga-reset] no DATABASE_ADMIN_URL — the retired rows stay where they are')
    return
  }
  const sql = postgres(openfgaDbUrl(adminUrl), { max: 1, onnotice: () => {} })
  try {
    const dead = (await sql<{ id: string }[]>`SELECT id FROM store WHERE deleted_at IS NOT NULL`).map((r) => r.id)
    if (dead.length === 0) {
      console.log('[fga-reset] no retired stores to reclaim')
    } else {
      // Named explicitly, never "everything that is not the live store": a live store this process
      // cannot see (another name, a store made by hand) must survive a cleanup it never asked for.
      const tuples = await sql`DELETE FROM tuple WHERE store = ANY(${dead})`
      const changes = await sql`DELETE FROM changelog WHERE store = ANY(${dead})`
      console.log(`[fga-reset] reclaimed ${tuples.count} tuple(s) and ${changes.count} changelog row(s) from ${dead.length} retired store(s)`)
    }
  } catch (err) {
    console.log(`[fga-reset] could not reclaim retired rows (OpenFGA's own schema may have moved): ${(err as Error).message}`)
  } finally {
    await sql.end()
  }
}

void main()

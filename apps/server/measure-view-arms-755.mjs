#!/usr/bin/env node
// #755 / ADR-241 decision ①: which ARM of `page#view` costs the time — measured, with DEPTH as a variable.
//
// What the earlier round established (#755): `page#view` costs ~17 ms per id while `space#view`
// costs 0.1 ms on the same connection and the same single round trip, so the price is inside the
// store's evaluation, not the network. What it could NOT establish is WHICH part: `view` unions six
// capabilities, each of which walks the same two chains, so "one dominant arm", "the width of the fan"
// and "the parent chain walked repeatedly" all predict the same number.
//
// ⚠️ And the earlier fixture could not see the parent chain AT ALL: every page in it was a root. That
// is the correction ADR-241 asked for and the reason depth is a variable here — a cost that only
// appears at depth is invisible in a flat fixture, which is a way of measuring that can only ever
// report "no effect".
//
// This SCRIPT rather than a test: it takes wall-clock numbers off a live store, and a number that
// depends on the machine is not an assertion. It writes what it measured and nothing else. It changes
// no model and no product code.
import postgres from 'postgres'
import { fgaClient, fgaModelId, writeTuples, deleteTuples, FGA_WRITE_CHUNK } from '@wikistead/authz'

const TENANT = 'tenant_dev'
const SPACE = `arms-755-${Date.now()}`
const USER = 'user:dev-user'
const BATCH = 50

// The arms, innermost first. `view` is the shipped relation; the rest are what it is built from
// (model.fga:292-347), so the series says where the time enters rather than only that it does.
const ARMS = ['view_base', 'comment', 'viewable', 'view_live', 'view']
const DEPTHS = [0, 3, 8]

const sql = postgres(process.env.DATABASE_ADMIN_URL)
const made = []
const tuples = []

async function page(id, parent) {
  await sql`INSERT INTO pages (id, tenant_id, space_id, parent_id, title)
            VALUES (${id}, ${TENANT}, ${SPACE}, ${parent}, ${id})`
  made.push(id)
}

async function ms(fn) { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6 }

async function check(ids, relation) {
  await fgaClient.batchCheck({
    checks: ids.map((id, j) => ({ user: USER, relation, object: `page:${id}`, correlationId: String(j) })),
  }, { authorizationModelId: fgaModelId() })
}

try {
  await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'arms 755')`
  tuples.push({ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
              { user: USER, relation: 'manager', object: `space:${SPACE}` })

  // One family per depth: a chain of `depth` ancestors, then BATCH leaves hanging off its tip. The
  // leaves are what gets measured, so every id in a batch sits at the same distance from the root.
  const byDepth = {}
  for (const depth of DEPTHS) {
    let parent = null
    for (let d = 0; d < depth; d++) {
      const id = `${SPACE}-d${depth}-anc${d}`
      await page(id, parent)
      tuples.push({ user: `space:${SPACE}`, relation: 'space', object: `page:${id}` })
      parent = id
    }
    const leaves = []
    for (let i = 0; i < BATCH; i++) {
      const id = `${SPACE}-d${depth}-leaf${i}`
      await page(id, parent)
      tuples.push({ user: `space:${SPACE}`, relation: 'space', object: `page:${id}` })
      leaves.push(id)
    }
    byDepth[depth] = leaves
  }
  // ⚠️ The store caps a write at 100 operations, and this fixture is three families of 50 leaves.
  // Chunked with the product's own constant rather than a number picked here.
  for (let i = 0; i < tuples.length; i += FGA_WRITE_CHUNK) {
    await writeTuples(fgaClient, tuples.slice(i, i + FGA_WRITE_CHUNK))
  }

  // The absent family: ids nobody created. measured this as the most expensive shape of "no" —
  // the union has to be exhausted before it can answer. Kept separate so it cannot skew the yes rows.
  const absent = Array.from({ length: BATCH }, (_, i) => `${SPACE}-absent-${i}`)

  // Warm the store once: the first call of a run pays for connections nobody is asking about.
  await check(byDepth[0], 'view')

  const rows = []
  for (const relation of ARMS) {
    for (const depth of DEPTHS) {
      const t = await ms(() => check(byDepth[depth], relation))
      rows.push({ relation, depth, kind: 'reachable', total: t.toFixed(0), per: (t / BATCH).toFixed(2) })
    }
    const t = await ms(() => check(absent, relation))
    rows.push({ relation, depth: '—', kind: 'absent', total: t.toFixed(0), per: (t / BATCH).toFixed(2) })
  }

  console.log(`\n#755 ① arms of page#view — ${BATCH} ids per batch, one round trip each\n`)
  console.log('relation      depth  kind        total ms   per id ms')
  for (const r of rows) {
    console.log(`${r.relation.padEnd(13)} ${String(r.depth).padEnd(6)} ${r.kind.padEnd(11)} ${r.total.padStart(8)}   ${r.per.padStart(9)}`)
  }
} finally {
  for (let i = 0; i < tuples.length; i += FGA_WRITE_CHUNK) {
    await deleteTuples(fgaClient, tuples.slice(i, i + FGA_WRITE_CHUNK)).catch(() => {})
  }
  if (made.length) await sql`DELETE FROM pages WHERE id = ANY(${made})`.catch(() => {})
  await sql`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await sql.end()
}

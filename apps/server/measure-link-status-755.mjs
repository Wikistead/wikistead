#!/usr/bin/env node
// #755 / ADR-243 review condition 1: what `link-status` costs NOW — after decision ② shipped.
//
// Every number this ticket carries predates two things. Decision ② (d0b6501c) stopped the editor
// asking about every link in the document and made it ask about the links the reader can SEE
// (`dead-links.ts`, `collectInternalLinks(state, view.visibleRanges)`), so the width is a screenful
// rather than a document. And the isolated store now rotates when it grows past 20,000 tuples
// (2026-08-21), so 17 ms and 70 ms per id were measurements of a fat store, not of this code.
//
// So the question "is this still slow enough to be worth a model change" has no current answer, and
// the ruling (#755) asked for one before anything else happens.
//
// A SCRIPT, not a test: wall-clock numbers depend on the machine, and a number that depends on the
// machine is not an assertion. It changes no model and no product code — it drives the shipped route.
import postgres from 'postgres'
import { fgaClient, writeTuples, deleteTuples, FGA_WRITE_CHUNK } from '@wikistead/authz'
import { buildApp } from './dist/app.js'

const TENANT = 'tenant_dev'
const SPACE = `ls-755-${Date.now()}`
const HOST = 'dev.localhost'
// The realistic band is the first four: internal links VISIBLE in one screenful of a wiki page.
// 256 is the request cap (`LINK_STATUS_REQUEST_CAP`) — the shape of a document that fills the
// viewport with nothing but links, kept so the old "cap" row can be compared with the old numbers.
const WIDTHS = [1, 5, 10, 20, 50, 256]

const sql = postgres(process.env.DATABASE_ADMIN_URL)
const made = []
const tuples = []
const ms = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6 }

let app
try {
  await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'link status 755')`
  tuples.push({ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
              { user: 'user:dev-user', relation: 'manager', object: `space:${SPACE}` })
  const ids = []
  for (let i = 0; i < Math.max(...WIDTHS); i++) {
    const id = `${SPACE}-p${i}`
    await sql`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${id}, ${TENANT}, ${SPACE}, ${id})`
    made.push(id); ids.push(id)
    tuples.push({ user: `space:${SPACE}`, relation: 'space', object: `page:${id}` })
  }
  for (let i = 0; i < tuples.length; i += FGA_WRITE_CHUNK) await writeTuples(fgaClient, tuples.slice(i, i + FGA_WRITE_CHUNK))

  app = await buildApp()
  const ask = (batch) => app.inject({
    method: 'POST', url: '/pages/link-status',
    headers: { host: HOST, authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    payload: { ids: batch },
  })
  await ask(ids.slice(0, 5)) // warm: the first call of a run pays for connections nobody asked about

  console.log(`\n#755 link-status after decision ② — reachable pages, one request each\n`)
  console.log('width   kind        total ms   per id ms')
  for (const w of WIDTHS) {
    const live = ids.slice(0, w)
    const dead = Array.from({ length: w }, (_, i) => `${SPACE}-absent-${i}`)
    for (const [kind, batch] of [['reachable', live], ['dead', dead]]) {
      const t = await ms(async () => { const r = await ask(batch); if (r.statusCode !== 200) throw new Error(`${r.statusCode} ${r.body}`) })
      console.log(`${String(w).padEnd(7)} ${kind.padEnd(11)} ${t.toFixed(0).padStart(8)}   ${(t / w).toFixed(2).padStart(9)}`)
    }
  }
} finally {
  if (app) await app.close()
  for (let i = 0; i < tuples.length; i += FGA_WRITE_CHUNK) await deleteTuples(fgaClient, tuples.slice(i, i + FGA_WRITE_CHUNK)).catch(() => {})
  if (made.length) await sql`DELETE FROM pages WHERE id = ANY(${made})`.catch(() => {})
  await sql`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await sql.end()
}

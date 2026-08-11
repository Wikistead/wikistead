// #619: the permission store's own prose reached API clients.
//
// Revoking a grant that was already gone answered with FGA's validation text — naming the model's
// relations and object ids (`relation: 'viewer', object: 'space:demo_space'`) to whoever pressed a
// button whose job was already done. Two separate defects wearing one symptom:
//   1. taking away something absent is CONVERGENCE, not a failure — the revoke is idempotent now;
//   2. the store's words are internal, and until now only the two tuple helpers translated them.
//
// DISCOVERY, not a list of routes. The redaction is measured where it is enforced (the response
// boundary), and the sweep below walks every FGA write site in the tree rather than naming the ones
// that were known to leak — a new one is measured by existing, which is the shape this ticket asked
// for after "fixing one place and leaving the class open" was called out.
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
// @ts-expect-error — .mjs script module, no types; #621: the image build has no repo-root scripts/
import { eeServerSourceRoot } from '../../../../scripts/ee-source-root.mjs'
import { buildApp } from '../app.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const SPACE = `fga619-space-${STAMP}`
const GRANTEE = `fga619-member-${STAMP}`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

// The store's fingerprints: its error prose, and the vocabulary that only exists inside model.fga.
const FGA_WORDS = /FGA API|openfga|tuple to be written|cannot delete a tuple|relation '[^']*' not found|viewer_member|view_base|comment_open|space_creator|manage_connections/i

let app: FastifyInstance

beforeAll(async () => {
  // #624: a grant names somebody who is HERE — the route refuses a principal with no members row
  await seatMembers(admin, TENANT, [GRANTEE])
  app = await buildApp()
  // A stand-in for "some route let an FGA error escape". The two tuple helpers translate what the
  // product writes ON PURPOSE (#578), but a check / read / batchCheck failure — a stale model, a
  // store that moved — arrives as the same kind of error through any route, including ones written
  // next month. That is what the response-boundary handler is for, and a defence nothing exercises
  // is a defence nobody knows is still there: this route exercises it. buildApp() does not call
  // ready(), so a test may still add routes.
  app.get('/__fga619/boom', async () => {
    throw Object.assign(new Error("FGA API Validation Error: post write : Error relation 'space#viewer_member' not found"), { statusCode: 400 })
  })
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'fga619') ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, [{ user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` }])
  await ensureMembers(TENANT, [GRANTEE])
}, 180_000)

afterAll(async () => {
  await unseatMembers(admin, TENANT, [GRANTEE])
  await app.close()
  await deleteTuples(fgaClient, memberTuples(TENANT, [GRANTEE])).catch(() => {})
  await admin`DELETE FROM role_assignments WHERE resource_id = ${SPACE}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin.end(); await pool.end()
}, 120_000)

const grant = (capability: string) =>
  app.inject({ method: 'POST', url: `/spaces/${SPACE}/access`, headers: H, payload: { grantee: `user:${GRANTEE}`, relation: capability } })
const revoke = (capability: string) =>
  app.inject({ method: 'DELETE', url: `/spaces/${SPACE}/access`, headers: H, payload: { grantee: `user:${GRANTEE}`, relation: capability } })

describe('#619: revoking what is already gone', () => {
  it('the reported sequence ends in success, not a refusal', async () => {
    // view → edit (built-ins are exclusive, so the viewer leaf goes) → revoke edit → revoke view.
    // The last step is the one that used to answer with the store's sentence: there is nothing left
    // to delete, which is exactly the state the caller asked for.
    expect((await grant('view')).statusCode, 'granted view').toBeLessThan(300)
    expect((await grant('edit')).statusCode, 'promoted to edit').toBeLessThan(300)
    expect((await revoke('edit')).statusCode, 'took edit away').toBeLessThan(300)
    const last = await revoke('view')
    expect(last.statusCode, `revoking an absent grant: ${last.body}`).toBeLessThan(300)
  }, 120_000)

  it('and repeating it stays quiet — a revoke is idempotent', async () => {
    const again = await revoke('view')
    expect(again.statusCode, again.body).toBeLessThan(300)
  }, 120_000)
})

describe('#619: the store\'s words stay inside', () => {
  it('no response body in the sequence above carried them', async () => {
    // Re-walk it capturing every body: a 2xx that quietly embedded the text would pass the checks
    // above and still be the defect.
    const bodies: string[] = []
    for (const step of [() => grant('view'), () => grant('edit'), () => revoke('edit'), () => revoke('view'), () => revoke('view')]) {
      bodies.push((await step()).body)
    }
    for (const body of bodies) expect(body, `a response spoke the store's language: ${body}`).not.toMatch(FGA_WORDS)
  }, 120_000)

  it('a genuinely broken tuple write is translated, not forwarded', async () => {
    // An impossible grantee type reaches the store and is refused there — the closest thing to "the
    // store said no for a reason we did not anticipate", which is the case that used to leak.
    const res = await app.inject({
      method: 'POST', url: `/spaces/${SPACE}/access`, headers: H,
      payload: { grantee: `group:${STAMP}#member`, relation: 'view' },
    })
    expect(res.body, `the refusal was forwarded verbatim: ${res.body}`).not.toMatch(FGA_WORDS)
  }, 120_000)

  it('an FGA error escaping ANY route is redacted at the response boundary', async () => {
    const res = await app.inject({ method: 'GET', url: '/__fga619/boom', headers: H })
    expect(res.body, `the store's sentence reached the client: ${res.body}`).not.toMatch(FGA_WORDS)
    // …and the caller still learns that it failed, by a code they can act on rather than prose.
    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    expect((res.json() as { code?: string }).code).toBe('authz_store_error')
  }, 120_000)

  it('EVERY fga write site in the tree goes through the translating helpers (discovery)', () => {
    // The leak that started this ticket was one write that skipped the boundary. Naming the known
    // sites would not have caught it, and would not catch the next one — so walk the source.
    const repo = resolve(import.meta.dirname, '../../../..')
    // #178: the EE root is resolved (mid-move to the ee/ overlay); null only in a CE-only clone.
    const eeRoot = eeServerSourceRoot(repo)
    const roots = [
      join(repo, 'apps/server/src'),
      join(repo, 'packages/authz/src'),
      ...(eeRoot === null ? [] : [eeRoot]),
      join(repo, 'apps/collab/src'),
    ]
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
          walk(full)
          continue
        }
        if (!entry.endsWith('.ts')) continue
        const src = readFileSync(full, 'utf8')
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (!/\bfga\.write\(|\bfgaClient\.write\(/.test(line)) return
          // A one-off script is not a response path (it has no client to leak to).
          if (full.includes(join('src', 'scripts'))) return
          // tuples.ts IS the boundary — but "it is the boundary" is not the same as "every write in
          // it is guarded", and skipping the file wholesale is how the unguarded sweep survived here
          // in the first place (measured: removing its guard left this test green). So the file is
          // held to the stricter rule instead of exempted — each write must translate, right there.
          if (full.endsWith(join('packages', 'authz', 'src', 'tuples.ts'))) {
            const guarded = lines.slice(i, i + 6).some((l) => l.includes('asDomainError'))
            if (!guarded) offenders.push(`${full.slice(repo.length + 1)}:${i + 1} (no asDomainError nearby)`)
            return
          }
          offenders.push(`${full.slice(repo.length + 1)}:${i + 1}`)
        })
      }
    }
    for (const root of roots) walk(root)
    expect(offenders, 'these write to the store without the translation boundary').toEqual([])
  })
})

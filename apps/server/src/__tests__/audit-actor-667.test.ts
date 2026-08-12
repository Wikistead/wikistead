// #667 / ADR-221 §9: an API key's actions are recorded as the key, not as its owner.
//
// Measured before this was built: forty-nine call sites build an actor as `user:<sub>` and none ever
// wrote `api_key:`. So every action a key took was filed as though the person did it by hand, and after
// an incident nothing separated an integration's edit from somebody's. That is the one question an audit
// log exists to answer.
//
// NOT FIXED BY CORRECTING FORTY-NINE SITES. A list of corrected call sites is a list that grows a
// fiftieth the week after — the same shape as the route table this ticket keeps finding holes in. The
// substitution happens once, where the row is written, and this file measures BOTH halves of that: the
// derivation itself, and the fact that no call site is expected to know about it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { auditActor } from '../audit/sink.js'
import { runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import { expectLedgerAtLeast } from './helpers/expect-ledger.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)

let app: FastifyInstance

async function key(): Promise<{ token: string; id: string }> {
  const prefix = randomBytes(6).toString('base64url')
  const plaintext = `wks_${prefix}_${randomBytes(24).toString('base64url')}`
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope)
    VALUES (${T}, ${OWNER}, ${`aa667-${STAMP}-${randomBytes(3).toString('hex')}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(plaintext).digest('hex')}, 'write')
    RETURNING id`
  return { token: plaintext, id: row!.id }
}

beforeAll(async () => { app = await buildApp(); await app.ready() }, 180_000)
afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${'aa667-%'}`.catch(() => {})
  // this file writes a member row and audit rows; a run that dies half way leaves them for the next one
  await admin`DELETE FROM role_definitions WHERE tenant_id = ${T} AND name LIKE ${'aa667-%'}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#667 §9: the derivation', () => {
  it('rewrites a member actor to the key, when the request came on one', () => {
    runInAuthzScope({ ...SYSTEM_SCOPE, restriction: null, apiKeyId: 'key-abc' }, () => {
      expect(auditActor('user:dev-user')).toBe('api_key:key-abc')
    })
  })

  it('leaves it alone when no key is in play', () => {
    runInAuthzScope({ restriction: null }, () => {
      expect(auditActor('user:dev-user'), 'a person acting is still the person').toBe('user:dev-user')
    })
    // …and outside a scope entirely: background drains and sweeps write audit rows too
    expect(auditActor('user:dev-user')).toBe('user:dev-user')
  })

  it('never rewrites an actor that was not a member', () => {
    // `scim`, `system` and `operator:` describe principals a key cannot be behind. Rewriting one would
    // make the ledger say something FALSE rather than something imprecise, which is worse.
    runInAuthzScope({ restriction: null, apiKeyId: 'key-abc' }, () => {
      for (const actor of ['scim', 'system', 'operator:ops-1']) {
        expect(auditActor(actor), `${actor} is not a member acting`).toBe(actor)
      }
    })
  })
})

describe('#667 §9: a real request writes the key into the ledger', () => {
  // `POST /admin/roles` audits through the same `auditIfEntitled` every audited operation uses
  // (`roles.ts:746`) and needs no fixture beyond a name.
  //
  // THREE candidates were measured and discarded first, and each would have produced a green test that
  // measured nothing or a red one that measured the fixture rather than the product:
  //   `POST /api-keys`                 — not audited at all; the assertion ran against zero rows.
  //   `PATCH /members/:sub`            — returns `{ok:true}` from a no-op branch when the role is
  //                                      unchanged, and promoting a member seeded straight into the
  //                                      table is refused by the permission store (no FGA membership).
  //   `POST /members/:sub/password-setup` — refuses for a member the tenant cannot give a password to.
  const made: string[] = []

  const createRole = (auth: string, name: string) => app.inject({
    method: 'POST', url: '/admin/roles',
    headers: { host: 'dev.localhost', authorization: auth, 'content-type': 'application/json' },
    payload: JSON.stringify({ name, scope: 'resource', capabilities: ['view'] }),
  })
  const rowsFor = (roleId: string) => admin<{ actor: string }[]>`
    SELECT actor FROM audit_outbox WHERE tenant_id = ${T} AND target = ${`role:${roleId}`}
    UNION ALL
    SELECT actor FROM audit_log WHERE tenant_id = ${T} AND target = ${`role:${roleId}`}`

  it('an audited operation on a key records api_key:<id>, and never the owner', async () => {
    const { token, id } = await key()
    const res = await createRole(`Bearer ${token}`, `aa667-bykey-${STAMP}`)
    expect(res.statusCode, res.body).toBe(201)
    const roleId = res.json<{ id: string }>().id
    made.push(roleId)

    const rows = await rowsFor(roleId)
    // Assert the PREMISE before the property: a test satisfied by zero rows measures nothing, which is
    // exactly what the first version of this file did against a route that is not audited.
    // #692 D: composition-aware — a build with no ledger composed in enqueues nothing, and THAT is
    // asserted (exactly zero), so the actor loop below is vacuous only where the set is proven empty.
    await expectLedgerAtLeast(async () => rows.length, 1, 'the operation was audited (the tenant is audit-entitled)')
    for (const r of rows) {
      expect(r.actor, 'the key, not its owner').toBe(`api_key:${id}`)
      expect(r.actor).not.toContain(OWNER)
    }
  }, 120_000)

  it('…while the same operation by a person still records the person', async () => {
    // Without this the case above is satisfied by rewriting every actor to something, which is not a
    // more precise ledger, it is a broken one.
    const res = await createRole('Bearer dev-token', `aa667-byhuman-${STAMP}`)
    expect(res.statusCode, res.body).toBe(201)
    const roleId = res.json<{ id: string }>().id
    made.push(roleId)
    const rows = await rowsFor(roleId)
    await expectLedgerAtLeast(async () => rows.length, 1, 'the control was audited too')
    for (const r of rows) expect(r.actor, 'a person acting is the person').toBe(`user:${OWNER}`)
  }, 120_000)

  afterAll(async () => {
    for (const id of made) {
      await admin`DELETE FROM audit_outbox WHERE tenant_id = ${T} AND target = ${`role:${id}`}`.catch(() => {})
      await admin`DELETE FROM audit_log WHERE tenant_id = ${T} AND target = ${`role:${id}`}`.catch(() => {})
      await admin`DELETE FROM role_definitions WHERE tenant_id = ${T} AND id = ${id}`.catch(() => {})
    }
  }, 60_000)
})

describe('#667 §9: no call site is expected to know about this', () => {
  // The scan that replaces a list. If somebody adds an audited operation next month, they will write
  // `actor: \`user:${…}\`` like the forty-nine before them — and they should, because the substitution is
  // not their problem. What must NOT appear is a call site doing it BY HAND, which is how a list of
  // corrected sites starts: two ways of spelling the same fact, one of which will be forgotten.
  const SRC = resolve(import.meta.dirname, '..')

  function files(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      if (name === '__tests__' || name === 'node_modules') continue
      const p = resolve(dir, name)
      if (statSync(p).isDirectory()) out.push(...files(p))
      else if (p.endsWith('.ts')) out.push(p)
    }
    return out
  }

  it('the actor is derived in exactly one place', () => {
    const byHand: string[] = []
    for (const f of files(SRC)) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      // `sink.ts` is the one place (#688 moved the derivation there with the vocabulary — the EE
      // ledger calls the same auditActor through the seam); everywhere else, writing an `api_key:`
      // actor means a second derivation that will drift from this one.
      if (f.endsWith('audit/sink.ts')) continue
      if (/actor:\s*`?api_key:/.test(src)) byHand.push(f.slice(f.indexOf('/src/') + 1))
    }
    expect(byHand, `these build an api_key actor themselves — the derivation belongs in audit/sink.ts`)
      .toEqual([])
  })

  it('…and the scan would notice, because the one place IS found', () => {
    // Guard against the check above passing because the pattern matches nothing anywhere.
    const sink = readFileSync(resolve(SRC, 'audit/sink.ts'), 'utf8')
    expect(sink, 'the derivation exists where it is supposed to').toMatch(/api_key:\$\{keyId\}/)
  })

  it('the call sites still write member actors, and that is correct', () => {
    // Measured at the time: forty-nine of them. Not asserted exactly — the number moves with ordinary
    // work and pinning it would make unrelated changes red. What matters is that they are MANY, which is
    // the reason the substitution is central rather than distributed.
    const memberActors = files(SRC)
      .filter((f) => /actor:\s*`user:/.test(readFileSync(f, 'utf8')))
    expect(memberActors.length, 'call sites still spell the member actor, as they should')
      .toBeGreaterThan(5)
  })
})

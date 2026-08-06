// #658: the key list says what each key is confined to — and names only what the READER may see.
//
// #637 made confined keys issuable and made the confinement bite. The ledger then said nothing about
// it: `GET /api-keys` returned scope and prefix, so a roster of credentials handed to outside services
// could not be read back. `issue.ts` refuses to write a list that lies about where a key reaches; a
// list that omits the confinement entirely leaves the same question unanswerable.
//
// The authorization question is on the way OUT, and it is the one worth measuring. Resolving space
// NAMES for whoever asks would turn "hold a key" — or "be an admin" — into a directory of space names.
// #637 asks whether the ISSUER can see a space before writing it onto a key; the same question belongs
// here. So the count is reported and the names are resolved through `filterAuthorized`, which means a
// second principal is the only honest way to test it: measured as the person who CAN see everything,
// any implementation passes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { listApiKeys } from '../routes/api-keys.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const OUTSIDER = `led658-outsider-${STAMP}`
const SEEN = `led658-seen-${STAMP}`
const UNSEEN = `led658-unseen-${STAMP}`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let db: TenantDb

const tuples = [
  { user: `tenant:${T}`, relation: 'tenant', object: `space:${SEEN}` },
  { user: `tenant:${T}`, relation: 'tenant', object: `space:${UNSEEN}` },
  // the OUTSIDER can view one of the two spaces the key reaches, and not the other
  { user: `user:${OUTSIDER}`, relation: 'viewer', object: `space:${SEEN}` },
  { user: `user:${OWNER}`, relation: 'viewer', object: `space:${SEEN}` },
  { user: `user:${OWNER}`, relation: 'viewer', object: `space:${UNSEEN}` },
]

async function mintKey(name: string, opts: { spaces?: string[]; capabilities?: string[] }): Promise<void> {
  const prefix = randomBytes(6).toString('base64url')
  await admin`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope, capabilities, space_ids)
    VALUES (${T}, ${OWNER}, ${`led658-${name}-${STAMP}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(randomBytes(8)).digest('hex')}, 'write',
            ${opts.capabilities ?? null}, ${opts.spaces ?? null})`
}

const keyNamed = (list: Awaited<ReturnType<typeof listApiKeys>>, suffix: string) =>
  list.find((k) => k.name === `led658-${suffix}-${STAMP}`)!

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(T))
  await seatMembers(admin, T, [OUTSIDER])
  await ensureMembers(T, [OUTSIDER])
  for (const id of [SEEN, UNSEEN]) {
    await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${id}, ${T}, ${id}) ON CONFLICT (id) DO NOTHING`
  }
  await writeTuples(fgaClient, tuples).catch(() => {})
  await mintKey('confined', { spaces: [SEEN, UNSEEN], capabilities: ['view'] })
  await mintKey('plain', {})
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${`led658-%-${STAMP}`}`.catch(() => {})
  await deleteTuples(fgaClient, [...tuples, ...memberTuples(T, [OUTSIDER])]).catch(() => {})
  await admin`DELETE FROM spaces WHERE id IN (${SEEN}, ${UNSEEN})`.catch(() => {})
  await unseatMembers(admin, T, [OUTSIDER]).catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 180_000)

describe('#658: the ledger reports the confinement', () => {
  it('a confined key carries its spaces and verbs; an unconfined one carries neither', async () => {
    const list = await listApiKeys(db, fgaClient, OWNER)
    const confined = keyNamed(list, 'confined')
    expect(confined.spaces?.count, 'both spaces are counted').toBe(2)
    expect(confined.capabilities, 'and the verbs come back').toEqual(['view'])

    const plain = keyNamed(list, 'plain')
    expect(plain.spaces, 'an unconfined key is unmarked — the common case is not the exception').toBeUndefined()
    expect(plain.capabilities).toBeUndefined()
  }, 180_000)
})

describe('#658: names are resolved for the reader, not for the key', () => {
  it('a reader who can see one of the two spaces gets one name and both in the count', async () => {
    // The whole question, and it can only be asked as somebody who cannot see everything.
    const asOutsider = await listApiKeys(db, fgaClient, OUTSIDER)
    const k = keyNamed(asOutsider, 'confined')
    expect(k.spaces?.count, 'the count is the whole confinement — that much is inventory').toBe(2)
    expect(k.spaces?.named.map((s) => s.id), 'only the space this reader may view is named').toEqual([SEEN])
  }, 180_000)

  it('…and a reader who can see both gets both', async () => {
    // The control. Without it, an implementation that named nothing at all would pass the case above.
    const asOwner = await listApiKeys(db, fgaClient, OWNER)
    const k = keyNamed(asOwner, 'confined')
    expect(k.spaces?.named.map((s) => s.id).sort(), 'both, for the reader who may see both').toEqual([SEEN, UNSEEN].sort())
  }, 180_000)
})

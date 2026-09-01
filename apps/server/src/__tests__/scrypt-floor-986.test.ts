// #986 / ADR-198 §4 + ADR-107 §2: every credential this product stores is hashed at or above OWASP's
// stated scrypt floor, and every already-stored record keeps verifying at ITS OWN parameters.
//
// The defect this pins was not a wrong branch — it was a NUMBER nobody re-checked. ADR-198 wrote
// "OWASP's interactive floor" beside N=2^15 when the floor was 2^17, and `share-link-password.ts`
// passed no options at all, so it ran at node's default 2^14 while the ADR said it encoded N/r/p.
// TWO stores, one forgotten. So this walks for scrypt call sites rather than naming the two it knows,
// and it measures each store by RUNNING its shipped hash function and reading the parameters back out
// of the record — never by importing the constant, which is the thing that could be wrong.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import { hashPassword, verifyPassword, needsRehash } from '../auth/password-hash.js'
import {
  hashSharePassword, verifySharePassword, needsSharePasswordRehash, parseSharePassword,
} from '../routes/share-link-password.js'

// OWASP Password Storage Cheat Sheet, scrypt: N=2^17, r=8, p=1 (checked 2026-08-27, #986). A FLOOR:
// raising the constants above it must never need an edit here.
const OWASP_MIN_N = 131072
const OWASP_MIN_R = 8
const OWASP_MIN_P = 1

const SERVER = resolve(import.meta.dirname, '..')
const scryptRaw = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>
const scryptWith = promisify(scryptCb) as (
  p: string, s: Buffer, k: number, o: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { if (entry !== 'dist' && entry !== '__tests__') walk(p) }
      else if (/\.ts$/.test(p) && !/\.(test|spec)\./.test(p)) out.push({ rel: p.slice(SERVER.length + 1), text: readFileSync(p, 'utf8') })
    }
  }
  walk(SERVER)
  return out
}

describe('#986: the scrypt call sites are found, not listed', () => {
  it('exactly two files derive a key with scrypt, and both are pinned below', () => {
    // The predicate is "imports scrypt from node:crypto" — the CAPABILITY, not the word. A bare
    // /scrypt/ also matches `share-links.ts`, which only mentions it in a comment about not holding a
    // connection across one, and that is a file this pin has nothing to say about.
    const importsScrypt = (t: string): boolean =>
      /import\s*\{[^}]*\bscrypt\b[^}]*\}\s*from\s*'node:crypto'/.test(t)
    const found = sources().filter((s) => importsScrypt(s.text)).map((s) => s.rel).sort()
    // A floor, not a ceiling: a THIRD credential store is exactly the thing that got missed once. If
    // this fails because one was added, add it to the parameter walk below rather than to this list.
    expect(found, 'files that reach for scrypt').toEqual(
      ['auth/password-hash.js', 'routes/share-link-password.js'].map((f) => f.replace('.js', '.ts')).sort(),
    )
  })
})

describe('#986: each store hashes at or above the floor — measured by running it', () => {
  // The parameters are read out of what the SHIPPED function produced. Importing SCRYPT_N and
  // asserting on it would pass with a hash function that ignored the constant, which is precisely
  // what `share-link-password.ts` did.
  const stores: { name: string; hash: () => Promise<string>; read: (s: string) => { N: number; r: number; p: number } | null }[] = [
    {
      name: 'local member password (ADR-198 §4)',
      hash: () => hashPassword('a-password-nobody-holds'),
      read: (s) => {
        const parts = s.split('$')
        if (parts.length !== 6 || parts[0] !== 's2') return null
        return { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) }
      },
    },
    {
      name: 'share-link password (ADR-107 §2)',
      hash: () => hashSharePassword('a-password-nobody-holds'),
      read: (s) => {
        const parsed = parseSharePassword(s)
        return parsed ? { N: parsed.N, r: parsed.r, p: parsed.p } : null
      },
    },
  ]

  for (const store of stores) {
    it(`${store.name}: the record it writes states N>=2^17, r>=8, p>=1`, async () => {
      const stored = await store.hash()
      const params = store.read(stored)
      expect(params, `${store.name} must record its parameters in the stored value`).not.toBeNull()
      expect(params!.N, 'N is at or above the OWASP floor').toBeGreaterThanOrEqual(OWASP_MIN_N)
      expect(params!.r).toBeGreaterThanOrEqual(OWASP_MIN_R)
      expect(params!.p).toBeGreaterThanOrEqual(OWASP_MIN_P)
    }, 30_000)
  }

  it('the two stores state the SAME parameters (one number, not two authors)', async () => {
    const member = (await hashPassword('x')).split('$')
    const share = parseSharePassword(await hashSharePassword('x'))!
    expect([Number(member[1]), Number(member[2]), Number(member[3])]).toEqual([share.N, share.r, share.p])
  }, 30_000)
})

describe('#986: a record written before the raise still verifies, then upgrades', () => {
  // Written exactly the way the shipped code wrote it before this ticket: no options (node's default
  // N=2^14) and two fields. A row in this shape exists in every database that ever protected a link.
  async function legacyRecord(password: string): Promise<string> {
    const salt = randomBytes(16)
    return `scrypt$${salt.toString('hex')}$${(await scryptRaw(password, salt, 32)).toString('hex')}`
  }

  it('the legacy two-field share-link record verifies (nobody is locked out)', async () => {
    const stored = await legacyRecord('hunter2')
    expect(await verifySharePassword('hunter2', stored), 'the correct password still opens the link').toBe(true)
    expect(await verifySharePassword('wrong', stored), 'and a wrong one still does not').toBe(false)
  }, 30_000)

  it('…and is flagged for the opportunistic upgrade, while a fresh one is not', async () => {
    expect(needsSharePasswordRehash(await legacyRecord('hunter2'))).toBe(true)
    expect(needsSharePasswordRehash(await hashSharePassword('hunter2'))).toBe(false)
  }, 30_000)

  it('the member store behaves the same way for a below-floor record', async () => {
    // Its format already carried N/r/p, so an old record is one that names smaller ones.
    const salt = randomBytes(16)
    const hash = await scryptWith('hunter2', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const old = `s2$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
    expect(await verifyPassword('hunter2', old), 'verification reads the parameters FROM the record').toBe(true)
    expect(needsRehash(old), 'and the record is due an upgrade').toBe(true)
  }, 30_000)

  it('verification uses the stored parameters rather than assuming today\'s', async () => {
    // A share-link record at parameters that are neither the legacy default nor today's constants:
    // it can only verify if `verifySharePassword` read N/r/p out of the record.
    const salt = randomBytes(16)
    const N = 65536
    const derived = await scryptWith('hunter2', salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 })
    const stored = `scrypt$${N}$8$1$${salt.toString('hex')}$${derived.toString('hex')}`
    expect(await verifySharePassword('hunter2', stored)).toBe(true)
    expect(needsSharePasswordRehash(stored), 'and it is still below the floor, so it upgrades').toBe(true)
  }, 30_000)

  it('a malformed record is false, never an exception (no wrong-vs-corrupt oracle)', async () => {
    for (const bad of ['', 'garbage', 'scrypt$', 'scrypt$zz$zz', 'scrypt$0$8$1$aa$bb', 'scrypt$99999999$8$1$aa$bb', 's2$1$2$3$4$5']) {
      await expect(verifySharePassword('hunter2', bad)).resolves.toBe(false)
    }
    expect(await verifySharePassword('hunter2', null)).toBe(false)
  }, 30_000)
})

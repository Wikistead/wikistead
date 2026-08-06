// #667 / ADR-221 §0: the list of routes that hand out a credential was incomplete.
//
// Three shapes were missing. Two mint a plaintext credential of their own
// (`POST /admin/api-keys/narrowed`, `POST /admin/scim-tokens` — both EE, pinned in the ee-server suite
// beside the gate that serves them). The third is here, and is the one that does not look like minting
// at all: `GET /pages/:pageId/share-links` RETURNS share-link ids, and an id is exchangeable for a guest
// token at `POST /public/share-links/:id/token` with no authentication whatsoever. For a link with no
// password the id IS the credential, so a key narrowed to `view` would have been a collection point.
//
// WHY THIS TEST CAN TELL TODAY FROM TOMORROW. Both refusals answer 403 with `code: 'narrowed_key'`, so a
// pin that reads `code` is green either way and says nothing. What differs is the sentence:
//
//   minting  →  'this API key may not issue credentials'   (app.ts, above the gate)
//   table    →  'this API key is not permitted here'       (deny-by-default, below it)
//
// Before this change every one of these routes was refused by the SECOND branch — safe by accident,
// because deny-by-default keeps a narrowed key off every unclassified route. ADR-221's classification
// work removes that cover, which is why this lands first and why the assertion is on the branch rather
// than on the status code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
const MINTING = 'this API key may not issue credentials'

let app: FastifyInstance

async function narrowedKey(capabilities: string[] | null, spaces: string[] | null = null): Promise<string> {
  const prefix = randomBytes(6).toString('base64url')
  const plaintext = `wks_${prefix}_${randomBytes(24).toString('base64url')}`
  await admin`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope, capabilities, space_ids)
    VALUES (${T}, ${OWNER}, ${`mint667-${STAMP}-${randomBytes(3).toString('hex')}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(plaintext).digest('hex')}, 'write', ${capabilities}, ${spaces})`
  return plaintext
}

const call = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string) =>
  app.inject({ method, url, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })

beforeAll(async () => { app = await buildApp(); await app.ready() }, 180_000)
afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${'mint667-%'}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#667: listing share links is a credential read, and is refused as one', () => {
  // Both narrowings, because `isNarrowedKey` answers on either dimension and the refusal must not
  // depend on which one a key happens to carry (#637's fail-open lived in that question).
  for (const [how, make] of [
    ['narrowed by capability', () => narrowedKey(['view', 'edit', 'publish', 'delete', 'comment', 'manage'])],
    ['narrowed by space only', () => narrowedKey(null, ['demo_space'])],
  ] as const) {
    it(`${how}: the page listing answers the minting refusal`, async () => {
      const res = await call(await make(), 'GET', '/pages/any-page-667/share-links')
      expect(res.statusCode, res.body).toBe(403)
      // the branch, not the status: deny-by-default already answered 403 before this change
      expect(res.json<{ error: string }>().error).toBe(MINTING)
    }, 120_000)

    it(`${how}: the space listing answers the minting refusal`, async () => {
      const res = await call(await make(), 'GET', '/spaces/demo_space/share-links')
      expect(res.statusCode, res.body).toBe(403)
      expect(res.json<{ error: string }>().error).toBe(MINTING)
    }, 120_000)

    it(`${how}: revoking one answers it too`, async () => {
      // Revocation sits beside minting — `DELETE /api-keys/:id` was already refused for that reason and
      // its share-link twin was not.
      const res = await call(await make(), 'DELETE', '/share-links/any-link-667')
      expect(res.statusCode, res.body).toBe(403)
      expect(res.json<{ error: string }>().error).toBe(MINTING)
    }, 120_000)
  }

  it('…while an ordinary page read is still answered by the ordinary path', async () => {
    // Without this the three above could be satisfied by refusing everything with one message, which is
    // not a narrower gate, it is a broken one.
    const res = await call(await narrowedKey(['view']), 'GET', '/pages/any-page-667')
    expect(res.json<{ error?: string }>().error, res.body).not.toBe(MINTING)
  }, 120_000)

  it('and an UNNARROWED key is not touched by any of this', async () => {
    // The refusal is for narrowed keys only (`app.ts` checks `isNarrowedKey` first). An unrestricted key
    // reaches these routes exactly as it did — ADR-221 §11 states that out loud rather than leaving it
    // to be discovered.
    const res = await call(await narrowedKey(null, null), 'GET', '/spaces/demo_space/share-links')
    expect(res.json<{ error?: string }>().error, res.body).not.toBe(MINTING)
  }, 120_000)
})

describe('#667: the list finds a new minting route on the day it lands', () => {
  // A list of six route strings is a list that grows a seventh somewhere else. This asks the SOURCE the
  // question the list is supposed to answer: does any handler hand out a credential without being on it?
  //
  // It is a heuristic, deliberately: `plaintext` and the two creator calls are the words this codebase
  // actually uses when a secret leaves the server (`createApiKey` returns `{ plaintext }`,
  // `createScimToken` returns `{ plaintext }`, `listShareLinks` returns ids). A route that invents a
  // seventh way will not be caught by the words — but a route that copies one of the existing six will,
  // and copying is how the sixth arrived.
  const ROOTS = [
    resolve(import.meta.dirname, '../routes'),
    resolve(import.meta.dirname, '../../../../packages/ee-server/src'),
  ]
  const HANDS_OUT = /\bplaintext\b|createApiKey\s*\(|createScimToken\s*\(|listShareLinks\s*\(/

  // Comments are prose, not behaviour, and this scan reads a word that appears in both. Measured:
  // `POST /auth/local/login` says "the only moment the plaintext is in hand" about the password it
  // RECEIVES, and matched — a route that takes a credential read as one that hands one out. Stripped
  // rather than excluded by name, because the next false positive would be a different route saying a
  // similar thing.
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  function routeBodies(): { key: string; body: string }[] {
    const out: { key: string; body: string }[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'dist') walk(p); continue }
        if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue
        const src = codeOnly(readFileSync(p, 'utf8'))
        const re = /app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\2/g
        const starts: { at: number; method: string; path: string }[] = []
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) starts.push({ at: m.index, method: m[1]!.toUpperCase(), path: m[3]! })
        for (const [i, r] of starts.entries()) {
          const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length
          out.push({ key: `${r.method} ${r.path}`, body: src.slice(r.at, end) })
        }
      }
    }
    for (const root of ROOTS) walk(root)
    return out
  }

  it('the scan reads routes at all (a broken pattern must not pass vacuously)', () => {
    const keys = routeBodies().map((r) => r.key)
    expect(keys.length, 'route registrations were found').toBeGreaterThan(100)
    expect(keys, 'the motivating route is in scope').toContain('POST /api-keys')
  })

  it('every handler that hands out a credential is refused for narrowed keys', () => {
    // `app.ts` is the authority; read the set out of it rather than restating it here, or this test and
    // the product would be two copies that drift.
    const appSrc = readFileSync(resolve(import.meta.dirname, '../app.ts'), 'utf8')
    const block = appSrc.slice(appSrc.indexOf('const CREDENTIAL_MINTING_ROUTES'))
    const listed = new Set([...block.slice(0, block.indexOf('])')).matchAll(/'([A-Z]+ \/[^']*)'/g)].map((m) => m[1]!))
    expect(listed.size, 'the set was parsed out of app.ts').toBeGreaterThan(5)

    const missing = routeBodies()
      .filter((r) => HANDS_OUT.test(r.body))
      .map((r) => r.key)
      .filter((k) => !listed.has(k))
    expect(
      missing,
      `these routes hand out a credential and are not refused to narrowed keys (#667 / ADR-221 §0). ` +
      `Add them to CREDENTIAL_MINTING_ROUTES, or say here why they are not credentials: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('the scan would notice — the defect it was written for IS reported', () => {
    // Without this the case above could pass because HANDS_OUT matches nothing at all.
    const bodies = routeBodies().filter((r) => HANDS_OUT.test(r.body)).map((r) => r.key)
    expect(bodies, 'the plaintext-minting route is seen').toContain('POST /api-keys')
    expect(bodies, 'and the share-link listing that returns ids').toContain('GET /pages/:pageId/share-links')
  })
})

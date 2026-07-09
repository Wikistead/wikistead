// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// ADR-020 user account settings. SELF-SCOPE is the security boundary:
//   - a member updates ONLY their own row (another member's row is untouched),
//   - an unauthenticated request is rejected (401),
//   - a custom display name / avatar SURVIVES the OIDC login upsert (re-login),
//   - avatar upload sniffs magic bytes (SVG rejected, oversize rejected).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { getAccountSettings, updateAccountSettings, setAvatar, clearAvatar } from '../routes/account.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const SUB_A = `acct-a-${Date.now().toString(36)}`
const SUB_B = `acct-b-${Date.now().toString(36)}`
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

let app: FastifyInstance
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  for (const sub of [SUB_A, SUB_B]) {
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${TENANT}, ${sub}, ${`${sub}@x.test`}, 'IdP Name', 'member')
      ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
}, 30_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE sub IN (${SUB_A}, ${SUB_B})`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('account settings (ADR-020)', () => {
  it('effective name = override ?? OIDC; updating sets the override', async () => {
    expect((await getAccountSettings(db, { subject: SUB_A })).displayName).toBe('IdP Name')
    const after = await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: 'My Name' })
    expect(after.displayName).toBe('My Name')
    expect(after.oidcDisplayName).toBe('IdP Name') // still available, for "reset to IdP name"
    expect(after.displayNameOverride).toBe('My Name')
  })

  it('a blank override clears it (falls back to the OIDC name)', async () => {
    await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: 'X' })
    const after = await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: '   ' })
    expect(after.displayNameOverride).toBeNull()
    expect(after.displayName).toBe('IdP Name')
  })

  it('the override SURVIVES a re-login OIDC upsert (display_name change does not clobber it)', async () => {
    await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: 'Sticky' })
    // simulate the login provisioning upsert, which writes ONLY display_name
    await admin`UPDATE members SET display_name = 'New IdP Name' WHERE sub = ${SUB_A}`
    const after = await getAccountSettings(db, { subject: SUB_A })
    expect(after.displayName).toBe('Sticky')        // override still wins
    expect(after.oidcDisplayName).toBe('New IdP Name')
  })

  it('keymap mode round-trips (default/vim/local), defaults to local, rejects invalid', async () => {
    expect((await getAccountSettings(db, { subject: SUB_B })).editorKeymap).toBe('local') // null → 'local'
    for (const m of ['vim', 'default', 'local'] as const) {
      expect((await updateAccountSettings(db, { subject: SUB_A, editorKeymap: m })).editorKeymap).toBe(m)
    }
    await expect(updateAccountSettings(db, { subject: SUB_A, editorKeymap: 'emacs' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('display-mode pref round-trips (live/source/wysiwyg/local), defaults to local, rejects invalid (#164-3 · #289)', async () => {
    expect((await getAccountSettings(db, { subject: SUB_B })).editorDisplayMode).toBe('local') // null → 'local'
    for (const m of ['live', 'source', 'wysiwyg', 'local'] as const) {
      // #289 / ADR-115: 'wysiwyg' joined the startup set (the wysiwyg persona boots there)
      expect((await updateAccountSettings(db, { subject: SUB_A, editorDisplayMode: m })).editorDisplayMode).toBe(m)
    }
    // 'reading' stays a mid-session display state, deliberately NOT a startup value
    await expect(updateAccountSettings(db, { subject: SUB_A, editorDisplayMode: 'reading' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('#289 / ADR-115: editorChrome round-trips with strict shape; onboarding marker is one-way', async () => {
    // default (never enrolled): null chrome + null onboarding marker
    const before = await getAccountSettings(db, { subject: SUB_B })
    expect(before.editorChrome).toBeNull()
    expect(before.onboardingCompletedAt).toBeNull()

    const chrome = { vimToggleVisible: false, modesVisible: { live: false, source: false, reading: true, wysiwyg: true } }
    const after = await updateAccountSettings(db, { subject: SUB_A, editorChrome: chrome, onboardingCompleted: true })
    expect(after.editorChrome).toEqual(chrome)
    expect(after.onboardingCompletedAt).not.toBeNull()

    // marker is one-way: repeating keeps the ORIGINAL timestamp; false is rejected outright
    const again = await updateAccountSettings(db, { subject: SUB_A, onboardingCompleted: true })
    expect(again.onboardingCompletedAt).toBe(after.onboardingCompletedAt)
    await expect(updateAccountSettings(db, { subject: SUB_A, onboardingCompleted: false as unknown as boolean })).rejects.toMatchObject({ statusCode: 400 })

    // strict shape: junk / missing keys / non-boolean / extra keys all 400
    await expect(updateAccountSettings(db, { subject: SUB_A, editorChrome: 'junk' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateAccountSettings(db, { subject: SUB_A, editorChrome: { vimToggleVisible: true } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateAccountSettings(db, { subject: SUB_A, editorChrome: { vimToggleVisible: 'yes', modesVisible: chrome.modesVisible } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateAccountSettings(db, { subject: SUB_A, editorChrome: { ...chrome, extra: 1 } })).rejects.toMatchObject({ statusCode: 400 })
    await expect(updateAccountSettings(db, { subject: SUB_A, editorChrome: { vimToggleVisible: true, modesVisible: { live: true } } })).rejects.toMatchObject({ statusCode: 400 })

    // explicit null resets to defaults (all shown)
    expect((await updateAccountSettings(db, { subject: SUB_A, editorChrome: null })).editorChrome).toBeNull()
    // self-scope: B untouched throughout
    expect((await getAccountSettings(db, { subject: SUB_B })).editorChrome).toBeNull()
  })

  it('keybindings round-trip; reject unknown command / duplicate key / reserved key (ADR-021)', async () => {
    expect((await getAccountSettings(db, { subject: SUB_B })).keybindings).toEqual({}) // null → {}
    const ok = await updateAccountSettings(db, { subject: SUB_A, keybindings: { "editor.toggleVim": "Ctrl-Alt-v", "search.focus": "Mod-k" } })
    expect(ok.keybindings).toEqual({ "editor.toggleVim": "Ctrl-Alt-v", "search.focus": "Mod-k" })
    expect((await getAccountSettings(db, { subject: SUB_A })).keybindings["editor.toggleVim"]).toBe("Ctrl-Alt-v")
    await expect(updateAccountSettings(db, { subject: SUB_A, keybindings: { "bogus.cmd": "F2" } })).rejects.toMatchObject({ statusCode: 400 }) // unknown command
    await expect(updateAccountSettings(db, { subject: SUB_A, keybindings: { "editor.toggleVim": "Ctrl-x", "search.focus": "Ctrl-x" } })).rejects.toMatchObject({ statusCode: 400 }) // duplicate
    await expect(updateAccountSettings(db, { subject: SUB_A, keybindings: { "search.focus": "Mod-w" } })).rejects.toMatchObject({ statusCode: 400 }) // browser-reserved
  })

  it('SELF-SCOPE: updating A never touches B', async () => {
    await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: 'Only A', editorKeymap: 'vim', keybindings: { "editor.toggleVim": "Ctrl-Alt-b" } })
    const b = await getAccountSettings(db, { subject: SUB_B })
    expect(b.keybindings).toEqual({}) // B's keybindings untouched
    expect(b.displayNameOverride).toBeNull() // B untouched
    expect(b.editorKeymap).toBe('local')
  })

  it('avatar: a PNG is accepted; SVG and oversize are rejected; clear removes it', async () => {
    await setAvatar(db, app.storageDriver, { subject: SUB_B, dataBase64: PNG.toString('base64') })
    expect((await getAccountSettings(db, { subject: SUB_B })).hasAvatar).toBe(true)

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await expect(setAvatar(db, app.storageDriver, { subject: SUB_B, dataBase64: svg.toString('base64') }))
      .rejects.toMatchObject({ statusCode: 400 }) // public asset → no SVG (stored XSS)
    const big = Buffer.concat([PNG, Buffer.alloc(520 * 1024, 1)])
    await expect(setAvatar(db, app.storageDriver, { subject: SUB_B, dataBase64: big.toString('base64') }))
      .rejects.toMatchObject({ statusCode: 413 })

    await clearAvatar(db, app.storageDriver, { subject: SUB_B })
    expect((await getAccountSettings(db, { subject: SUB_B })).hasAvatar).toBe(false)
  })

  it('an unauthenticated request to /me/settings is rejected (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/settings', headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(401)
  })
})

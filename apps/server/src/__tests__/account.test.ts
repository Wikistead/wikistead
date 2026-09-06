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
import { linkMemberIdentity } from '../auth/member-identities.js'
import type { Tenant } from '@wikistead/types'
import { LANGS } from '@wikistead/i18n-shared'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const SUB_A = `acct-a-${Date.now().toString(36)}`
const SUB_B = `acct-b-${Date.now().toString(36)}`
const SUB_C = `acct-c-${Date.now().toString(36)}` // #961: local-door member who then LINKS a connection
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

let app: FastifyInstance
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  for (const sub of [SUB_A, SUB_B, SUB_C]) {
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${TENANT}, ${sub}, ${`${sub}@x.test`}, 'IdP Name', 'member')
      ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
  // #523 / ADR-190: display-name override is now LOCAL-user-only. SUB_A is a 'local' user so the
  // ADR-020 override tests below still exercise that (preserved) path; SUB_B stays 'oidc' (the default)
  // for the slice-B reject test. SUB_C starts 'local' too (#961: a password-door member who then LINKS
  // a connection mid-test — the restrictive union has to hold true for the door AND the link).
  await admin`UPDATE members SET identity_source = 'local' WHERE tenant_id = ${TENANT} AND sub IN (${SUB_A}, ${SUB_C})`
}, 30_000)

afterAll(async () => {
  // member_identities rows cascade with the member row (ON DELETE CASCADE) — no separate cleanup.
  await admin`DELETE FROM members WHERE sub IN (${SUB_A}, ${SUB_B}, ${SUB_C})`.catch(() => {})
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

  // #523 / ADR-190 §2 (slice B): an OIDC-sourced member cannot override their display name — the IdP is
  // authoritative (anti-impersonation). The server refuses the write (403); a 'local' user (SUB_A above)
  // still may. A refused override never touches the row, and OTHER settings on the same member are
  // unaffected (the reject is scoped to the override field).
  it('an OIDC member cannot override their display name (403); a local member can', async () => {
    // SUB_B is oidc (the default) → the override is refused and the row is never written. (No other
    // field is touched here — SUB_B stays the "untouched member" the later tests rely on.)
    await expect(updateAccountSettings(db, { subject: SUB_B, displayNameOverride: 'Impostor' }))
      .rejects.toMatchObject({ statusCode: 403 })
    const [row] = await admin<{ display_name_override: string | null }[]>`SELECT display_name_override FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB_B}`
    expect(row!.display_name_override, 'the refused override never wrote').toBeNull()
    // the local user (SUB_A) override path is unchanged (identity_source = 'local' set in beforeAll)
    expect((await updateAccountSettings(db, { subject: SUB_A, displayNameOverride: 'Local Choice' })).displayNameOverride).toBe('Local Choice')
  })

  // #961 / ADR-259 §3.7: the RESTRICTIVE UNION. `identity_source` alone was the exploit rev1's rule
  // reopened — SUB_C signs in through the password door (identity_source stays 'local' forever; the
  // login upsert never touches it) but has ALSO linked an OIDC connection, which is an IdP-asserted way
  // in just as real as SUB_B's. Break-check: guard identity_source alone and this test's second
  // assertion reddens.
  it('a local (password-door) member who has LINKED a provider may not override either, and linking clears an existing override in the same write', async () => {
    await updateAccountSettings(db, { subject: SUB_C, displayNameOverride: 'Before Link' })
    expect((await getAccountSettings(db, { subject: SUB_C })).displayNameOverride).toBe('Before Link')

    await linkMemberIdentity(db, TENANT, `961-conn-${SUB_C}`, `961-ext-${SUB_C}`, SUB_C)

    // §5: the link write clears the existing override in the SAME write — the person is told rather
    // than finding their old choice silently outlive a guard that would now refuse it.
    expect((await getAccountSettings(db, { subject: SUB_C })).displayNameOverride, 'cleared by the link write').toBeNull()

    // and going forward, SUB_C is refused — identity_source is still 'local', so a guard reading only
    // that column would wrongly allow this.
    await expect(updateAccountSettings(db, { subject: SUB_C, displayNameOverride: 'After Link' }))
      .rejects.toMatchObject({ statusCode: 403 })
    const [row] = await admin<{ display_name_override: string | null }[]>`SELECT display_name_override FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB_C}`
    expect(row!.display_name_override, 'the refused override never wrote').toBeNull()
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

  it('vim clipboard mode round-trips (off/paste), defaults to off, rejects invalid (ADR-105 / #225)', async () => {
    expect((await getAccountSettings(db, { subject: SUB_B })).editorVimClipboard).toBe('off') // null → 'off' (pure vim)
    for (const m of ['paste', 'off'] as const) {
      expect((await updateAccountSettings(db, { subject: SUB_A, editorVimClipboard: m })).editorVimClipboard).toBe(m)
    }
    // 'full' is deliberately NOT a value (ruled out on #225/) — it must 400 like any junk.
    for (const bad of ['full', 'unnamedplus', '']) {
      await expect(updateAccountSettings(db, { subject: SUB_A, editorVimClipboard: bad })).rejects.toMatchObject({ statusCode: 400 })
    }
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

  // #1007 / ADR-260 §3.1/§3.2/§6.2: the member's mail-language override — validated against the
  // shared LANGS (#1006), stored on members.locale (#1005). Unset (null) is the default; an explicit
  // null CLEARS it back to that default, same shape as displayNameOverride above.
  it('language round-trips (every registered language), defaults to null (unset), rejects an unknown code, and null clears it', async () => {
    expect((await getAccountSettings(db, { subject: SUB_B })).language, 'unset by default').toBeNull()
    // #713-S2: reads LANGS rather than naming 'en'/'ja' directly, so a language added to the registry is
    // covered here without a second find-and-fix pass — the same reason detectLang() (apps/web) does.
    for (const l of LANGS) {
      expect((await updateAccountSettings(db, { subject: SUB_A, language: l })).language).toBe(l)
      const [row] = await admin<{ locale: string | null }[]>`SELECT locale FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB_A}`
      expect(row!.locale, 'the column agrees — not just the response').toBe(l)
    }
    await expect(updateAccountSettings(db, { subject: SUB_A, language: 'xx' })).rejects.toMatchObject({ statusCode: 400 })
    expect((await updateAccountSettings(db, { subject: SUB_A, language: null })).language, 'explicit null clears it').toBeNull()
    // self-scope: B untouched throughout
    expect((await getAccountSettings(db, { subject: SUB_B })).language).toBeNull()
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

  // #547 / ADR-196 §3 (S6): the email prefs round-trip on the same self-scope surface, with the ADR
  // defaults (immediate ON — the narrowing default — digest OFF) and boolean validation.
  it('email prefs: ADR defaults, round-trip, and type validation', async () => {
    const before = await getAccountSettings(db, { subject: SUB_B })
    expect(before.emailImmediate, 'immediate defaults ON').toBe(true)
    expect(before.emailDigest, 'digest defaults OFF (opt-in)').toBe(false)
    await updateAccountSettings(db, { subject: SUB_B, emailImmediate: false, emailDigest: true })
    const after = await getAccountSettings(db, { subject: SUB_B })
    expect(after.emailImmediate).toBe(false)
    expect(after.emailDigest).toBe(true)
    await expect(updateAccountSettings(db, { subject: SUB_B, emailImmediate: 'yes' as unknown as boolean }))
      .rejects.toMatchObject({ statusCode: 400 })
    await updateAccountSettings(db, { subject: SUB_B, emailImmediate: true, emailDigest: false }) // restore
  })

  it('an unauthenticated request to /me/settings is rejected (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/settings', headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(401)
  })
})

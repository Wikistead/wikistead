// #1008 / ADR-260 §3.3 §3.3a §5 §7 item 4: the mail catalogue's own acceptance walk.
//
// The chokepoint is "whatever composes an EmailMessage for EmailDriver.send" (§1), found rather than
// listed: the digest / mention / recovery-code builders are discovered by their own
// `registerEmailBuilder(...)` registration, and the two inline senders by their own `driver.send(` /
// `resolveTenantEmailDriver(...).send(` call — the same shape rev 1's directory-bounded walk missed
// (it would have left `routes/auth-local.ts` and `routes/members.ts` green and English). `layout.ts`
// (the shared shell) and `routes/email-unsubscribe.ts` (a raw HTML reply, not an EmailMessage) do not
// share either call shape, so they are named by the measurement in §1 rather than rediscovered here.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as catalog from '../email/catalog.js'
import { buildRecoveryMintedEmail, buildRecoveryUsedEmail } from '../email/security-builder.js'
import { LANGS } from '../locale.js'

const SERVER = resolve(import.meta.dirname, '..')

function allSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { if (entry !== 'dist' && entry !== '__tests__') walk(p) }
      else if (/\.ts$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p)
    }
  }
  walk(SERVER)
  return out
}

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n')

const read = (rel: string): string => withoutComments(readFileSync(join(SERVER, rel), 'utf8'))

describe('#1008: the chokepoint is found, not listed', () => {
  const sources = allSources().map((p) => ({ path: p, rel: p.slice(SERVER.length + 1), text: withoutComments(readFileSync(p, 'utf8')) }))

  // ⚠️ `outbox.ts` is the machinery, not a composing site: it DECLARES `registerEmailBuilder` and it
  // forwards `built.message` to `driver.send(...)` — a message some builder composed. It matches both
  // shapes below and holds no prose of its own, so it is excluded by the declaration it owns rather
  // than by its name; a file that merely calls either is still discovered.
  const isTheRegistry = (t: string): boolean => /(?:function|const)\s+registerEmailBuilder\b/.test(t)
  const composing = sources.filter((s) => !isTheRegistry(s.text))
  const builders = composing.filter((s) => /registerEmailBuilder\(/.test(s.text)).map((s) => s.rel)
  const inlineSenders = composing.filter((s) => /driver\.send\(|resolveTenantEmailDriver\([^)]*\)\.send\(/.test(s.text)).map((s) => s.rel)

  it('discovers the four builder-registering files and the two inline senders', () => {
    // A floor, not a ceiling (#623's own lesson: an empty walk must not read as "nothing to check").
    // If this count changes because a new mail class or send site was added, it belongs in the ADR's
    // §1 table too, not just here. #1051 / ADR-275 rev3 §4 added the fourth: the SCIM deferral notice
    // was written FROM THE START against the catalogue (no former literal to migrate), so it belongs
    // here and in the discovery list but not in `FORMER_LITERALS`/`CHOKEPOINT_FILES` below, which are
    // #1008's own historical migration scope.
    expect(builders.sort(), 'registerEmailBuilder(...) call sites').toEqual(
      ['email/digest.ts', 'email/mention-builder.ts', 'email/security-builder.ts', 'email/scim-offboarding-builder.ts'].sort(),
    )
    expect(inlineSenders.sort(), 'direct driver.send(...) call sites').toEqual(
      ['routes/auth-local.ts', 'routes/members.ts'].sort(),
    )
  })
})

// §1's seven measured files. `layout.ts` and `email-unsubscribe.ts` are added by name (see the file
// header) rather than by the structural discovery above.
const CHOKEPOINT_FILES = [
  'email/digest.ts', 'email/mention-builder.ts', 'email/security-builder.ts', 'email/layout.ts',
  'routes/email-unsubscribe.ts', 'routes/auth-local.ts', 'routes/members.ts',
]

// Every reader-facing English sentence this ticket extracted, by its origin file. Break-check #1
// (§5): reintroduce any one of these as a raw literal in its file and this reddens. Break-check #3
// `routes/auth-local.ts`'s own entries are exactly the one rev 1's directory-bounded walk would have
// missed.
const FORMER_LITERALS: Record<string, string[]> = {
  // `>open<` is the anchor text this ticket found still English AFTER the catalogue existed: every
  // entry was translated and the mail was not, because the word sat in the builder's own markup.
  'email/digest.ts': ['Your digest:', 'Stop these emails:', '>open<'],
  'email/mention-builder.ts': ['You were mentioned in "', 'Open the page:', 'Stop these emails:'],
  'email/security-builder.ts': [
    'Recovery codes were created for your account', 'A recovery code was used on your account',
    'A new set of recovery codes was created for your account.',
    'Keep the codes somewhere you can reach without your phone.',
    'A recovery code was used to get back into your account.',
    'If this was not you, sign in and re-mint your recovery codes',
  ],
  'email/layout.ts': ['Powered by'],
  'routes/email-unsubscribe.ts': [
    'Unsubscribe from ', 'Stop receiving ', 'This turns off ', '>Unsubscribe<',
    'Unsubscribed. You can re-enable', 'mention email', 'digest email',
  ],
  'routes/auth-local.ts': [
    'Reset your ', 'Someone asked to reset the password for this address.',
    'Choose a new password', 'If it was not you, you can ignore this',
  ],
  'routes/members.ts': ["You're invited to ", "You've been invited to join ", 'Accept your invitation'],
}

describe('#1008: no chokepoint file holds a reader-facing literal any more', () => {
  it('the literal registry itself is not empty (break-check: an emptied walk must redden)', () => {
    const total = Object.values(FORMER_LITERALS).reduce((n, l) => n + l.length, 0)
    expect(total).toBeGreaterThan(20)
    expect(Object.keys(FORMER_LITERALS).sort()).toEqual([...CHOKEPOINT_FILES].sort())
  })

  for (const file of CHOKEPOINT_FILES) {
    it(`${file} no longer contains its former English literals`, () => {
      const text = read(file)
      for (const literal of FORMER_LITERALS[file]!) {
        expect(text.includes(literal), `"${literal}" should now live in email/catalog.ts, not ${file}`).toBe(false)
      }
    })
  }

  it('digest.ts reads the SIX shared event-type labels rather than its own table', () => {
    const text = read('email/digest.ts')
    expect(text, 'the local SAID table is retired').not.toMatch(/const SAID/)
    expect(text, 'labels now come from the package both apps depend on').toMatch(/EVENT_TYPE_LABELS/)
    expect(text).toMatch(/@wikistead\/i18n-shared/)
  })
})

describe('#1008 / §3.3a: the escape helper is exported once, not copied', () => {
  // `security-builder.ts` and `routes/email-unsubscribe.ts` already imported the shared one before
  // this ticket; the two that redeclared it locally are the ones this slice collapses.
  for (const file of ['email/digest.ts', 'email/mention-builder.ts']) {
    it(`${file} imports esc rather than redeclaring it`, () => {
      const text = read(file)
      expect(text, 'no local re-declaration').not.toMatch(/const esc\s*=/)
      expect(text, 'imports the one layout.ts exports').toMatch(/from '\.\/layout\.js'/)
    })
  }
})

describe('#1008 / §3.3a: no catalogue entry carries markup', () => {
  // The ADR's rule, measured: "no catalogue entry carries markup, and no new sanitiser is added".
  // An entry that returned `<a href="${'${'}url}">…</a>` would move the escape boundary INTO this file,
  // where the caller can no longer see it — which is how the second, quieter escaping rule gets
  // written. The builder writes the tags; the catalogue only ever holds words.
  for (const [name, fn] of Object.entries(catalog)) {
    if (typeof fn !== 'function') continue
    it(`${name} returns text, not HTML`, () => {
      // #1160 / #713-S6: every registered language, not just en/ja — a new arm holding a stray
      // `<a href>` (e.g. copied from a different mail system's template) would only be caught here.
      for (const lang of LANGS) {
        const out = (fn as (...a: unknown[]) => string)(lang, 'x', 1, 'y', 'z')
        expect(out, `${name} must hold words only — the builder writes the markup around them`)
          .not.toMatch(/<\/?[a-z][^>]*>/i)
      }
    })
  }
})

describe('#1008 / §5: a shipped builder, not the catalogue functions', () => {
  // ⚠️ Everything above measures `catalog.ts` in isolation, which cannot see the failure this slice
  // actually shipped once: prose that lives in a BUILDER's markup (the digest's `open`). This walks
  // the one builder that composes a whole EmailMessage without touching the database, and judges the
  // rendered result the way a reader would — no English left in a Japanese mail.
  const branding = { productName: 'Wikistead', displayName: 'テスト社', logoUrl: null, whitelabel: false }
  const rows = [{}] as unknown as Parameters<typeof buildRecoveryMintedEmail>[0]

  // Reader-facing words, with the parts that are deliberately not translated removed: markup, links,
  // and the deployment's own product name.
  const foreignWords = (s: string): string[] =>
    (s.replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ').split('Wikistead').join(' ')
      .match(/[A-Za-z]{3,}/g) ?? [])

  it("the recovery notice is entirely Japanese for a 'ja' recipient (subject, both parts)", async () => {
    const built = await buildRecoveryMintedEmail(rows, { tenantId: 't', baseUrl: null, branding, locale: 'ja' })
    expect(built.kind).toBe('send')
    const msg = (built as { message: { subject: string; text: string; html: string } }).message
    expect(msg.subject).toContain('リカバリーコード')
    expect(foreignWords(msg.subject), 'the subject').toEqual([])
    expect(foreignWords(msg.text), 'the text part').toEqual([])
    expect(foreignWords(msg.html), 'the html part — where a builder-written label would hide').toEqual([])
    expect(msg.html, 'the text body is still rendered as paragraphs').toContain('<p>')
  })

  it('the same builder in en is English (the detector above is not vacuous)', async () => {
    const built = await buildRecoveryUsedEmail(rows, { tenantId: 't', baseUrl: null, branding, locale: 'en' })
    const msg = (built as { message: { text: string } }).message
    expect(foreignWords(msg.text).length, 'an English mail is full of English words').toBeGreaterThan(5)
  })
})

describe('#1008 / §3.3a: each entry is genuinely translated', () => {
  // Every export is a (lang, ...args) => string function (the `byLang` shape). Calling each with
  // dummy args for every registered language proves no branch is empty and every non-English one
  // differs from English — a stub that returned the English string for another language too would pass
  // every literal-absence check above and still ship English mail, which is the failure this ADR
  // exists to prevent.
  //
  // #1160 / #713-S6: widened from 'ja' only to every language in LANGS. `byLang`'s `Record<Lang, ...>`
  // shape already makes a MISSING language a compile error (TypeScript's own exhaustiveness check)
  // this pin catches the narrower, compile-invisible mistake: an entry present for every language but
  // with the wrong CONTENT (e.g. the English string copy-pasted into a non-English slot).
  const DUMMY = ['x', 1, 'y', 'z']
  const NON_ENGLISH = LANGS.filter((l) => l !== 'en')
  for (const [name, fn] of Object.entries(catalog)) {
    if (typeof fn !== 'function') continue
    it(`${name}: every non-English language is non-empty and differs from 'en'`, () => {
      const en = (fn as (...a: unknown[]) => string)('en', ...DUMMY)
      expect(typeof en).toBe('string')
      for (const lang of NON_ENGLISH) {
        const out = (fn as (...a: unknown[]) => string)(lang, ...DUMMY)
        expect(out.length, `${name}(${lang}) must not be empty`).toBeGreaterThan(0)
        expect(out, `${name} must not fall back to English prose for '${lang}'`).not.toBe(en)
      }
    })
  }

  it('the catalogue module exports more than a handful of entries (a floor, not a ceiling)', () => {
    const count = Object.values(catalog).filter((v) => typeof v === 'function').length
    expect(count).toBeGreaterThan(20)
  })
})

// #741 / ADR-239 (a): the screen vocabulary the documentation is checked against.
//
// The words are not written down anywhere in this repo — only the KEYS are, and the artifact resolves
// them out of the locale files so a rename moves the check instead of breaking it (#731, after
// #732 renamed a pile of labels on the day that check landed).
//
// That indirection has two ends, and both can rot silently. A key can outlive the string it names, in
// which case the docs-site check would demand a word nobody can look up; and a surface id can outlive
// the surface, in which case the check guards a screen that no longer exists. Neither shows up as a
// broken build in the repository where the damage lands, so both are pinned here.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs declaration, deliberately not a TS module (see commit for #621)
import { SCREEN_VOCABULARY } from '../../../../scripts/screen-vocabulary.mjs'
// @ts-expect-error — same
import { SURFACE_DOCS } from '../../../../scripts/doc-code-map.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const artifact = join(repoRoot, 'docs/generated/screen-vocabulary.json')
const bundle = (locale: string) =>
  JSON.parse(readFileSync(join(repoRoot, `apps/web/src/i18n/locales/${locale}.json`), 'utf8')) as
    Record<string, Record<string, string>>

const spec = SCREEN_VOCABULARY as Record<string, { ns: string; keys: string[] }>

describe('#741 / ADR-239: the screen vocabulary names things that exist', () => {
  it('every declared surface is one the documentation ledger knows', () => {
    // A surface id that no longer exists would make the docs-site check guard a screen nobody has —
    // and it would stay green there, because a page that claims nothing is simply not checked.
    const known = new Set(Object.keys((SURFACE_DOCS as Record<string, Record<string, unknown>>)['admin-surface'] ?? {}))
    expect(known.size, 'the ledger has admin surfaces to check against').toBeGreaterThan(5)
    for (const id of Object.keys(spec)) {
      const [kind, name] = id.split(':')
      expect(kind, `${id} is not a <kind>:<name> id`).toBe('admin-surface')
      expect(known.has(name!), `${id} names a surface the ledger does not have`).toBe(true)
    }
  })

  it('every declared key resolves in every locale', () => {
    // The generator throws on a missing string, so this is the same fact said where a reader of the
    // declaration will look. A key that has lost its string is a word the docs are asked to contain
    // and nobody can find.
    const en = bundle('en')
    const ja = bundle('ja')
    for (const [id, s] of Object.entries(spec)) {
      expect(s.keys.length, `${id} declares no keys — an empty vocabulary cannot be documented wrongly`).toBeGreaterThan(0)
      for (const key of s.keys) {
        expect(en[s.ns]?.[key], `${id}: en is missing ${s.ns}.${key}`).toBeTruthy()
        expect(ja[s.ns]?.[key], `${id}: ja is missing ${s.ns}.${key}`).toBeTruthy()
      }
    }
  })

  it('the committed artifact carries the words the locale files hold right now', () => {
    // The stale-guard, said against the LOCALE FILES rather than against the renderer: `docs:check`
    // already compares the file with the renderer's output, and a pin that did the same would only
    // agree with it. This one fails if a label is renamed and the artifact is not regenerated, which
    // is the case the indirection exists for.
    const { surfaces } = JSON.parse(readFileSync(artifact, 'utf8')) as
      Record<string, Record<string, Record<string, { en: string; ja: string }>>>
    const en = bundle('en')
    const ja = bundle('ja')
    for (const [id, s] of Object.entries(spec)) {
      for (const key of s.keys) {
        expect(surfaces?.[id]?.[key], `${id}.${key} is missing from the artifact — run \`pnpm docs:gen\``)
          .toEqual({ en: en[s.ns]![key], ja: ja[s.ns]![key] })
      }
    }
  })
})

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

/**
 * The one kind of surface the vocabulary accepts. Macros, web routes and capabilities are in the
 * documentation ledger too, but ADR-239's check is about ADMIN SCREENS — it resolves product words
 * out of the locale files, and those three have no screen whose buttons could be named. Declared
 * here because two things depend on it: what a declared id may be, and what the coverage is out of.
 */
const ARMABLE_KIND = 'admin-surface'

describe('#741 / ADR-239: the screen vocabulary names things that exist', () => {
  it('every declared surface is one the documentation ledger knows', () => {
    // A surface id that no longer exists would make the docs-site check guard a screen nobody has —
    // and it would stay green there, because a page that claims nothing is simply not checked.
    const known = new Set(Object.keys((SURFACE_DOCS as Record<string, Record<string, unknown>>)[ARMABLE_KIND] ?? {}))
    expect(known.size, 'the ledger has admin surfaces to check against').toBeGreaterThan(5)
    for (const id of Object.keys(spec)) {
      const [kind, name] = id.split(':')
      expect(kind, `${id} is not a <kind>:<name> id`).toBe(ARMABLE_KIND)
      expect(known.has(name!), `${id} names a surface the ledger does not have`).toBe(true)
    }
  })

  it('says how much of the product is armed, and how much is not', () => {
    // #837: staged arming is a ruling, not a shortcut — a first run that reddened every admin page
    // would have been paid off by deleting the check. But "armed one surface" and "armed most of
    // them" must not read the same, and today only the count can tell them apart: the docs-site
    // check looks at pages that CLAIM a surface, so a surface nobody claims is invisible there.
    const armed = Object.keys(spec)
    const ledger = Object.entries(SURFACE_DOCS as Record<string, Record<string, string>>)
      .flatMap(([kind, entries]) => Object.keys(entries).map((name) => `${kind}:${name}`))
    // #846: the denominator is the surfaces that CAN be armed, which the test above pins to a single
    // kind — the vocabulary refuses anything else. Counting all four kinds reported "3 armed, 67 not
    // yet", and a reader took that 4% at face value: it became "arm ten more" in an ADR, which is 62%
    // of the ledger rather than the modest step it looked like. The out-of-scope kinds are still
    // counted, and said out loud, because a surface that can never be armed is a different fact from
    // one that simply has not been.
    const armable = ledger.filter((id) => id.startsWith(`${ARMABLE_KIND}:`))
    const unarmed = armable.filter((id) => !armed.includes(id))
    const outOfScope = ledger.length - armable.length
    // Reported on every run, so the number is visible in the log rather than only when it breaks.
    console.error(
      `screen vocabulary: ${armed.length} of ${armable.length} armable surface(s) armed, ${unarmed.length} not yet` +
        `; ${outOfScope} surface(s) out of scope (the vocabulary only takes ${ARMABLE_KIND})`,
    )

    expect(ledger.length, 'the surface ledger is empty — nothing could be armed or unarmed').toBeGreaterThan(10)
    // The split has to be real on both sides, or the sentence above is arithmetic over nothing.
    expect(armable.length, 'no armable surface in the ledger — the kind name has drifted').toBeGreaterThan(5)
    expect(outOfScope, 'every surface is armable — then this denominator no longer needs explaining').toBeGreaterThan(0)
    // A floor, not a target. #790 cannot start until three surfaces exist to derive from, which is
    // why three is the number: it is somebody else's unlock condition, not a round figure.
    expect(armed.length, 'fewer surfaces armed than #790 needs to derive from').toBeGreaterThanOrEqual(3)
    // #1063: the staged-arming floor above (unarmed.length > 0) held from #837 through #1063's own
    // slice — proof the count was not vacuous, since a bootstrap of pure zeros can't be told from a
    // broken counter. #1063 armed the last of the 16 admin-surface entries the ledger had at the
    // time, and that floor's own failure message said what to do: raise it. Flipped to a completion
    // invariant instead of deleted, unlike the residue list #759's mechanism removed when it
    // emptied — a NEW admin-surface can be added to SURFACE_DOCS at any point (the product keeps
    // growing screens), and when one is, THIS assertion goes red for it immediately rather than
    // letting it sit unarmed and uncounted the way the old floor tolerated. That is a stronger
    // invariant than the one it replaces, not a weaker one.
    expect(armed.length, 'a ledger surface exists that nothing has armed yet — see the console line above for which').toBe(armable.length)
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

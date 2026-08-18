// #725② — the fidelity report speaks the reader's language, and stays that way.
//
// A Japanese workspace read this screen's headings and prose in Japanese and the one thing it exists
// to convey — WHAT was lost — in English, because the server composed those sentences and the screen
// printed them through. The fix moved the wording to the screen, keyed on a code the server sends.
//
// That fix has a failure mode of its own, and it is quiet: a new adapter adds a degradation, nobody
// writes the Japanese, and the screen falls back to the server's English. The reader sees the same
// defect this ticket was opened for, and no test is red. So this walk is DISCOVERY-shaped — it reads
// the code list itself rather than a list somebody remembers to extend, and every code has to be
// worded in every locale the product ships.
//
// It lives on the server side because that is where the codes are, and importing the real constant
// beats parsing the source for an array literal. The locale bundles are read from disk: the web app
// is a separate package, and a JSON file is a JSON file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEGRADATION_CODES } from '../import/index.js'

const LOCALES = ['en', 'ja'] as const
const bundle = (l: string) => JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../../apps/web/src/i18n/locales', `${l}.json`), 'utf8')) as
  { import: { degraded?: Record<string, string>; degradedDetail?: Record<string, string> } }

describe('#725 ②: every degradation the server can report has words in every locale', () => {
  it('the code list is not empty — a walk over nothing is green for the wrong reason', () => {
    // The failure this guards is the one a discovery test dies of: the list moves or is renamed, the
    // loop below runs zero times, and a suite reports success having checked nothing.
    expect(DEGRADATION_CODES.length).toBeGreaterThan(15)
  })

  it('each code has a heading in en and in ja', () => {
    for (const l of LOCALES) {
      const words = bundle(l).import.degraded ?? {}
      const missing = DEGRADATION_CODES.filter((c) => !words[c]?.trim())
      expect(missing, `${l}: no wording for ${missing.join(', ')}`).toHaveLength(0)
    }
  })

  it('a code worded in one locale is worded in both — that is how a gap turns into English', () => {
    // Asserted as a SET comparison rather than per-code, because the asymmetric case is the real
    // one: somebody adds English at the same moment they add the code, and Japanese arrives later
    // or never. Details are optional (several kinds have nothing to add beyond the page name), but
    // a detail written in one language and not the other is the same defect in miniature.
    const heads = LOCALES.map((l) => Object.keys(bundle(l).import.degraded ?? {}).sort())
    expect(heads[1], 'ja headings match en headings').toEqual(heads[0])
    const details = LOCALES.map((l) => Object.keys(bundle(l).import.degradedDetail ?? {}).sort())
    expect(details[1], 'ja details match en details').toEqual(details[0])
  })

  it('the ja wording is not the English left in place', () => {
    // The gap does not have to be a missing key. A copied English string satisfies every check
    // above while showing the reader exactly what they complained about.
    const en = bundle('en').import.degraded ?? {}
    const ja = bundle('ja').import.degraded ?? {}
    const copied = DEGRADATION_CODES.filter((c) => ja[c] && ja[c] === en[c])
    expect(copied, `ja is still English for: ${copied.join(', ')}`).toHaveLength(0)
    // …and it is actually Japanese, rather than a transliteration with no Japanese in it at all.
    const noJapanese = DEGRADATION_CODES.filter((c) => !/[ぁ-んァ-ヶ一-龠]/.test(ja[c] ?? ''))
    expect(noJapanese, `no Japanese in: ${noJapanese.join(', ')}`).toHaveLength(0)
  })

  it('every interpolation a wording asks for is one the server actually sends', () => {
    // A `{{target}}` in the Japanese that the code never populates renders the braces at the reader.
    // Both locales are checked against the SAME code, so a translator inventing a variable is caught
    // even when the English is right.
    const detail = Object.fromEntries(LOCALES.map((l) => [l, bundle(l).import.degradedDetail ?? {}]))
    for (const code of DEGRADATION_CODES) {
      const vars = LOCALES.map((l) => [...(detail[l]![code] ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort())
      expect(vars[1], `${code}: ja interpolates different variables from en`).toEqual(vars[0])
    }
  })
})

// #293(owner ruling, 2026-08-18): the no-PR policy must never read as permanent.
//
// The ruling is about a future cost, not about today's policy. ADR-033's no-PR stance stands; what
// the owner asked for is that the SENTENCE be written so that opening up later is an update to the
// wording rather than a retraction of a promise — "we do not accept pull requests" is a thing you
// have to take back, "we are not accepting pull requests at this time" is not.
//
// It is checked rather than remembered because this is a prose rule on files nobody edits often, on
// the repository's front page, and prose rules of exactly this shape are the ones this project keeps
// re-learning (#585's dashes came back in 42 files while a pin sat one directory away). The cost of
// the rule holding is zero today: all three statements already carry a limiter, measured below. What
// this pin buys is the day somebody tidies one of them.
//
// DISCOVERY, not a list: the walk finds the statements. A `CONTRIBUTING.ja.md` added tomorrow, or a
// fourth place that says the same thing, is in scope on the day it lands — which is the half a
// hand-written list of files always loses.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(import.meta.dirname, '../../../..')

/** The reader-facing prose of the public repository: its front page and its community-health files. */
function publicProse(): string[] {
  const out: string[] = []
  for (const name of readdirSync(repoRoot)) {
    if (/^(README|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.[a-z-]+)?\.md$/i.test(name)) out.push(join(repoRoot, name))
  }
  const gh = join(repoRoot, '.github')
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(md|ya?ml)$/i.test(name)) out.push(p)
    }
  }
  walk(gh)
  return out
}

// A sentence that REFUSES pull requests — the VERB and its OBJECT together.
//
// ⚠️ Written loose first, and it caught three things that are not the policy: CONTRIBUTING's own
// back-reference ("because of the no-PR policy above…") and two workflow lines where "opens no PR"
// describes what a CI job does. A bare `no-PR` is not a refusal; refusing is "not accepting" plus
// the thing being refused, in either order, which is what this matches. Still loose enough to catch
// a rephrasing, because a rephrasing is exactly when the limiter goes missing.
const EMPH = String.raw`[\s*_]+` // markdown emphasis sits INSIDE these phrases ("does **not** currently accept")
// ⚠️ The noun phrase spans a LINE BREAK on the front page ("External pull\nrequests are not
// accepted at this time"), so `pull request` as a literal missed the one file that matters most.
const NOUN = String.raw`(?:pull\s+request|contribution)s?`
const REFUSAL = new RegExp(
  String.raw`(?:do(?:es)?${EMPH}not${EMPH}(?:currently${EMPH})?accept|not${EMPH}accept(?:ing)?)[^.]{0,80}?(?:${NOUN}|\bPR\b)` +
    String.raw`|${NOUN}[^.]{0,80}?(?:are|is)${EMPH}not${EMPH}accept`,
  'gi',
)
// …and the limiters that keep it from reading as forever, in either language the repo might use.
const LIMITER = /\b(?:at this time|for now|currently|right now|at present|for the time being)\b|現時点|当面|いまのところ|今のところ/i

describe('#293the no-PR policy is written as a state, not as a promise', () => {
  const files = publicProse()

  it('the walk sees the files it is supposed to see', () => {
    // A discovery pin that discovered nothing is the failure mode this repository keeps meeting.
    const names = files.map((f) => relative(repoRoot, f))
    expect(names, 'the front page is in scope').toContain('README.md')
    expect(names, 'the contributing guide is in scope').toContain('CONTRIBUTING.md')
    expect(names.some((n) => /PULL_REQUEST_TEMPLATE/i.test(n)), 'the PR template is in scope').toBe(true)
  })

  it('every statement that refuses pull requests carries a limiter', () => {
    const offenders: string[] = []
    let statements = 0
    for (const file of files) {
      const rel = relative(repoRoot, file)
      const text = readFileSync(file, 'utf8')
      // ⚠️ Scanned by SENTENCE, not by line. The README's statement is wrapped across two lines
      // ("External pull / requests are not accepted at this time"), so a line-by-line walk saw
      // neither half and called the front page clean — the one file that matters most.
      for (const m of text.matchAll(REFUSAL)) {
        statements++
        const from = Math.max(0, text.lastIndexOf('.', m.index) + 1)
        const dot = text.indexOf('.', m.index + m[0].length)
        const sentence = text.slice(from, dot === -1 ? text.length : dot + 1)
        if (LIMITER.test(sentence)) continue
        const line = text.slice(0, m.index).split('\n').length
        offenders.push(`${rel}:${line}  ${sentence.trim().replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    // …and the pin must be measuring something: four statements exist today (the README, the
    // CONTRIBUTING heading and its body, the PR template). If the count collapses, the pattern
    // stopped matching rather than the prose becoming clean.
    expect(statements, 'no-PR statements were found at all').toBeGreaterThanOrEqual(4)
    expect(
      offenders,
      'a refusal without "at this time" (or 現時点では) makes opening up later a retraction rather than an update:\n' +
        offenders.join('\n'),
    ).toEqual([])
  })
})

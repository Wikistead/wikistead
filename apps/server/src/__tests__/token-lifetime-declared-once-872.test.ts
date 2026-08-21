// #813 / ADR-248 §3.8: "how long does a guest's credential live" has one answer.
//
// It had three. The minter reads `GUEST_TOKEN_TTL_SECONDS ?? 300`; the HTTP verifier and the collab
// verifier each built a config of their own with `?? 3600`; a fourth site passed `ttlSeconds: 0` with
// a comment explaining that the field is ignored. The three extra values were dead — a verifier reads
// the expiry out of the token it is given — but the environment reference published 3600 as the
// default, so the one number an operator could actually look up was the wrong one.
//
// The fix is structural rather than a deletion: `verify*` takes `TokenSecret`, which has no lifetime
// to name, so a fifth answer cannot be written. This measures that the structure held.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SKIP = new Set(['node_modules', '.git', '.astro', 'dist', 'build', '.turbo', 'coverage', 'test-results', 'playwright-report'])

/** Every shipped and test source file, so a reader added anywhere is seen. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full)
  }
  return out
}

const VAR = 'GUEST_TOKEN_TTL_SECONDS'

describe('#813 the guest token lifetime is declared once', () => {
  const files = sources(REPO)

  it('the walk reads something (a broken walk looks exactly like a clean tree)', () => {
    expect(files.length, 'no source files walked — this file is measuring nothing').toBeGreaterThan(500)
  })

  it('exactly one shipped file answers the question', () => {
    // ⚠️ The predicate is "reads the variable WITH A FALLBACK", not "mentions the variable". Naming it
    // is fine and necessary — the environment catalogue documents it, and the guide lists it. What
    // must be unique is the DEFAULT: a default IS an answer, and two answers was the defect. Both
    // sides were counted before this was written: 1 shipped file pairs it with `??`, 2 shipped files
    // mention it at all.
    const shipped = files.filter((f) => !/__tests__|\.test\./.test(f))
    const answers = shipped.filter((f) =>
      new RegExp(`process\\.env\\.${VAR}\\s*\\?\\?`).test(readFileSync(f, 'utf8')))
    console.error(`#813: ${files.length} file(s) walked; ${answers.length} shipped file(s) answer "how long"`)
    expect(answers.map((f) => f.slice(REPO.length + 1))).toEqual(['apps/server/src/routes/share-links.ts'])
  })

  it('and the published reference says what that one file says', () => {
    const decider = readFileSync(join(REPO, 'apps/server/src/routes/share-links.ts'), 'utf8')
    const real = /GUEST_TOKEN_TTL_SECONDS\s*\?\?\s*(\d+)/.exec(decider)?.[1]
    expect(real, 'the minter no longer carries a literal default — this check has lost its subject').toBeTruthy()
    const row = readFileSync(join(REPO, 'docs/generated/environment-variables.md'), 'utf8')
      .split('\n').find((l) => l.includes(`\`${VAR}\``))
    expect(row, 'the reference has no row for it').toBeTruthy()
    // ⚠️ The reference is what an operator reads. It shipped 3600 while the code used 300, which is
    // worse than an undocumented knob: it is a documented wrong one.
    expect(row).toContain(`| ${real} |`)
  })

  it('a verifier cannot be handed a lifetime, so it cannot invent one', async () => {
    // The type is the guard; this asserts the type is the one in use rather than a stale copy of it.
    const auth = readFileSync(join(REPO, 'packages/auth/src/index.ts'), 'utf8')
    const verifiers = [...auth.matchAll(/export async function (verify\w+)\(cfg: (\w+),/g)]
    expect(verifiers.length, 'no verifiers found — the signature shape has drifted').toBeGreaterThan(3)
    for (const [, name, type] of verifiers) {
      expect(type, `${name} verifies, so it must not be able to name a lifetime`).toBe('TokenSecret')
    }
  })
})

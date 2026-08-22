// #898: the rule is written once, and this walks the tree to keep it that way.
//
// ⚠️ WHY A WALK. Finding the disagreement took a grep, and nobody greps again. #836 narrowed one copy
// of three because the other two were never listed; the copies were not hard to find, they were
// simply not looked for. So the looking is the pin: every place that asks "is there an exempt member
// holding a password" must ask `anAdminHoldsAKey`, and a fourth copy is red the day it appears.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = new URL('../', import.meta.url).pathname

// The predicate's own home writes the query — that IS the single rule. Nothing else is exempt: an
// allowlist that grows is the failure this file exists to catch, so a new entry needs a reason here.
// ⚠️ Every entry names the DIFFERENT question that site asks. "It joins the same tables" is not a
// reason; the walk exists because three sites asking the SAME question drifted apart. An entry whose
// reason cannot be written is a fourth copy.
const ALLOWED = new Map<string, string>([
  ['auth/login-methods.ts',
   'the single definition — anAdminHoldsAKey itself, which is what everything else must call'],
  ['routes/auth-local.ts',
   'asks whether ONE identifier is exempt while signing in — a per-person fact during a stance, not a count of who is left'],
  ['routes/admin-login-methods.ts',
   'LEFT JOIN listing every exemption and whether each holds a credential, for the admin screen — it reports the set, it does not gate a write on its size'],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('#898 one rule, one place', () => {
  const files = walk(SRC)

  it('the walk reaches the shipped tree', () => {
    // ⚠️ Without this, every assertion below passes on an empty list — the shape #892 is about. The
    // bound is a floor, not the count: it must not need editing when a file is added.
    expect(files.length, 'the walk found source files').toBeGreaterThan(100)
    const rels = files.map((f) => relative(SRC, f))
    expect(rels, 'and it reaches the file that defines the rule').toContain('auth/login-methods.ts')
    expect(rels, 'and the routes that consume it').toContain('routes/members.ts')
  })

  it('nothing but the predicate joins the exemption list to the credential table', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(SRC, f)
      const text = readFileSync(f, 'utf8')
      // Both table names in one SQL template is the shape of the question. A copy that asks it some
      // other way is not caught here, which is why the routes are ALSO pinned behaviourally
      // (`sso-floor-family-898`): this file catches the copy that looks like the ones we found.
      if (!/sso_exemptions/.test(text) || !/local_credentials/.test(text)) continue
      const joins = text
        .split('\n')
        .some((line) => /sso_exemptions/.test(line) && /local_credentials/.test(line))
      if (joins && !ALLOWED.has(rel)) offenders.push(rel)
    }
    expect(offenders, `a fourth copy of the SSO floor: ${offenders.join(', ')}`).toEqual([])
  })
})

// #884 every cookie this product sets is judged by the deploy gate.
//
// THE DEFECT the gate had: it decided what was "ours" from the `wks_` naming convention alone, and
// the tree already disagreed — `mcp_flow` binds an OAuth authorize to the browser that began it, and
// nothing checked that it was HttpOnly or Secure. Nothing was leaking (the call site sets both), so
// this is a hole in the INSPECTION, and a hole in an inspection is exactly what nobody notices.
//
// ⚠️ The pin that shipped with the row asked about `wks_something_new` — a name the test invented. A
// rule verified only against examples it made up cannot fail, which is why this one walks the tree
// and asserts what it found: a walk that matches nothing is a red, not a green.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isOwnCookie } from '../deploy/preflight'

const ROOT = resolve(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (e !== '__tests__' && e !== 'node_modules') walk(p, out) }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

// The convention the whole server follows: one `const <NAME>_COOKIE = '<name>'` per cookie, next to
// the code that sets it. Reading the declarations rather than the `setCookie` call sites is what lets
// a name defined in one file and used in another (SESSION_COOKIE, used by EE too) still be seen.
const DECLARATION = /const\s+\w*COOKIE\w*\s*(?::\s*\w+\s*)?=\s*'([^']+)'/g

describe('#884 the deploy gate judges every cookie this product sets', () => {
  const found = new Map<string, string>()
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(DECLARATION)) found.set(m[1]!, file.slice(ROOT.length + 1))
  }

  it('finds the cookie declarations at all', () => {
    // Without this, a renamed convention empties the walk and every case below passes on nothing.
    expect(found.size, `no cookie declarations under ${ROOT}`).toBeGreaterThanOrEqual(4)
    expect([...found.keys()], 'the session cookie is the one that must always be here').toContain('wks_sess')
  })

  it.each([...found.entries()])('judges %s (declared in %s)', (name) => {
    expect(isOwnCookie(name), `${name} is set by this product but the deploy gate ignores it`).toBe(true)
  })

  it('still ignores cookies this product did not set', () => {
    // The direction the fix must NOT take: failing a release over the load balancer's affinity hint
    // teaches an operator to skip the row, and a skipped row protects nothing.
    for (const foreign of ['AWSALB', 'INGRESSCOOKIE', 'JSESSIONID', '_ga']) {
      expect(isOwnCookie(foreign), `${foreign} is not ours`).toBe(false)
    }
  })
})

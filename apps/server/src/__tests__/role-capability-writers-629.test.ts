// #629, the discovery half: a role's capability set is an authorization decision wherever it is written.
//
// The escalation was not a missing check on one handler — it was a door nobody noticed was a door. The
// grant path had a ceiling; the EDIT path re-expanded the same capabilities into the same resources with
// only a tenant-wide gate. So this pin does not name today's `PUT /admin/roles/:roleId`: it walks every
// statement that writes `roles.capabilities` and requires each to be inside a handler that consults the
// grant ceiling (or to declare, in one line, why it needs no resource authority).
//
// Lexical because the subject is REACHABILITY, not behaviour: the route tests (role-edit-ceiling-629)
// prove the ceiling refuses, and a future PATCH or bulk editor would pass those tests by simply not
// existing yet. This is what notices the new door.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SRC = resolve(import.meta.dirname, '..')

function serverFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.ts$/.test(e.name)) out.push(p)
    }
  }
  walk(SRC)
  return out
}

/** Statements that put a capability set on a `roles` row — creation or edit, however it is spelled. */
function capabilityWriters(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = []
  for (const file of serverFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      const t = text.trim()
      const writesRoles = /INSERT INTO roles\b/i.test(t) || /UPDATE\s+roles\b/i.test(t)
      if (writesRoles) hits.push({ file: file.slice(SRC.length + 1), line: i + 1, text: t.slice(0, 120) })
    })
  }
  return hits
}

describe('#629: every writer of a role capability set answers to the grant ceiling', () => {
  it('the walk finds the writers (a scan over nothing proves nothing)', () => {
    const writers = capabilityWriters()
    expect(writers.length, `no role-capability writers found — the scan is broken, not the code`).toBeGreaterThanOrEqual(2)
  })

  it('each one sits in a handler that consults the ceiling, or says why it does not', () => {
    const offenders: string[] = []
    for (const w of capabilityWriters()) {
      const src = readFileSync(resolve(SRC, w.file), 'utf8')
      const lines = src.split('\n')
      // the enclosing handler, approximated by the 120 lines above the statement: far enough to reach the
      // route's own gates, near enough that a DIFFERENT handler's ceiling cannot vouch for this one
      const before = lines.slice(Math.max(0, w.line - 120), w.line).join('\n')
      const gated = /requireAssignmentAuthority\(/.test(before)
      // a creation with no assignments cannot escalate anybody — but it has to SAY so on the line
      const excused = /no-resource-authority-ok:/.test(lines[w.line - 1] ?? '') ||
        /no-resource-authority-ok:/.test(lines.slice(Math.max(0, w.line - 6), w.line).join('\n'))
      if (!gated && !excused) offenders.push(`${w.file}:${w.line} — ${w.text}`)
    }
    expect(offenders, 'a role capability written without the grant ceiling (or an explicit reason)').toEqual([])
  })

  it('the ceiling used is the SHARED one, not a second copy', () => {
    // three admin-class sets is how #607 described the failure it refused to create; the same applies
    // here — the edit door must call the function the grant door calls.
    const roles = readFileSync(resolve(SRC, 'routes/roles.ts'), 'utf8')
    expect(roles, 'the edit path calls the shared authority').toMatch(/requireAssignmentAuthority\(app\.fga/)
    expect(roles, 'and does not grow its own admin-class list').not.toMatch(/const\s+\w*ADMIN_CLASS\w*\s*=\s*new Set/)
  })
})

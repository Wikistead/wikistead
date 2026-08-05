// A fixture that seats a member and never unseats it does not fail — it makes some OTHER file fail,
// later, for a reason that file cannot see.
//
// Measured: `admin-surfaces-604` seated three synthetic members per run and removed the roles, the
// assignments and the tuples, but not the `members` rows. Nine of them accumulated in the shared
// `tenant_dev` of the test stack, which is a tenant whose SIZE two other files assert on — an invite
// refused with "seat limit reached" (`invite-role-582`), and a downgrade froze the member a fixture
// expected to survive (`plan-freeze`). Both reds were handed on twice as "red on clean master too",
// which was accurate and useless: the leak is in a third file, and nothing pointed there.
//
// So the rule is checked where it can be seen. Lexical, because the subject is a PROMISE about
// teardown: a file that seats has to unseat, and no assertion inside that file would ever notice.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const HERE = resolve(import.meta.dirname)
const SELF = 'fixture-seat-cleanup.test.ts'

function testFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'helpers') walk(p); continue }
      if (e.name.endsWith('.test.ts') && e.name !== SELF) out.push(p)
    }
  }
  walk(HERE)
  return out
}

describe('a fixture that seats a member gives the seat back', () => {
  it('the scan finds files that seat (a scan over nothing proves nothing)', () => {
    const seating = testFiles().filter((f) => /\bseatMembers\s*\(/.test(readFileSync(f, 'utf8')))
    expect(seating.length, 'no file seats members — the scan is broken, not the fixtures').toBeGreaterThan(0)
  })

  it('every one of them also unseats', () => {
    const offenders: string[] = []
    for (const file of testFiles()) {
      // comments stripped: a call that has been commented out is not a call, and a scan that counts it
      // cannot go red when the cleanup is removed — measured, on this pin, before the strip was added
      const src = readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      if (!/\bseatMembers\s*\(/.test(src)) continue
      // `unseatMembers` is the shared helper, but a file that deletes the rows itself has kept the
      // promise too — what is forbidden is walking away from them.
      const returns = /\bunseatMembers\s*\(/.test(src) || /DELETE FROM members\b/i.test(src)
      if (!returns) offenders.push(file.slice(HERE.length + 1))
    }
    expect(offenders, 'seats a member into the shared tenant and never gives it back — the next file to assert on the tenant SIZE pays for it').toEqual([])
  })
})

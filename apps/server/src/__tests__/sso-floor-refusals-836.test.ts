// #836 / #898: the floor's refusals are written once, and this walks the tree to keep it that way.
//
// ⚠️ WHY THIS EXISTS BESIDE `sso-floor-single-rule-898`. That one keeps the QUESTION single; this one
// keeps the ANSWER single. They drifted separately: after the predicate was unified, four sites still
// carried their own sentence, and one of them had lost the clause (`and the one who can fix things`)
// that says WHY an ordinary member will not do — on the write that deletes a credential, which is the
// exact case #898 filed. Aligning strings by hand is what the next edit undoes.
//
// ⚠️ AND WHY THE WORD MATTERS. `anAdminHoldsAKey` asks whether an exempt ADMINISTRATOR holds a
// password. A refusal that says "member" instructs the operator to exempt an ordinary one — walking
// them back into the state the floor exists to prevent: people who can sign in while the IdP is down
// and nobody among them who can fix anything. The refusal is the only instruction they get.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SSO_FLOOR_REFUSAL } from '../auth/login-methods.js'

const SRC = new URL('../', import.meta.url).pathname
const HOME = 'auth/login-methods.ts' // where the sentences live

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p, out) }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }))
const refusing = files.filter((f) => f.src.includes('sso_exemption_required'))

describe('#836 the floor answers with one set of sentences', () => {
  it('the walk reaches the shipped tree', () => {
    // Without this the cases below pass on an empty list the day the code moves.
    expect(files.length, `no shipped .ts under ${SRC}`).toBeGreaterThan(50)
    expect(refusing.length, 'no site answers sso_exemption_required — did the code move?').toBeGreaterThanOrEqual(2)
  })

  it.each(refusing.map((f) => [f.rel, f] as const))('%s reads its sentence from the one place', (rel, f) => {
    expect(f.src, `${rel} answers sso_exemption_required with a sentence of its own`).toContain('SSO_FLOOR_REFUSAL')
  })

  it('and no site outside its home carries one of the sentences as a literal', () => {
    for (const sentence of Object.values(SSO_FLOOR_REFUSAL)) {
      // A prefix, not the whole sentence: a copy that drifted a clause — which is what happened —
      // still starts the same way, and comparing whole strings is exactly what misses it.
      const prefix = sentence.slice(0, 40)
      for (const f of files) {
        if (f.rel === HOME) continue
        expect(f.src.includes(prefix), `${f.rel} carries its own copy of "${prefix}…"`).toBe(false)
      }
    }
  })

  it('⚠️ every refusal names an ADMINISTRATOR, because that is who the predicate counts', () => {
    for (const [key, sentence] of Object.entries(SSO_FLOOR_REFUSAL)) {
      expect(sentence, `${key} does not say who has to be exempted`).toContain('ADMINISTRATOR')
      expect(sentence, `${key} tells the operator an ordinary member is enough`).not.toMatch(/exempt member/i)
    }
  })

  it('⚠️ and the one that explains WHY an admin still says it', () => {
    // The clause that went missing on the credential-delete copy. Without it the sentence reads as a
    // rule about sign-in, and an operator satisfies it with somebody who cannot administer anything.
    expect(SSO_FLOOR_REFUSAL.needAnExemptAdmin).toContain('the one who can fix things')
  })
})

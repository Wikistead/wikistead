// #590: the dev seed stops minting connections that look legacy, and never backfills one that is.
//
// The admin screen showed a "LEGACY" badge on any connection with no `subject_prefix` — meaning "made
// before subs were derived per connection" (ADR-197 §5). But the seed created its connection without
// one, so dev always had the badge: it described the seed, not old data. The badge is gone and the
// seed sets a prefix.
//
// The dangerous half is the half that must NOT change. `subject_prefix` is what member subs are
// DERIVED from, so filling it in on an EXISTING connection gives every member a different sub at
// their next sign-in — a second row for the same person, while their FGA tuples, notifications, audit
// entries, API keys and authored pages still point at the sub they no longer have. The seed's UPDATE
// branch must therefore never learn to set it, and that is what this pin holds: read as text, because
// running the seed against a live database to prove it does not do something is not a test anyone
// should write.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { subjectPrefixFor } from '../routes/admin-connections.js'

const SEED = resolve(import.meta.dirname, '../../../../infra/db/seed.ts')

describe('#590: the seed mints a prefix, and only on insert', () => {
  const src = readFileSync(SEED, 'utf8')
  const oidcBlock = src.slice(src.indexOf('tenant_oidc'), src.indexOf("seeded: tenant_dev / tenant_oidc"))

  it('a NEW dev connection is created with a subject prefix', () => {
    expect(oidcBlock).toMatch(/INSERT INTO tenant_oidc[\s\S]*subject_prefix/)
    expect(oidcBlock, 'and the value comes from the app, not a second copy of the rule').toContain('subjectPrefixFor(')
  })

  it('the UPDATE branch never touches subject_prefix', () => {
    const update = oidcBlock.slice(oidcBlock.indexOf('UPDATE tenant_oidc'), oidcBlock.indexOf('INSERT INTO tenant_oidc'))
    expect(update.length, 'the UPDATE branch is where this test thinks it is').toBeGreaterThan(50)
    expect(update, 'backfilling a live connection re-mints every member sub').not.toContain('subject_prefix')
  })

  it('the derivation is the shape ADR-197 §5 defines', () => {
    // guard the import: if `subjectPrefixFor` ever changes shape, the seed follows it — that is the
    // point of importing — but the shape itself is a written contract
    const p = subjectPrefixFor('0123abcd-4567-89ef-0123-456789abcdef')
    expect(p).toBe('wc0123abcd_')
    expect(p, 'the reserved namespace S0 pins at every ingress').toMatch(/^wc[0-9a-f]{8}_$/)
  })
})

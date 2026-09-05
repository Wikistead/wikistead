// #1108 (ruling, 2026-09-06): the migration runner does not reach `ns_*` schemas, so the design for
// reaching them is parked until the first real promotion — and the parking is only safe while no
// tenant is promoted. `pnpm tenant:promote` could still be run today, so "zero promoted tenants" was
// luck. This pins the door shut: the script refuses unless the operator sets the override, and the
// refusal names the ticket so whoever hits it can read why.
//
// Spawned, not imported: the guard lives in the script's `import.meta.url === argv[1]` main block,
// which never runs on import — a test that imported the module would pass with the guard deleted.
// Same shape as license-gate-counts-893's runGate.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '../../../..')
const SCRIPT = join(REPO, 'apps/server/src/scripts/promote-tenant.ts')

function run(env: Record<string, string> = {}) {
  const r = spawnSync('npx', ['tsx', SCRIPT, 'no-such-tenant-1108'], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ...env },
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('#1108: the promotion door is shut while migrations cannot reach ns_* schemas', () => {
  it('refuses without the override, and says which ticket closed the door', () => {
    const r = run()
    expect(r.code, 'promotion must not proceed while #1108 is open').toBe(1)
    expect(r.out).toContain('#1108')
    expect(r.out, 'the refusal must name the way out').toContain('WIKISTEAD_ALLOW_PROMOTION')
  }, 130_000)

  it('with the override set, the guard is out of the way (the run fails LATER, on the unknown tenant)', () => {
    // The distinguishing signal: past the door, the script reaches its own tenant lookup and reports
    // THAT failure instead. A guard that ignored the override would still print the #1108 refusal.
    const r = run({ WIKISTEAD_ALLOW_PROMOTION: '1' })
    expect(r.out, 'the override must let the script get to its own lookup').toContain('tenant not found')
    expect(r.out, 'and the door must stop talking once it is opened').not.toContain('#1108')
  }, 130_000)
})

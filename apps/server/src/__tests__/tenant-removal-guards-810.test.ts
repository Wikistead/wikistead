// ADR-252 §6a (#810): the infrastructure a future removal write path depends on, discovered rather than
// declared. The ruling refused a per-worker declaration for two different reasons on two different
// shapes of worker, and this file pins both refusals as much as it pins the mechanisms:
//
//   a periodic `setInterval` worker            a hand-kept ledger, made RED by an unregistered one
//   a worker that walks `tenants` directly     a shared enumeration helper, made RED by a bare walk
//                                               anywhere outside it (a declaration here would be a
//                                               CENSUS — a word with nothing to switch off; see #862)
//
// `tenants.deleted_at` (migration 132) is unwritten today — ADR-252 §1/§2, the removal design this
// infrastructure exists for, is not landed by this ticket. Every guard below is inert until that write
// path exists; what this file pins is that the guards exist and are wired, not that removal works.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const SERVER_SRC = resolve(import.meta.dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(abs)
  }
  return out
}

// Scripts are a DIFFERENT class from a periodic worker — CLI, operator-invoked, one process, one exit —
// and ADR-252 §6a's own text draws the line at "destroys on a clock" (a script launched BY a clock,
// e.g. cron/systemd-timer, not a script a human runs once). None of that class exists in this tree today
// (`sweepExpiredClaims` / `runAnalyticsGc`, named in the ADR, are not present — grepped, zero hits), so
// this slice does not build a walk for it; the ADR names the gap for whoever adds one rather than this
// pin guessing at a shape with no example to check itself against. `scripts/` is excluded from BOTH
// scans below for that reason — an operator script enumerating every tenant (a migration, an audit) is
// not the unattended, always-running case this infrastructure exists to guard.
const SCRIPTS_DIR = resolve(SERVER_SRC, 'scripts')
function serverSourceFiles(): string[] {
  return walk(SERVER_SRC).filter((f) => !f.startsWith(SCRIPTS_DIR + '/') && !f.includes(`${join('src', '__tests__')}`))
}

describe('#810 / ADR-252 §6a ruling 1: the setInterval ledger catches the twelfth worker', () => {
  // The ledger's own reason for existing, stated by the ruling: "the existing walk keys on the naming
  // convention, so a twelfth worker that does not call itself `start*Worker` walks past it." This scan
  // keys on the literal call instead — `setInterval(` — so a worker's name cannot exempt it.
  // The COUNT, not just the file, is the ledger entry — a file already holding one registered
  // `setInterval` is exactly where an added, unrelated second one would otherwise hide (the same
  // file-vs-occurrence gap unbounded-list-ledger-623 closed for LIMIT).
  const LEDGER: ReadonlyArray<readonly [string, number, string]> = [
    ['db/outbox-lease.ts', 1, 'the shared lease loop — search / import / email / tuple / webhook / the two EE drains all ride this ONE setInterval, not one each'],
    ['routes/webhooks.ts', 1, 'the webhook drain\'s own setInterval (it claims via claimOutboxBatch but does not ride startOutboxDrainWorker\'s timer)'],
    ['routes/custom-domains.ts', 1, 'the custom-domain liveness recheck sweep'],
    ['routes/share-links.ts', 1, 'the share-link revoke-failure sweep'],
    ['routes/pages.ts', 1, 'the trash retention purge'],
  ]

  // Comments count as text an author can write anything into (custom-domains.ts itself has one
  // discussing `setInterval(NaN)` as a hazard, not a call) — strip `//` line comments before counting,
  // the same discipline the repo's own filter applies to prose, not code.
  const stripLineComments = (src: string): string => src.replace(/\/\/[^\n]*/g, '')
  const countSetIntervals = (src: string): number => (stripLineComments(src).match(/\bsetInterval\s*\(/g) ?? []).length

  it('every setInterval call in shipped server source is accounted for, file AND count', () => {
    const found = new Map<string, number>()
    for (const abs of serverSourceFiles()) {
      const n = countSetIntervals(readFileSync(abs, 'utf8'))
      if (n > 0) found.set(relative(SERVER_SRC, abs), n)
    }
    const ledger = new Map(LEDGER.map(([f, n]) => [f, n]))
    const mismatches: string[] = []
    for (const [file, n] of found) {
      if (!ledger.has(file)) mismatches.push(`${file}: ${n} unregistered — a twelfth worker walked past the ledger`)
      else if (ledger.get(file) !== n) mismatches.push(`${file}: ledger says ${ledger.get(file)}, found ${n} — a new one landed beside a registered one`)
    }
    expect(mismatches, mismatches.join('; ')).toEqual([])
    // 0 files with setInterval would mean the scan itself is broken (a moved directory, a renamed
    // extension) — #890's family: an absence must be distinguished from a check that cannot fail.
    expect(found.size, 'the scan found no setInterval calls at all — it is almost certainly broken, not the tree').toBeGreaterThan(0)
  })

  it('the ledger has no stale lines — every entry names a file whose count still matches', () => {
    for (const [file, n] of LEDGER) {
      const abs = resolve(SERVER_SRC, file)
      const actual = countSetIntervals(readFileSync(abs, 'utf8'))
      expect(actual, `${file}: ledger says ${n}, file has ${actual} — stale`).toBe(n)
    }
  })
})

describe('#810 / ADR-252 §6a ruling 1: no bare tenant walk outside the shared helper', () => {
  // "The check's question changes from 'did you declare?' to 'are you enumerating tenants without the
  // helper?'" A bare walk is `FROM tenants` with no `WHERE` in the same statement — a single-row lookup
  // (`WHERE id = …` / `WHERE slug = …`) is a different question this ruling does not reach, and
  // `db/registry.ts` (the helper's own file, plus the three by-id/slug/domain lookups already there) is
  // the one place allowed to hold the literal.
  const REGISTRY = resolve(SERVER_SRC, 'db/registry.ts')

  it('db/registry.ts is the only file with a WHERE-less "FROM tenants"', () => {
    const offenders: string[] = []
    for (const abs of serverSourceFiles()) {
      if (abs === REGISTRY) continue
      const src = readFileSync(abs, 'utf8')
      // A tagged-template SQL statement containing FROM tenants: captured up to the closing backtick
      // (non-greedy) so a later, unrelated WHERE elsewhere in the same FILE cannot hide a bare walk —
      // the same "statement, not file" correction unbounded-list-ledger-623 made for LIMIT.
      for (const m of src.matchAll(/`[^`]*\bFROM\s+tenants\b[^`]*`/gs)) {
        if (!/\bWHERE\b/i.test(m[0])) offenders.push(relative(SERVER_SRC, abs))
      }
    }
    expect([...new Set(offenders)], `bare "FROM tenants" outside the shared helper: ${offenders.join(', ')}`).toEqual([])
  })

  it('the helper itself is the walk — a discovery pin that cannot see registry.ts would be vacuous', () => {
    expect(readFileSync(REGISTRY, 'utf8')).toMatch(/export async function listActiveTenantIds/)
  })

  it('all four non-claiming periodic workers call the shared helper, not a bare query', () => {
    const CALLERS: ReadonlyArray<readonly [string, string]> = [
      ['email/digest.ts', 'produceDigestJobs'],
      ['routes/custom-domains.ts', 'recheckCustomDomains'],
      ['routes/share-links.ts', 'sweepShareLinkRevokeFailures'],
      ['routes/pages.ts', 'sweepExpiredTrash'],
    ]
    for (const [file, fn] of CALLERS) {
      const src = readFileSync(resolve(SERVER_SRC, file), 'utf8')
      const at = src.indexOf(`function ${fn}`)
      expect(at, `${file}: ${fn} not found`).toBeGreaterThanOrEqual(0)
      const body = src.slice(at, src.indexOf('\nexport ', at + 1) === -1 ? undefined : src.indexOf('\nexport ', at + 1))
      expect(body, `${file}: ${fn} does not call the shared enumeration helper`).toMatch(/listActiveTenantIds\(/)
    }
  })
})

describe('#810 / ADR-252 §6a ruling 2: claimOutboxBatch excludes a removed workspace', () => {
  it('the claim statement excludes tenants with deleted_at set', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'db/outbox-lease.ts'), 'utf8')
    expect(src).toMatch(/tenant_id NOT IN \(SELECT id FROM tenants WHERE deleted_at IS NOT NULL\)/)
  })

  it('the row type is constrained to carry tenant_id — a future outbox without it fails to compile', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'db/outbox-lease.ts'), 'utf8')
    const sig = src.slice(src.indexOf('export async function claimOutboxBatch'))
    expect(sig.slice(0, sig.indexOf(')'))).toMatch(/tenant_id\s*:\s*string/)
  })
})

describe('#810 / ADR-252 §6a ruling 2: the reaper and the terminal writes', () => {
  it('the stale-claim reaper does not touch a tenant being removed', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'import/jobs.ts'), 'utf8')
    const reaper = src.slice(src.indexOf("UPDATE imports SET status = 'failed'"), src.indexOf('claimOutboxBatch<ClaimedRow>'))
    expect(reaper).toMatch(/tenant_id NOT IN \(SELECT id FROM tenants WHERE deleted_at IS NOT NULL\)/)
  })

  it('both terminal writes (done, failed-after-catch) guard on status = running', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'import/jobs.ts'), 'utf8')
    const doneStmt = src.indexOf("UPDATE imports SET status = 'done'")
    expect(doneStmt, "the 'done' UPDATE statement was not found").toBeGreaterThanOrEqual(0)
    expect(src.slice(doneStmt, doneStmt + 300), "the 'done' write has no status guard")
      .toMatch(/WHERE id = \$\{row\.id\} AND status = 'running'/)
    const failedStmt = src.indexOf("UPDATE imports SET status = 'failed', error = ${e instanceof Error")
    expect(failedStmt, "the post-catch 'failed' UPDATE statement was not found").toBeGreaterThanOrEqual(0)
    expect(src.slice(failedStmt, failedStmt + 300), "the post-catch 'failed' write has no status guard")
      .toMatch(/WHERE id = \$\{row\.id\} AND status = 'running'/)
  })

  it('onProgress can cut a run once the tenant enters its grace period', () => {
    const src = readFileSync(resolve(SERVER_SRC, 'import/jobs.ts'), 'utf8')
    const runOneImport = src.slice(src.indexOf('async function runOneImport'))
    expect(runOneImport, 'no removal-cut flag').toMatch(/cutForRemoval/)
    expect(runOneImport, 'onProgress does not throw once cut').toMatch(/if \(cutForRemoval\) throw/)
    expect(runOneImport, 'the cut check does not read deleted_at').toMatch(/deleted_at IS NOT NULL/)
  })
})

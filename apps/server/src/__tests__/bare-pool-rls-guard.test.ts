// #479: a write to a FORCE-RLS'd table from the BARE pool matches zero rows — silently. No error, no
// log, just nothing happening. It has bitten twice: #428 (api_keys.last_used_at never moved) and
// #478 (the plan re-upgrade never un-froze anyone, so ADR-064's promise had never once fired). Both
// looked like working code and were only caught by writing a test that asserted the effect.
//
// This is the structural guard: every tenant-scoped write must carry a tenant context. It reads the
// migrations for the FORCE-RLS table list rather than hardcoding one, so a new tenant-scoped table
// is covered the day it lands.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')

function forcedRlsTables(): Set<string> {
  const dir = join(ROOT, 'infra/db/migrations')
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
  return new Set([...sql.matchAll(/ALTER TABLE (\w+) FORCE ROW LEVEL SECURITY/g)].map((m) => m[1]!))
}

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (e === 'node_modules' || e === 'dist' || e === '__tests__') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) out.push(p)
    }
  }
  for (const d of dirs) walk(join(ROOT, d))
  return out
}

// Writes that are deliberately global, with the reason. Anything else must go through the tenant
// driver (req.db / acquireTenantDb / withTenantTx) or set app.tenant_id itself.
const ALLOWED = [
  // Tenant bootstrap: the tenant row is created two statements earlier IN THIS tx and is not yet
  // visible to the registry, so provisioning sets app.tenant_id by hand inside the same transaction
  // (it does — see the set_config call there). A brand-new tenant is 'logical' by definition.
  'apps/server/src/auth/provisioning.ts',
]

describe('#479: no silent zero-row writes (bare pool × FORCE RLS)', () => {
  it('every write to a FORCE-RLS table carries a tenant context', () => {
    const tables = forcedRlsTables()
    expect(tables.size, 'the migration scan found the RLS tables').toBeGreaterThan(20)

    const offenders: string[] = []
    for (const file of sourceFiles(['apps/server/src', 'packages'])) {
      const rel = file.slice(ROOT.length + 1)
      if (ALLOWED.includes(rel)) continue
      const src = readFileSync(file, 'utf8')
      if (!/from '(\.\.\/)*(\.\/)?db\/pool\.js'|from '@wikistead\/server\/ee-host'/.test(src)) continue

      // Direct `pool`…`` writes, and writes on the tx of a `pool.begin(...)` block that never sets
      // app.tenant_id. Both reach the database with no tenant context.
      const bareBlocks: { body: string; at: number }[] = []
      for (const m of src.matchAll(/pool`([\s\S]{0,400}?)`/g)) bareBlocks.push({ body: m[1]!, at: m.index! })
      for (const m of src.matchAll(/pool\.begin\(async \((\w+)\) => \{/g)) {
        const start = m.index! + m[0].length
        const body = src.slice(start, start + 4000)
        if (/set_config\('app\.tenant_id'/.test(body)) continue // context set by hand — fine
        const tag = m[1]!
        for (const q of body.matchAll(new RegExp(tag + '`([\\s\\S]{0,400}?)`', 'g'))) {
          bareBlocks.push({ body: q[1]!, at: start + q.index! })
        }
      }

      for (const b of bareBlocks) {
        const w = /\b(UPDATE|DELETE FROM|INSERT INTO)\s+(\w+)/i.exec(b.body)
        if (!w || !tables.has(w[2]!)) continue
        const line = src.slice(0, b.at).split('\n').length
        offenders.push(`${rel}:${line} — ${w[1]!.toUpperCase()} ${w[2]} on the bare pool`)
      }
    }

    expect(offenders, `these writes match zero rows under FORCE RLS:\n${offenders.join('\n')}`).toEqual([])
  })
})

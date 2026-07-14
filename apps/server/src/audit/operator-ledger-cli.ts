// #404: the operator break-glass ledger CLI — read / verify / export the hash-chained
// operator_audit_log (#179 / ADR-089). `pnpm --filter @wikistead/server ledger:verify [--json]`.
//
// Deliberately a CLI, not an HTTP route: the ledger's consumers are OPERATORS holding the admin
// connection string (the tenant `app` role has no privileges on the table — migration 047), so exposing
// it here adds ZERO new authorization surface. Read-only (one SELECT via readOperatorChain).
//
//   default : human summary — entry count, head/tail seq, per-entry lines, and the chain VERDICT.
//   --json  : JSONL export (one entry per line, then a final verdict line) for retention/archival.
//
// Exit code 0 = chain verified; 1 = chain BROKEN (tamper/fork detected); 2 = execution error.
import postgres from 'postgres'
import { readOperatorChain } from './operator-ledger.js'

export function formatLedger(
  result: Awaited<ReturnType<typeof readOperatorChain>>,
  json: boolean,
): { lines: string[]; ok: boolean } {
  const { entries, verdict } = result
  const ok = verdict.valid
  if (json) {
    const lines = entries.map((e) => JSON.stringify(e))
    lines.push(JSON.stringify({ verdict }))
    return { lines, ok }
  }
  const lines: string[] = []
  lines.push(`operator ledger: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
  for (const e of entries) {
    lines.push(`#${e.seq}  ${e.at}  ${e.actor}  ${e.action}  ${e.target || '-'}`)
  }
  lines.push(
    ok
      ? `chain VERIFIED (${entries.length} entries, tail hash ${entries.at(-1)?.hash.slice(0, 12) ?? '-'})`
      : `chain BROKEN at index ${String(verdict.brokenAt ?? '?')} (${verdict.reason ?? 'unknown'}) — entries at or after this point cannot be trusted`,
  )
  return { lines, ok }
}

// Self-executing CLI (mirrors search-sync.ts). Guarded so importing formatLedger from tests never runs it.
const isMain = process.argv[1]?.endsWith('operator-ledger-cli.ts') || process.argv[1]?.endsWith('operator-ledger-cli.js')
if (isMain) {
  const url = process.env.DATABASE_ADMIN_URL
  if (!url) {
    console.error('DATABASE_ADMIN_URL required (the ledger is operator/admin-only; the app role has no access)')
    process.exit(2)
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const result = await readOperatorChain(sql)
    const { lines, ok } = formatLedger(result, process.argv.includes('--json'))
    for (const l of lines) console.log(l)
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('ledger read failed:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await sql.end()
  }
}

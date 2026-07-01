#!/usr/bin/env node
// CLI for the pre-launch deploy gate's HTTP smoke checks (#148 / ADR-066). Run against the
// prod-pre-cutover deployment; exits non-zero if any HTTP-observable row FAILS.
//
//   pnpm preflight:deploy https://t1.wikistead.example
//
// This covers ONLY the HTTP-observable rows (headers / 404-json / cache posture). The infra rows in
// docs/runbooks/prelaunch-deploy-gate.md (OpenFGA restart, SOPS, ACME, cross-replica rate, ydoc
// restart, reindex, storage, semantic-release) are NOT HTTP-observable and remain manual there.
import { runHttpPreflight, formatReport, type FetchLike } from './preflight.js'

const baseUrl = process.argv[2]
if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error('usage: preflight:deploy <baseUrl>   (e.g. https://t1.wikistead.example)')
  process.exit(2)
}

const fetchImpl: FetchLike = (url, init) => fetch(url, { redirect: init?.redirect ?? 'manual' })

const items = await runHttpPreflight(baseUrl, fetchImpl)
const { text, allPass } = formatReport(items)
console.log(`Pre-launch HTTP smoke — ${baseUrl}\n`)
console.log(text)
console.log(`\n${allPass ? 'ALL HTTP-observable rows PASS' : 'SOME ROWS FAILED'} (${items.filter((i) => i.verdict.pass).length}/${items.length}).`)
console.log('Note: infra rows (OpenFGA/SOPS/ACME/rate/ydoc/reindex/storage/release) remain manual — see docs/runbooks/prelaunch-deploy-gate.md.')
process.exit(allPass ? 0 : 1)

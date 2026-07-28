#!/usr/bin/env node
// CLI for the pre-launch deploy gate's HTTP smoke checks (#148 / ADR-066). Run against the
// prod-pre-cutover deployment.
//
//   pnpm preflight:deploy https://t1.wikistead.example \
//     [--public-page https://t1.wikistead.example/p/<id>] \
//     [--set-cookie "wks_session=...; Path=/; HttpOnly; Secure; SameSite=Lax"]   (repeatable)
//
// EXIT CODES — a release gate must distinguish "checked and fine" from "did not check":
//   0  every row verified and PASSED
//   1  a row FAILED
//   2  usage error
//   3  no failures, but some rows were SKIPPED (unverified — supply the probe or verify by hand)
//
// This covers ONLY the HTTP-observable rows. The infra rows in docs/runbooks/prelaunch-deploy-gate.md
// (OpenFGA restart, SOPS, ACME, cross-replica rate, ydoc restart, reindex, storage, release, and the
// Authentik social-login gate) are actions rather than observations and remain manual there.
import { runHttpPreflight, formatReport, type FetchLike, type PreflightOptions } from './preflight.js'

const argv = process.argv.slice(2)
const baseUrl = argv[0]
const opts: PreflightOptions = { setCookies: [] }
for (let i = 1; i < argv.length; i++) {
  const next = argv[i + 1]
  if (argv[i] === '--public-page' && next) { opts.publicPageUrl = next; i++ }
  else if (argv[i] === '--set-cookie' && next) { opts.setCookies!.push(next); i++ }
  else {
    console.error(`unknown argument: ${argv[i]}`)
    process.exit(2)
  }
}
if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error('usage: preflight:deploy <baseUrl> [--public-page <url>] [--set-cookie <line>]...')
  process.exit(2)
}

const fetchImpl: FetchLike = (url, init) => fetch(url, { redirect: init?.redirect ?? 'manual' })

const items = await runHttpPreflight(baseUrl, fetchImpl, opts)
const { text, allPass, skipped } = formatReport(items)
const passed = items.filter((i) => !i.verdict.skipped && i.verdict.pass).length
console.log(`Pre-launch HTTP smoke — ${baseUrl}\n`)
console.log(text)
console.log(`\n${allPass ? 'no failures' : 'SOME ROWS FAILED'} (${passed}/${items.length} verified as PASS${skipped ? `, ${skipped} SKIPPED — NOT verified` : ''}).`)
console.log('Note: infra rows (OpenFGA/SOPS/ACME/rate/ydoc/reindex/storage/release/social-login) remain manual — see docs/runbooks/prelaunch-deploy-gate.md.')
process.exit(!allPass ? 1 : skipped ? 3 : 0)

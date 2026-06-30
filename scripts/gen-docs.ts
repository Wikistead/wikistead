#!/usr/bin/env tsx
// "Code is truth" docs generator + CI stale-guard (#139 / ADR-080 doc↔code linkage).
//
//   pnpm docs:gen     → (re)write the generated Markdown from code.
//   pnpm docs:check   → regenerate in memory and FAIL if the committed file differs
//                       (the CI stale-guard: no stale generated docs can land).
//
// The generated Markdown is the SSG's "code is truth" source (fed to wikistead-docs).
// Generation is a CI build step over CE code only — it never runtime-imports product
// code into the SSG, and never pulls the proprietary Cloud plan table (CE/EE boundary).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderEntitlementsMarkdown } from '../packages/entitlements/src/index.js'
import { renderEventsMarkdown } from '../packages/events/src/index.js'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Each "code is truth" surface: its generator + the committed output path. New
// generated surfaces (API reference, macro list, settings) are added here.
const SURFACES: { name: string; outPath: string; render: () => string }[] = [
  {
    name: 'entitlement levers',
    outPath: join(root, 'docs/generated/entitlement-levers.md'),
    render: renderEntitlementsMarkdown,
  },
  {
    name: 'domain events',
    outPath: join(root, 'docs/generated/domain-events.md'),
    render: renderEventsMarkdown,
  },
]

const check = process.argv.includes('--check')
let stale = false

for (const s of SURFACES) {
  const next = s.render()
  if (check) {
    const current = existsSync(s.outPath) ? readFileSync(s.outPath, 'utf8') : ''
    if (current !== next) {
      stale = true
      console.error(`STALE: ${s.name} — ${s.outPath.replace(root, '.')} is out of date. Run \`pnpm docs:gen\`.`)
    }
  } else {
    mkdirSync(dirname(s.outPath), { recursive: true })
    writeFileSync(s.outPath, next)
    console.log(`generated: ${s.name} → ${s.outPath.replace(root, '.')}`)
  }
}

if (check) {
  if (stale) {
    console.error('Generated docs are stale (code changed without regenerating). See ADR-080 doc↔code linkage.')
    process.exit(1)
  }
  console.log('OK: generated docs are up to date.')
}

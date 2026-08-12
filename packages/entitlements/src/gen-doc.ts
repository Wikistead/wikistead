// Generator for the "code is truth" entitlement-levers documentation
// (#139 / ADR-080 doc↔code linkage). Renders deterministic Markdown from
// LEVER_CATALOG + UNLIMITED. CE-only: the Community (self-host) column is
// UNLIMITED; the per-tier Cloud values are generated on the Cloud side from the
// proprietary plan table (this never imports CLOUD_PLANS).
//
// A CI stale-guard (scripts/gen-docs.ts --check) regenerates this and fails if
// the committed Markdown differs, so the doc cannot drift from the catalog.

import { UNLIMITED } from './index.js'
import { LEVER_CATALOG, type LeverDoc } from './catalog.js'

// Render the Community (UNLIMITED) value of a lever per its unit. Kept simple and
// deterministic — no locale/Date dependence (the generator must be reproducible).
function renderCommunityValue(key: string, lever: LeverDoc): string {
  const v = (UNLIMITED as unknown as Record<string, unknown>)[key]
  switch (lever.unit) {
    case 'boolean':
      return v ? 'Enabled' : 'Disabled'
    case 'days':
    case 'count':
      return v === Infinity ? 'Unlimited' : String(v)
    case 'bytes':
      return v === Infinity ? 'Unlimited' : `${v} bytes`
    case 'rate': {
      const r = v as { perKey: number; perTenant: number }
      const fmt = (n: number) => (n === Infinity ? 'unlimited' : String(n))
      return `perKey ${fmt(r.perKey)}, perTenant ${fmt(r.perTenant)}`
    }
    case 'enum':
      return String(v)
    default:
      return String(v)
  }
}

const HEADER = `<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/entitlements/src/catalog.ts (LEVER_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" levers reference fed to the docs SSG (ADR-080).
-->`

// Produce the full Markdown document. Deterministic: depends only on
// LEVER_CATALOG / UNLIMITED, iterated in their declared (stable) order.
export function renderEntitlementsMarkdown(): string {
  const lines: string[] = []
  lines.push(HEADER, '', '# Entitlement levers', '')
  lines.push(
    'Every paid lever is an `Entitlements` field resolved in one place',
    '(`resolveEntitlements(plan)`). Self-hosted Community/Enterprise builds are',
    '`UNLIMITED` by construction; the per-tier Cloud values are published',
    'separately. This page is generated from the code (`LEVER_CATALOG`).',
    '',
  )
  // #693: the EDITION column mirrors catalog `edition` — 'EE' rows are levers whose enforcement
  // bytes live in the private overlay, and the placement lint derives its deny-set from them.
  lines.push('| Lever | Edition | What it gates | Self-host (Community) | Enforced at | Downgrade |')
  lines.push('|---|---|---|---|---|---|')
  for (const key of Object.keys(LEVER_CATALOG)) {
    const lever = LEVER_CATALOG[key as keyof typeof LEVER_CATALOG]
    const cells = [
      `**${lever.title}** (\`${key}\`)`,
      lever.edition === 'ee' ? 'EE' : 'CE',
      lever.summary,
      renderCommunityValue(key, lever),
      lever.enforcedAt,
      lever.downgrade,
    ].map((c) => c.replace(/\|/g, '\\|'))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

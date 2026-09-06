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
//
// #1174: `UNLIMITED[key]` answers "would the plan resolver refuse this lever on self-host" — true
// (unrestricted) for every lever, `edition: 'ee'` ones included. It does NOT answer "does a self-host
// build have the code to run this at all" — the five `edition: 'ee'` levers have no enforcement bytes
// outside the private overlay (`packages/ee-server`), so printing their UNLIMITED value as "Enabled"
// told a self-hoster they could use SSO/SCIM/the audit log/Access Transparency/analytics when the
// route simply is not compiled in. This must short-circuit BEFORE the unit switch below, since an
// EE lever can be any unit in principle even though today's five all happen to be boolean.
function renderCommunityValue(key: string, lever: LeverDoc): string {
  if (lever.edition === 'ee') return 'Not on self-host (EE-only)'
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
  This is the "code is truth" levers reference fed to the docs SSG.
-->`

// Produce the full Markdown document. Deterministic: depends only on
// LEVER_CATALOG / UNLIMITED, iterated in their declared (stable) order.
export function renderEntitlementsMarkdown(): string {
  const lines: string[] = []
  // #748 (owner ruling): the READER's name for this page, not ours. "Entitlement lever" is the word
  // the code uses for the switch; what somebody arrives looking for is what their plan includes.
  // Same family as #671 (one feature, one name) and #732 (internal vocabulary stays out of the UI) —
  // this is the documentation half of it.
  lines.push(HEADER, '', '# What each plan includes', '')
  // #814 (owner ruling, follows #748): the intro speaks the reader's language too — no code
  // identifiers in the prose. No generated-ness sentence here: the docs-site pull stamps a
  // provenance note on every generated page already, and saying it twice reads as a tic.
  lines.push(
    'Each row is one feature or limit a plan can include. Self-hosted',
    'Community/Enterprise builds have every one of them enabled or unlimited;',
    'the per-tier Cloud values are published separately.',
    '',
  )
  // #693: the EDITION column mirrors catalog `edition` — 'EE' rows are levers whose enforcement
  // bytes live in the private overlay, and the placement lint derives its deny-set from them.
  // The docs-site EE-badge check parses `(`key`) | EE |`, so the key cell and the Edition column
  // must keep this shape.
  lines.push('| Feature | Edition | What it controls | Self-host (Community) | Enforced at | Downgrade |')
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

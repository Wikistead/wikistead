#!/usr/bin/env tsx
// "Code is truth" docs generator + CI stale-guard (#139 / ADR-080 doc↔code linkage).
//
// pnpm docs:gen → (re)write the generated Markdown from code.
// pnpm docs:check → regenerate in memory and FAIL if the committed file differs
// (the CI stale-guard: no stale generated docs can land).
//
// The generated Markdown is the SSG's "code is truth" source (fed to wikistead-docs).
// Generation is a CI build step over CE code only — it never runtime-imports product
// code into the SSG, and never pulls the proprietary Cloud plan table (CE/EE boundary).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { ENV_DOCS, scanEnvUsage, scanStringLiterals, scanEnvExample, evaluateEnvCatalog } from './env-catalog.mjs'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { eeServerSourceRoot } from './ee-source-root.mjs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #706: the BRAND KIT — the public subset of the product's design tokens, plus the mark and the
// self-hosted faces, emitted as a generated artifact so the docs site (and later the LP) consume
// the RELEASED product's look through the same pinned pull as the generated references. Never the
// whole tokens.css (internal tokens stay internal), never a hand copy (a copy is a second truth).
const BRAND_TOKENS = ['bg', 'fg', 'fg-dim', 'panel', 'panel-2', 'panel-3', 'border', 'accent', 'accent-fg'] as const

// #709: the TYPE tokens ride the kit too — colours alone left the consuming sites hand-picking
// faces (the docs set body text in the wordmark face; the exact double bookkeeping the kit exists
// to end). Theme-independent, extracted once, emitted on :root. Internal var references are
// rewritten to the kit's own names so the emitted values resolve without the product stylesheet.
const FONT_TOKENS: readonly { from: string; to: string }[] = [
  { from: 'font', to: 'font' }, // body/UI: Inter + Noto Sans JP
  { from: 'font-code', to: 'font-mono' }, // code: Wikistead Mono
  { from: 'font-wordmark', to: 'font-wordmark' }, // the wordmark face, wordmark-ONLY
]

/**
 * #729 slice C: the capabilities this product SHIPS, emitted for the landing page to answer for.
 *
 * The landing page already checks one direction — every claim it makes names evidence, and a claim
 * whose evidence stops resolving turns the build red (#696③). The other direction had no
 * check at all: a capability could ship and the page could simply never mention it, which is the
 * silence this ticket exists to break.
 *
 * It is EMITTED rather than listed on the landing side, for the same reason every other ledger here
 * is walked rather than transcribed: a hand-kept list is green on the day something new lands, which
 * is the day it is wrong. The ids are the ones the documentation ledger already uses, so a reader
 * comparing the two files is comparing the same vocabulary.
 *
 * ⚠️ Registered SURFACES (macros, admin tabs, routes) are deliberately NOT here. The landing page is
 * not a feature list — it sells six north-star values — and asking it to answer for seventeen macro
 * names would make the ledger a wall of `none:` rows, which is a ledger nobody reads. What it must
 * answer for is a capability a buyer would choose the product FOR.
 */
function renderCapabilitiesJson(): string {
  const ids = Object.keys(SURFACE_DOCS.capability).sort()
  return JSON.stringify({ capabilities: ids }, null, 2) + '\n'
}

/**
 * #731: the admin tab labels, per locale, straight out of the product's own strings.
 *
 * Keys are the registry ids (`ADMIN_SURFACES` / `adminNav`), which is what makes this checkable from
 * the other side: the documentation's ledger already binds a page to each id, so a doc page can be
 * compared with the label its id carries. A tab added tomorrow appears here without anyone
 * remembering to add it — and the docs check goes red because that id has no page named after it.
 */
function renderAdminTabsJson(): string {
  const nav = (locale: string) =>
    (JSON.parse(readFileSync(join(root, `apps/web/src/i18n/locales/${locale}.json`), 'utf8')) as {
      adminNav: Record<string, string>
    }).adminNav
  const en = nav('en')
  const ja = nav('ja')
  // `title` is the console's own heading, not a tab; the tabs are everything else.
  const ids = Object.keys(en).filter((k) => k !== 'title').sort()
  const tabs = Object.fromEntries(ids.map((id) => [id, { en: en[id], ja: ja[id] }]))
  return JSON.stringify({ tabs }, null, 2) + '\n'
}

/**
 * #734 / ADR-237 §2.2: the ENVIRONMENT REFERENCE.
 *
 * Measured before this existed: the code read about ninety variables and `.env.example` declared
 * forty, so roughly fifty knobs — lockout windows, token lifetimes, the platform OIDC block, the
 * import threshold, the downgrade grace period — existed only in source. An operator could not learn
 * that they existed, which is a worse failure than a badly worded page.
 *
 * The prose lives in `scripts/env-catalog.mjs`; the truth is the walk. Disagreement in either
 * direction throws here, so `docs:gen` cannot produce a reference the code does not back and
 * `docs:check` cannot let one land.
 */
const ENV_GROUP_ORDER = [
  'Runtime', 'Database', 'Cache and queues', 'Authorization', 'Search', 'Object storage', 'Email',
  'Sign-in', 'Second factors', 'Guests and sharing', 'Billing', 'Background workers', 'Import',
  'AI and MCP', 'Diagrams', 'Development and tooling',
] as const

interface EnvRow { group?: string; default?: string; what?: string; internal?: string; indirect?: boolean; where?: string[] }

function renderEnvReference(): string {
  const docs = ENV_DOCS as Record<string, EnvRow>
  const used = scanEnvUsage(root) as Map<string, Set<string>>
  const indirect = Object.entries(docs).filter(([, r]) => r.indirect)
  const extraFiles = [...new Set(indirect.flatMap(([, r]) => r.where ?? []))]
  const literals = scanStringLiterals(root, indirect.map(([n]) => n), undefined, extraFiles) as Set<string>
  const example = scanEnvExample(readFileSync(join(root, '.env.example'), 'utf8')) as Set<string>
  const violations = evaluateEnvCatalog({ used: new Set(used.keys()), literals, example }) as string[]
  if (violations.length > 0) {
    throw new Error(
      `environment reference: the catalogue and the code disagree —\n  ${violations.join('\n  ')}\n` +
      'Edit scripts/env-catalog.mjs (ADR-237 §2.2).',
    )
  }

  const operator = Object.entries(docs).filter(([, r]) => !r.internal)
  const internal = Object.entries(docs).filter(([, r]) => r.internal)
  const groups = [...new Set(operator.map(([, r]) => r.group!))]
  for (const g of groups) {
    if (!(ENV_GROUP_ORDER as readonly string[]).includes(g)) throw new Error(`environment reference: group "${g}" has no place in ENV_GROUP_ORDER (scripts/gen-docs.ts)`)
  }

  const esc = (t: string) => t.replace(/\|/g, '\\|')
  const out: string[] = [
    '# Environment reference',
    '',
    '<!-- GENERATED by scripts/gen-docs.ts from the code (#734 / ADR-237 §2.2). Do not edit by hand. -->',
    '',
    `Every environment variable this deployment reads: **${operator.length}** an operator may set, plus **${internal.length}** the product sets for itself. The list is walked out of the source, so a variable added tomorrow appears here or the build fails.`,
    '',
    'A blank value is not the same as a missing one: unless a row says otherwise, unset means the default in the second column, and setting a variable to an empty string means the empty string.',
    '',
  ]
  for (const group of ENV_GROUP_ORDER) {
    const rows = operator.filter(([, r]) => r.group === group)
    if (rows.length === 0) continue
    out.push(`## ${group}`, '', '| Variable | Default | What it does |', '| --- | --- | --- |')
    for (const [name, r] of rows) {
      out.push(`| \`${name}\` | ${esc(r.default ?? '')} | ${esc(r.what ?? '')} |`)
    }
    out.push('')
  }
  if (internal.length > 0) {
    out.push(
      '## Not for operators',
      '',
      'These exist so the product and its test harness can talk to themselves. Each one turns a guard off; setting one in a deployment is a way to break something quietly.',
      '',
      '| Variable | Why it is here |',
      '| --- | --- |',
    )
    for (const [name, r] of internal) out.push(`| \`${name}\` | ${esc(r.internal!)} |`)
    out.push('')
  }
  out.push(
    '## What this list cannot see',
    '',
    'The walk reads `process.env.NAME` and the handed-in `env.NAME` form. A read through a computed key is invisible to it — `OIDC_SECRET_ENC_KEY` is fetched that way — so those rows are declared, and the check requires the name to keep appearing in the code (or in the file the row names) rather than trusting the declaration forever.',
    '',
    'Enterprise Edition variables are not here: they are emitted by a generator inside that package, because a Community Edition tree does not contain it.',
    '',
  )
  return out.join('\n')
}

function renderBrandCss(): string {
  const src = readFileSync(join(root, 'apps/web/src/styles/tokens.css'), 'utf8')
  const themes: Record<'light' | 'dark', Record<string, string>> = { light: {}, dark: {} }
  let current: 'light' | 'dark' | null = null
  for (const line of src.split('\n')) {
    const scheme = line.match(/color-scheme:\s*(light|dark)/)
    if (scheme) { current = scheme[1] as 'light' | 'dark'; continue }
    const decl = line.match(/^\s*--([a-z0-9-]+):\s*([^;]+);/)
    if (!decl || !current) continue
    const [, name, value] = decl
    if ((BRAND_TOKENS as readonly string[]).includes(name!) && !(name! in themes[current])) {
      themes[current][name!] = value!.trim()
    }
  }
  for (const t of ['light', 'dark'] as const) {
    for (const name of BRAND_TOKENS) {
      if (!(name in themes[t])) throw new Error(`brand kit: token --${name} not found for ${t} in tokens.css — the extraction or the token moved`)
    }
  }
  // #709: fonts — first declaration wins (they are theme-independent); a missing one is the same
  // hard error as a missing colour. var(--font) inside a value is rewritten to var(--wks-font) so
  // the emitted chain resolves inside the consuming site.
  const fonts: Record<string, string> = {}
  for (const line of src.split('\n')) {
    const decl = line.match(/^\s*--([a-z0-9-]+):\s*([^;]+);/)
    if (!decl) continue
    const [, name, value] = decl
    const spec = FONT_TOKENS.find((f) => f.from === name)
    if (spec && !(spec.to in fonts)) fonts[spec.to] = value!.trim().replace(/var\(--font\)/g, 'var(--wks-font)')
  }
  for (const spec of FONT_TOKENS) {
    if (!(spec.to in fonts)) throw new Error(`brand kit: font token --${spec.from} not found in tokens.css — the extraction or the token moved`)
  }
  const block = (vars: Record<string, string>) => BRAND_TOKENS.map((n) => `  --wks-${n}: ${vars[n]};`).join('\n')
  return [
    '/* AUTO-GENERATED — DO NOT EDIT BY HAND.',
    ' * Source: apps/web/src/styles/tokens.css (the public brand subset, #706; type tokens #709).',
    ' * Regenerate: pnpm docs:gen · Verify (CI): pnpm docs:check',
    ' * Consumed by the docs site (and the LP) through the pinned generated-docs pull.',
    ' * Font FACES are not in the kit: Inter / Noto Sans JP / Plus Jakarta Sans ship as @fontsource',
    ' * packages (the same delivery the product uses); Wikistead Mono woff2 rides beside this file. */',
    ':root {',
    block(themes.light),
    FONT_TOKENS.map((f) => `  --wks-${f.to}: ${fonts[f.to]};`).join('\n'),
    '}',
    ":root[data-theme='dark'] {",
    block(themes.dark),
    '}',
    '',
  ].join('\n')
}

// The mark and the faces travel with the tokens: byte copies, checked byte-for-byte in --check.
// (The faces are OFL-1.1 — redistribution is the licence's point; the licence files ride along.)
const BRAND_ASSETS: { from: string; to: string }[] = [
  { from: 'apps/web/public/favicon.svg', to: 'docs/generated/brand/favicon.svg' },
  { from: 'apps/web/public/icon-solid.svg', to: 'docs/generated/brand/icon-solid.svg' },
  { from: 'apps/web/src/assets/fonts/udevgothic-Regular.woff2', to: 'docs/generated/brand/fonts/udevgothic-Regular.woff2' },
  { from: 'apps/web/src/assets/fonts/udevgothic-Bold.woff2', to: 'docs/generated/brand/fonts/udevgothic-Bold.woff2' },
  { from: 'apps/web/src/assets/fonts/wikistead-mono-Regular.woff2', to: 'docs/generated/brand/fonts/wikistead-mono-Regular.woff2' },
  { from: 'apps/web/src/assets/fonts/wikistead-mono-Bold.woff2', to: 'docs/generated/brand/fonts/wikistead-mono-Bold.woff2' },
  { from: 'apps/web/src/assets/fonts/LICENSE-UDEVGothic.txt', to: 'docs/generated/brand/fonts/LICENSE-UDEVGothic.txt' },
  { from: 'apps/web/src/assets/fonts/LICENSE-SourceCodePro.txt', to: 'docs/generated/brand/fonts/LICENSE-SourceCodePro.txt' },
]
import { renderEntitlementsMarkdown } from '../packages/entitlements/src/index.js'
import { renderEventsMarkdown } from '../packages/events/src/index.js'
import { renderAccountSettingsMarkdown } from '../apps/server/src/settings-catalog.js'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { SURFACE_DOCS } from './doc-code-map.mjs'

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
  {
    name: 'account settings',
    outPath: join(root, 'docs/generated/account-settings.md'),
    render: renderAccountSettingsMarkdown,
  },
  {
    name: 'brand kit (tokens)',
    outPath: join(root, 'docs/generated/brand/tokens.css'),
    render: renderBrandCss,
  },
  {
    // #731: the admin console's TAB LABELS, as the product spells them, so the documentation can be
    // checked against the screen instead of against somebody's memory of it. The docs had drifted to
    // three names the product does not use ("Sign-in methods" for a tab called Authentication,
    // "Embeds policy" for , "Publishing" for ), and nothing could notice: the two
    // vocabularies live in different repositories.
    //
    // Emitted rather than hand-copied for the usual reason, and one more: #732 renamed several of
    // these labels on the same day. A documentation check that spelled the words out would have gone
    // red on that landing while being perfectly correct — so the check compares against THIS, and
    // follows the product wherever it goes.
    name: 'admin tab labels',
    outPath: join(root, 'docs/generated/admin-tabs.json'),
    render: renderAdminTabsJson,
  },
  {
    // #729 slice C: the capability ids the landing page's coverage ledger answers for.
    name: 'shipped capabilities',
    outPath: join(root, 'docs/generated/capabilities.json'),
    render: renderCapabilitiesJson,
  },
  {
    // #734 / ADR-237 §2.2: the ENVIRONMENT REFERENCE — the one item in that ticket's comparison table
    // that can carry a real guard, which is why it is here rather than in the declared IA spine.
    name: 'environment reference',
    outPath: join(root, 'docs/generated/env-reference.md'),
    render: renderEnvReference,
  },
  {
    // #180 / ADR-225 §3(a): the VERSION MARKER the docs-site pull verifies against its SOURCE_TAG
    // (the torn-pull guard armed itself the day this line landed). The content is the root
    // package.json version and NOTHING else — a SHA or timestamp here would fail docs:check on
    // every commit (the ADR-080 addendum trap); the version moves only when a release commit
    // bumps it, which is exactly when the marker should move.
    name: 'source-version marker',
    outPath: join(root, 'docs/generated/.source-version'),
    render: () => `${(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version}\n`,
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

for (const asset of BRAND_ASSETS) {
  const from = join(root, asset.from)
  const to = join(root, asset.to)
  const want = readFileSync(from)
  if (check) {
    const have = existsSync(to) ? readFileSync(to) : Buffer.alloc(0)
    if (!want.equals(have)) {
      stale = true
      console.error(`STALE: brand asset — ${asset.to} differs from ${asset.from}. Run \`pnpm docs:gen\`.`)
    }
  } else {
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, want)
    console.log(`generated: brand asset → ${asset.to}`)
  }
}

// #696§5: the PLAN MATRIX (per-tier lever values for the LP's comparison table) is a Cloud
// artifact — its generator reads the proprietary plan table, so it lives INSIDE
// packages/entitlements-cloud and is SPAWNED, never imported (a CE-tree import of that namespace
// is the boundary violation the filter refuses to hide; the whole package vanishes from the CE
// mirror, generator included). Present → run in the same mode; absent (the CE tree) → skip loudly.
// #734 / ADR-237 §2.2 (ruling): the EE half of the environment reference, for the same reason
// and in the same shape as the plan matrix below — the CE walk does not enter packages/ee-server,
// because that directory is absent from the public tree. Present → run in the same mode; absent →
// say so and carry on with the CE reference alone.
// Where the EE package lives is #178's question, not this file's: it is mid-move, and the resolver is
// the one place that knows both homes.
const eeSrc = eeServerSourceRoot(root) as string | null
const eeEnvGen = eeSrc ? join(dirname(eeSrc), 'scripts/gen-env-reference-ee.ts') : null
if (eeEnvGen && existsSync(eeEnvGen)) {
  const { status } = spawnSync('pnpm', ['exec', 'tsx', eeEnvGen, ...(check ? ['--check'] : [])], { cwd: root, stdio: 'inherit' })
  if (status !== 0) stale = true
} else {
  console.log('EE environment reference: generator absent (CE tree without the EE package) — skipped.')
}

const planMatrixGen = join(root, 'packages/entitlements-cloud/scripts/gen-plan-matrix.ts')
if (existsSync(planMatrixGen)) {
  const { status } = spawnSync('pnpm', ['exec', 'tsx', planMatrixGen, ...(check ? ['--check'] : [])], {
    cwd: root,
    stdio: 'inherit',
  })
  if (status !== 0) stale = true
} else {
  console.log('plan matrix: generator absent (CE tree without the Cloud package) — skipped.')
}

if (check) {
  if (stale) {
    console.error('Generated docs are stale (code changed without regenerating). See ADR-080 doc↔code linkage.')
    process.exit(1)
  }
  console.log('OK: generated docs are up to date.')
}

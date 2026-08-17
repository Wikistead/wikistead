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
// to end). Theme-independent, extracted once, emitted on :root. Internal var() references are
// rewritten to the kit's own names so the emitted values resolve without the product stylesheet.
const FONT_TOKENS: readonly { from: string; to: string }[] = [
  { from: 'font', to: 'font' }, // body/UI: Inter + Noto Sans JP
  { from: 'font-code', to: 'font-mono' }, // code: Wikistead Mono
  { from: 'font-wordmark', to: 'font-wordmark' }, // the wordmark face, wordmark-ONLY
]

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

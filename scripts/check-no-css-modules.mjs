#!/usr/bin/env node
// CI guard: the web UI is fully migrated off CSS Modules onto Tailwind v4 + the @theme
// token map (Group C-3, ADR-013). Assert NO *.module.css files exist under apps/web/src
// so the migration can't silently regress (a new *.module.css would re-introduce the
// dual styling system + the bare-token bugs the @theme map avoids). Styling lives in
// Tailwind utilities; the only global CSS is tokens.css / print.css / the CodeMirror
// theme (styles/cm-theme.ts), none of which are *.module.css. Run: pnpm lint:no-css-modules
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCAN = join(root, 'apps', 'web', 'src')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.module.css')) out.push(full)
  }
  return out
}

const offenders = walk(SCAN)
if (offenders.length > 0) {
  for (const f of offenders) console.error(`FAIL: CSS Module found: ${f.replace(root, '')}`)
  console.error('The web UI is Tailwind-only — no *.module.css (Group C-3 migration). Convert it to Tailwind utilities.')
  process.exit(1)
} else {
  console.log('OK: no *.module.css under apps/web/src (Tailwind-only).')
}

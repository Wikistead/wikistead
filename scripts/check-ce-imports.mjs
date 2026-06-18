#!/usr/bin/env node
// CI guard: ensure no CE package imports from @wikistead-ee/* (Enterprise packages).
// CE → EE dependency is forbidden (ADR-011). Run via: pnpm lint:no-ee-imports
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const CE_DIRS = ['packages', 'apps']
const EE_IMPORT_PATTERN = /@wikistead-ee\//

function walk(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.ts')) files.push(full)
  }
  return files
}

let found = false
for (const ceDir of CE_DIRS) {
  const files = walk(join(root, ceDir))
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    if (EE_IMPORT_PATTERN.test(content)) {
      console.error(`FAIL: CE file imports EE package: ${file.replace(root, '')}`)
      found = true
    }
  }
}

if (found) {
  console.error('CE must never import from @wikistead-ee/* (ADR-011). Fix the violations above.')
  process.exit(1)
} else {
  console.log('OK: no CE → EE imports found.')
}

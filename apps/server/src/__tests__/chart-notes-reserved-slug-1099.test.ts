// #1099: NOTES.txt's worked example for a workspace slug was `docs` — which
// `apps/server/src/auth/provisioning.ts` RESERVES, so `local-admin` refuses it with
// `"docs" is not a usable tenant slug`. Following the guide verbatim fails at the very first step.
// Precedent: #726 hit the identical accident with `dev` (the self-host guide seeded a `dev` tenant,
// `dev` is reserved, and the evaluation stack had no way in) — `local-admin.ts`'s own comment records
// the lesson, but nothing walked the chart's guidance text to check it stayed learned.
//
// This is a DISCOVERY, not a list: it reads RESERVED from provisioning.ts (so a slug added there is
// covered the day it is reserved, not the day someone remembers to update this file too) and walks
// every text file under the chart for a `slug \`X\`` worked example, checking X against it.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const chartDir = join(root, 'charts/wikistead')

function walkChart(dir = chartDir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkChart(full, out)
    else out.push(full)
  }
  return out
}

function reservedSlugs(): Set<string> {
  const src = readFileSync(join(root, 'apps/server/src/auth/provisioning.ts'), 'utf8')
  const m = src.match(/const RESERVED = new Set\(\[([\s\S]*?)\]\)/)
  expect(m, 'RESERVED is still shaped as a Set([...]) literal this regex can read').toBeTruthy()
  const words = [...m![1].matchAll(/'([a-z0-9-]+)'/g)].map((w) => w[1])
  expect(words.length, 'the set is not empty — a regex that matched nothing would pass every file vacuously').toBeGreaterThan(5)
  return new Set(words)
}

describe('#1099 no chart guidance text uses a RESERVED word as a worked slug example', () => {
  const reserved = reservedSlugs()

  it('finds RESERVED at all (sanity: docs and dev, the two that have already bitten this)', () => {
    expect(reserved.has('docs')).toBe(true)
    expect(reserved.has('dev')).toBe(true)
  })

  it('walks every file under charts/wikistead for `slug `X`` and checks X against RESERVED', () => {
    const offenders: string[] = []
    for (const file of walkChart()) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/slug `([a-z0-9-]+)`/g)) {
        if (reserved.has(m[1])) offenders.push(`${relative(root, file)}: slug \`${m[1]}\` is reserved`)
      }
    }
    expect(offenders).toEqual([])
  })
})

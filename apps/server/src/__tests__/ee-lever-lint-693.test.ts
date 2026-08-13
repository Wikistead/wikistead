// #693: the lever-placement guard, break-checked against scratch trees so every refusal
// direction is MEASURED — the first version's manual break-check missed that its predicate matched
// i18n strings and let two TS spellings straight through, and nothing kept measuring after it.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { scanForEeLeverReads, stripStrings } from '../../../../scripts/check-ee-lever-placement.mjs'

const CATALOG = `export const LEVER_CATALOG = {
  samlSso: {
    edition: 'ee',
    doc: 'x',
  },
  guestAccess: {
    doc: 'x',
  },
}
`

const cleanup: string[] = []
function scratchTree(files: Record<string, string>, catalog = CATALOG): string {
  const root = mkdtempSync(join(tmpdir(), 'lever693-'))
  cleanup.push(root)
  mkdirSync(join(root, 'packages/entitlements/src'), { recursive: true })
  writeFileSync(join(root, 'packages/entitlements/src/catalog.ts'), catalog)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, 'apps/x/src'), { recursive: true })
    writeFileSync(join(root, 'apps/x/src', rel), content)
  }
  return root
}
afterAll(() => { for (const r of cleanup.splice(0)) rmSync(r, { recursive: true, force: true }) })

type Scan = { eeLevers: string[]; hits: { file: string; lever: string; form: string }[] }
const scan = (root: string) => scanForEeLeverReads(root) as Scan

describe('#693 every spelling of a lever read is refused', () => {
  it('property access is a hit', () => {
    const r = scan(scratchTree({ 'a.ts': 'if (resolveEntitlements(plan).samlSso) deny()\n' }))
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]).toMatchObject({ lever: 'samlSso', form: 'property access' })
  })

  it('bracket access is a hit (the first version let it through)', () => {
    const r = scan(scratchTree({ 'a.ts': "if (ent['samlSso']) deny()\n" }))
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.form).toBe('bracket access')
  })

  it('assignment destructuring is a hit (the first version let it through)', () => {
    const r = scan(scratchTree({ 'a.ts': 'const { guestAccess, samlSso } = resolveEntitlements(plan)\n' }))
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.form).toBe('destructuring')
  })

  it('a STRING-ONLY file does not hit — i18n keys are not reads (the headline)', () => {
    const r = scan(scratchTree({
      'nav.tsx': 'const label = t("adminNav.samlSso")\nconst other = `spaceSettings.samlSso`\n',
    }))
    expect(r.hits, 'an i18n key was mistaken for an enforcement read').toEqual([])
  })

  it('comments are not reads', () => {
    const r = scan(scratchTree({ 'a.ts': '// resolveEntitlements(plan).samlSso is the shape this guard refuses\n' }))
    expect(r.hits).toEqual([])
  })

  it('a CE lever read is no business of this guard', () => {
    const r = scan(scratchTree({ 'a.ts': 'if (resolveEntitlements(plan).guestAccess) allow()\n' }))
    expect(r.hits).toEqual([])
  })

  it("removing a lever's edition marker silences ITS detection — the column is load-bearing", () => {
    const noEdition = CATALOG.replace("    edition: 'ee',\n", '')
    // the injected read that WOULD be a hit sails through, and the empty deny-set is refused loudly
    expect(() => scan(scratchTree({ 'a.ts': 'if (e.samlSso) deny()\n' }, noEdition)))
      .toThrow(/no EE levers/)
  })

  it('stripStrings blanks contents but keeps the quotes and the line count', () => {
    const out = stripStrings('a "x.y\nz" b `t${v}` c') as string
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('"')
    expect(out).not.toContain('x.y')
  })
})

describe('#693: the real tree stays clean', () => {
  it('the repo scan answers zero hits (the seam replaced every read — no pragma, no allow-list)', () => {
    const r = scanForEeLeverReads() as Scan
    expect(r.eeLevers.length).toBeGreaterThanOrEqual(5)
    expect(r.hits.map((h: { file: string }) => h.file), 'a CE lever read crept back in').toEqual([])
  })
})

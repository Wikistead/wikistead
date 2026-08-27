// ADR-253 §3.2: `infra/openfga/model.fga` is found the way the migrations are found — minus the
// door. Modelled directly on migrations-in-the-image-804.test.ts's shape: the resolver has to look
// where the image puts the DSL, AND the image has to put it there, or the fix is half a fix.
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { modelDslPathCandidates, chooseModelDslPath } from '../openfga-model-path.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const dockerfile = join(repoRoot, 'apps/server/Dockerfile')

// #849's lesson, applied here too: everything before the LAST `FROM … AS <name>` belongs to a stage
// whose filesystem is discarded, so a COPY there ships nothing.
function runtimeStageLines(text: string): string[] {
  const lines = text.split('\n')
  let last = -1
  lines.forEach((l, i) => { if (/^\s*FROM\s/i.test(l)) last = i })
  expect(last, 'no FROM line — this is not a Dockerfile').toBeGreaterThanOrEqual(0)
  return lines.slice(last + 1)
}

describe('ADR-253 §3.2 the model DSL ships with the image that needs it', () => {
  it('the resolver finds the DSL in a deploy tree, where the image puts it', () => {
    const present = new Set(['/app/model.fga'])
    const choice = chooseModelDslPath('/app/dist', (p) => present.has(p))
    expect(choice).toEqual({ kind: 'found', path: '/app/model.fga' })
  })

  it('the resolver still finds the DSL in a checkout, compiled or not', () => {
    for (const moduleDir of ['/repo/apps/server/src', '/repo/apps/server/dist']) {
      const present = new Set(['/repo/infra/openfga/model.fga'])
      const choice = chooseModelDslPath(moduleDir, (p) => present.has(p))
      expect(choice, moduleDir).toEqual({ kind: 'found', path: '/repo/infra/openfga/model.fga' })
    }
  })

  it('the deploy layout wins when both are present, and neither present refuses in words', () => {
    const both = new Set(['/app/model.fga', '/repo/infra/openfga/model.fga'])
    // Candidates are always deploy-tree-shaped first in this test's fixture module dir, so the first
    // candidate (deploy layout) is what should win when both exist.
    const choice = chooseModelDslPath('/app/dist', (p) => both.has(p))
    expect(choice).toEqual({ kind: 'found', path: '/app/model.fga' })

    // Nothing found is a refusal that NAMES both candidates — never a guess, and never a silent
    // `undefined` a downstream throw would swallow without saying which paths were tried.
    const none = chooseModelDslPath('/app/dist', () => false)
    expect(none.kind).toBe('none')
    if (none.kind === 'none') expect(none.candidates).toEqual(modelDslPathCandidates('/app/dist'))
  })

  it('there is no operator override — no environment variable ever wins', () => {
    // Unlike migrationsDirCandidates, modelDslPathCandidates takes no env argument at all: an
    // authorization model may not differ from the one this code was built against (ADR-253 §3.2),
    // so there is no third candidate and nothing here to prefer one.
    expect(modelDslPathCandidates('/app/dist')).toHaveLength(2)
  })

  it('the image copies the DSL to the place the resolver looks first', () => {
    const text = readFileSync(dockerfile, 'utf8')
    const target = modelDslPathCandidates('/app/dist')[0]! // /app/model.fga
    const copies = runtimeStageLines(text)
      .filter((l) => /^\s*COPY\s/.test(l) && !/--from=/.test(l))
      .map((l) => l.trim())
    expect(copies.length, 'the last stage has no plain COPY lines — did the Dockerfile change shape?').toBeGreaterThan(0)
    const carriesDsl = copies.some((l) => l.includes('infra/openfga/model.fga') && l.includes(target))
    expect(carriesDsl, `no COPY in the shipped stage puts infra/openfga/model.fga at ${target}:\n${copies.join('\n')}`).toBe(true)
  })

  // #849's other half: a source regex for "asks the resolver" can miss the real reader. Both named
  // consumers (ADR-253 §3.2) are exercised for real elsewhere — `assertFgaModelFresh` by
  // fga-model-guard-433.test.ts, which runs the guard end to end — but that file never imports
  // `openfga-model-path.js` by name, so it would stay green if the guard silently grew its own path
  // again. This asserts the import survives, which the running suite then holds meaningful.
  it('the shipping guard imports the shared resolver, not a path of its own', () => {
    const src = readFileSync(join(repoRoot, 'apps/server/src/openfga-guard.ts'), 'utf8')
    // Dynamic (`await import(...)`) in the guard, static in the migration script below — the
    // specifier string is what both forms share.
    expect(src, 'openfga-guard.ts does not import the resolver').toMatch(/['"]\.\/openfga-model-path\.js['"]/)
    expect(src, 'openfga-guard.ts imports the resolver but does not ask it').toMatch(/\bchooseModelDslPath\(/)
  })

  it('the editor-274 migration script asks the same resolver, from its own depth', () => {
    const src = readFileSync(join(repoRoot, 'apps/server/src/scripts/migrate-editor-274.ts'), 'utf8')
    expect(src, 'migrate-editor-274.ts does not import the resolver').toMatch(/from '\.\.\/openfga-model-path\.js'/)
    expect(src, 'migrate-editor-274.ts imports the resolver but does not ask it').toMatch(/\bchooseModelDslPath\(/)
  })

  it("migrate-editor-274's finalDsl resolves from the file's own depth, one directory below the guard", async () => {
    // This file sits at src/scripts (dist/scripts once built) — one directory deeper than
    // openfga-guard.ts's own src (dist). Passing the wrong depth to the shared candidates function
    // would silently look one level off in a deploy tree (/app/dist/model.fga instead of
    // /app/model.fga) while still finding the repository candidate in every checkout and test run —
    // exactly the kind of depth mismatch that stays green everywhere this suite can see and breaks
    // only in the image. Run against THIS repository's real depth rather than a synthetic one.
    const { finalDsl } = await import('../scripts/migrate-editor-274.js')
    expect(() => finalDsl()).not.toThrow()
    expect(finalDsl()).toContain('model')
  })
})

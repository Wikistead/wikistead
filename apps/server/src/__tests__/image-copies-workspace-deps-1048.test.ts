// #1048: every workspace package an app's image needs is COPYed into that image.
//
// The Dockerfiles name their workspace packages one COPY line at a time, and a package added to
// package.json is not added there by anything — the public CI's image-boundary job went red the day
// @wikistead/i18n-shared shipped (#1006) because `pnpm install` inside the image could not find a
// workspace package the manifest demanded. Nothing on the dev side reads the Dockerfile, so the
// dev build, typecheck and suite were all green while every image was unbuildable.
//
// Discovery, not a list: the dependency closure is read from the package manifests and the COPY
// set from the Dockerfile, so tomorrow's package is covered the day it is declared. Both counts are
// printed in the assertion messages — a walk that found no packages is not a pass (#719).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'))
const dirOf = (name: string) => `packages/${name.slice('@wikistead/'.length)}`
const workspaceNames = (deps: Record<string, string> | undefined) =>
  Object.entries(deps ?? {}).filter(([n, r]) => r.startsWith('workspace:') && n.startsWith('@wikistead/')).map(([n]) => n)

/** Workspace packages `pkgDir` needs AT RUNTIME, transitively, by their directory under packages/. */
function runtimeClosure(pkgDir: string, seen = new Set<string>()): Set<string> {
  for (const name of workspaceNames(manifestOf(pkgDir).dependencies)) {
    const dir = dirOf(name)
    // A workspace dep whose directory is absent here is the CE build's derived detachment (the EE
    // packages leave the mirror and the fixup prunes their lines) — not this pin's subject.
    if (!existsSync(join(repoRoot, dir, 'package.json')) || seen.has(dir)) continue
    seen.add(dir)
    runtimeClosure(dir, seen)
  }
  return seen
}

/** The `COPY packages/<x> …` lines of a Dockerfile, as package directories. */
function copiedPackages(dockerfile: string): Set<string> {
  const out = new Set<string>()
  for (const line of readFileSync(join(repoRoot, dockerfile), 'utf8').split('\n')) {
    const m = /^COPY\s+(packages\/[\w-]+)\s/.exec(line)
    if (m) out.add(m[1]!)
  }
  return out
}

describe('#1048: an image COPYs every workspace package its app depends on', () => {
  for (const app of ['apps/server', 'apps/web', 'apps/collab']) {
    it(`${app}/Dockerfile carries ${app}'s runtime workspace closure`, () => {
      const needed = runtimeClosure(app)
      const copied = copiedPackages(`${app}/Dockerfile`)
      expect(needed.size, `${app} declares no workspace packages — the walk found nothing`).toBeGreaterThan(0)
      const missing = [...needed].filter((d) => !copied.has(d))
      expect(missing, `${app}/Dockerfile COPYs ${copied.size} package(s); ${app} needs ${needed.size} — add a COPY line for each of these`).toEqual([])
    })

    // `pnpm install` inside the image resolves devDependencies too, so a workspace devDependency
    // that is neither COPYed nor deliberately stripped (the way apps/server/Dockerfile deletes the
    // test-only entitlements-cloud line from package.json) fails the install the same way.
    it(`${app}/Dockerfile accounts for ${app}'s workspace devDependencies`, () => {
      const dockerfile = readFileSync(join(repoRoot, `${app}/Dockerfile`), 'utf8')
      const copied = copiedPackages(`${app}/Dockerfile`)
      const unaccounted = workspaceNames(manifestOf(app).devDependencies)
        .filter((name) => !copied.has(dirOf(name)) && !dockerfile.includes(name))
      expect(unaccounted, `${app}/Dockerfile neither COPYs nor strips these — the image's install cannot resolve them`).toEqual([])
    })
  }
})

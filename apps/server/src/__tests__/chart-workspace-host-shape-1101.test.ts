// #1101: the chart contradicted itself about where a workspace lives. `values.yaml`'s own example
// (`https://{slug}.example.com`, glued straight onto a TLD-looking suffix) and the identical example
// once in NOTES.txt were both ONE LABEL SHALLOWER than `ingress.wildcardHost`'s `*.<host>` rule
// actually serves — and a stray comment in config.yaml called the wildcard "shallower" than `host`
// when it is deeper. Measured on a kind cluster (workspaceHostTemplate=932's): the shallow form
// resolved to nothing; only `{slug}.<host>` worked.
//
// Fixed by making the docs match the working shape, and — the real fix the ticket asked for — a
// chart-level check (`wikistead.validateWorkspaceHostTemplate` in _helpers.tpl, invoked from
// config.yaml) that fails the render outright if `workspaceHostTemplate` and `ingress.wildcardHost`
// ever disagree again.
//
// Verified by hand with `helm template` (not a CI pin: helm is not on the CI runner, same constraint
// noted in edge-security-headers-880.test.ts and chart-deploy-blockers-1083.test.ts):
//   - unset workspaceHostTemplate                                              → renders
//   - workspaceHostTemplate=https://{slug}.<host>, wildcardHost=true           → renders
//   - workspaceHostTemplate=https://{slug}.<shorter-suffix>, wildcardHost=true → `helm template` fails
//   - workspaceHostTemplate set, wildcardHost=false                           → `helm template` fails
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const chart = (f: string) => readFileSync(join(root, 'charts/wikistead', f), 'utf8')

describe('#1101 the docs describe the shape the wildcard actually serves', () => {
  it("values.yaml's example is the deep form, matching its own default host", () => {
    const values = chart('values.yaml')
    const line = values.split('\n').find((l) => l.includes('workspaceHostTemplate:'))
    expect(line, 'the default line exists').toBeTruthy()
    expect(line).toContain('{slug}.wikistead.example.com')
    expect(line, 'the shallow form that resolves to nothing must not return').not.toMatch(/\{slug\}\.example\.com\b/)
  })

  it("NOTES.txt's example is templated from .Values.host, not a static (and possibly wrong) string", () => {
    const notes = chart('templates/NOTES.txt')
    expect(notes).toContain('https://{slug}.{{ .Values.host }}')
  })

  it('the WKS_TENANT_URL_TEMPLATE comment says the wildcard is deeper than host, not shallower', () => {
    const config = chart('templates/config.yaml')
    expect(config).toContain('one label deeper than the application')
    expect(config).not.toMatch(/one label shallower than the application/)
  })
})

describe('#1101 a mismatched workspaceHostTemplate fails the render, not the browser', () => {
  it('validateWorkspaceHostTemplate checks both the host shape and wildcardHost', () => {
    const helpers = chart('templates/_helpers.tpl')
    const def = helpers.slice(helpers.indexOf('wikistead.validateWorkspaceHostTemplate'))
    expect(def).toContain('ingress.wildcardHost')
    expect(def).toMatch(/fail\s*\(/)
    expect(def).toContain('{slug}.%s')
  })

  it('config.yaml invokes the check before it ever emits the ConfigMap', () => {
    const config = chart('templates/config.yaml')
    const checkIdx = config.indexOf('wikistead.validateWorkspaceHostTemplate')
    const kindIdx = config.indexOf('kind: ConfigMap')
    expect(checkIdx, 'the check is actually wired in').toBeGreaterThan(-1)
    expect(checkIdx).toBeLessThan(kindIdx)
  })
})

// #1102: `helm upgrade` changing a value that lands in the shared ConfigMap or Secret (measured on a
// kind cluster with `workspaceHostTemplate`) left the running pods on the OLD value — `envFrom` and
// `secretKeyRef` are read once, at container start, and neither object's own content is part of the
// Deployment's spec for Kubernetes to diff. `rollout status` still reported success.
//
// Fix: hash both rendered manifests into a pod-template annotation (`wikistead.envChecksum` in
// _helpers.tpl), so the Deployment's own spec changes whenever their content does — the standard Helm
// idiom for this class of bug. Verified by hand with `helm template` (not a CI pin: helm is not on the
// CI runner, same constraint noted in edge-security-headers-880.test.ts) — the annotation's value did
// change when `workspaceHostTemplate` changed, and did not otherwise.
//
// Only `server` and `collab` read the shared ConfigMap/Secret via `envFrom`/`secretKeyRef` into it;
// `web` is static nginx and, per its own comment, "reads no configuration and holds no secret" — giving
// it the annotation too would be actively misleading, so its ABSENCE there is asserted as well.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const chart = (f: string) => readFileSync(join(root, 'charts/wikistead', f), 'utf8')

describe('#1102 the shared config/secret content is hashed into an annotation', () => {
  it('wikistead.envChecksum hashes both the ConfigMap and the Secret manifests', () => {
    const helpers = chart('templates/_helpers.tpl')
    const def = helpers.slice(helpers.indexOf('wikistead.envChecksum'))
    expect(def).toContain('/config.yaml')
    expect(def).toContain('/secret.yaml')
  })

  for (const [file, name] of [['server.yaml', 'server'], ['collab.yaml', 'collab']] as const) {
    it(`${name}'s pod template carries the annotation, so a content-only change rolls it`, () => {
      const tpl = chart(`templates/${file}`)
      expect(tpl).toMatch(/checksum\/config:\s*\{\{\s*include "wikistead\.envChecksum" \.\s*\|\s*sha256sum\s*\}\}/)
    })
  }

  it("web carries no such annotation — it reads neither object, so hashing them would roll it for nothing", () => {
    expect(chart('templates/web.yaml')).not.toMatch(/checksum\/config/)
  })
})

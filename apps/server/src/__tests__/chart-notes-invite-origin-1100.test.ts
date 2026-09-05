// #1100: NOTES.txt's first-admin command always passed `--origin=https://<host>` — the APPLICATION's
// own host, not a workspace's. `local-admin.ts`'s `renderTenantOrigin` already builds the correct
// workspace address (`{slug}.<host>`) from `workspaceHostTemplate` automatically whenever `--origin` is
// OMITTED (see `readTenantUrlTemplate`/`render` in auth/tenant-url-template.ts) — passing `--origin`
// unconditionally overrode that with the wrong host, and the printed invite link 404'd
// (`resolveTenantFromHost` reads the first label of whatever host the browser actually opened).
// Measured on a kind cluster with a real browser (932's): reissuing on the workspace host worked.
//
// A second, independent defect in the same line: the scheme was hardcoded `https://` even when
// `ingress.tls.enabled` is false, so a plaintext install still printed a link that hits a self-signed
// 443 listener nothing serves.
//
// Fix: `--origin` is now only printed when `workspaceHostTemplate` is UNSET (the one case where
// `renderTenantOrigin` has nothing to derive from and truly needs it), and its scheme follows
// `ingress.tls.enabled` rather than being fixed.
//
// Verified with `helm template` (not a CI pin — same helm-is-not-on-the-CI-runner constraint as
// chart-deploy-blockers-1083.test.ts): the chart still renders in both the template-set and
// template-unset shapes, and a deliberately broken NOTES.txt (referencing a nonexistent value) makes
// `helm template` fail — confirming NOTES.txt is genuinely evaluated, not skipped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const notes = () => readFileSync(join(root, 'charts/wikistead/templates/NOTES.txt'), 'utf8')

describe('#1100 the first-admin invite link addresses a workspace, not the app', () => {
  it('--origin is gated on workspaceHostTemplate being UNSET, not printed unconditionally', () => {
    const text = notes()
    const line = text.split('\n').find((l) => l.includes('local-admin.js'))
    expect(line, 'the command line exists').toBeTruthy()
    expect(line).toContain('{{ if not .Values.workspaceHostTemplate }}')
    expect(line).toContain('--origin=')
    // The old, unconditional form: --origin immediately after --create with no guard before it.
    expect(line).not.toMatch(/--create --origin=https:\/\/\{\{\s*\.Values\.host\s*\}\}/)
  })

  it('when --origin IS printed, its scheme follows ingress.tls.enabled rather than being fixed', () => {
    const line = notes().split('\n').find((l) => l.includes('local-admin.js'))!
    expect(line).toMatch(/ternary "https" "http" \.Values\.ingress\.tls\.enabled/)
  })
})

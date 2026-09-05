// #1083-#1087: the Helm chart's first real install (kind + stock ingress-nginx, 2026-09-03) failed
// three times in a row before reaching the app. Each failure is pinned here at the exact expression
// the ruling fixed, so none of them can quietly come back:
//
//   #1083  values default securityHeaderSnippet: true — ingress-nginx ships with snippet
//          annotations DISABLED and its admission webhook rejects the whole install.
//   #1084  the migrate hook ran dist/scripts/migrate.js; the image compiles src/migrate.ts to
//          dist/migrate.js. One wrong path segment, Job dead, install failed.
//   #1085  the fga-bootstrap hook ran a file the image never contained. ADR-253's startup
//          resolve makes the hook unnecessary — measured: a server with NO store ids in its
//          secret resolves (or creates) the store by name and comes up. The hook is deleted.
//   #1086  secrets.generate minted OIDC_SECRET_ENC_KEY with randAlphaNum 64 → decodes to 48
//          bytes; the server requires exactly 32 and the recommended first-install path could
//          never boot.
//   #1087  NOTES' first-admin command omitted --origin, which the CLI refuses without
//          WKS_TENANT_URL_TEMPLATE — the chart's own default configuration.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const chart = (f: string) => readFileSync(join(root, 'charts/wikistead', f), 'utf8')

describe('#1084 the migrate hook runs a file the image actually compiles', () => {
  it('names dist/migrate.js, whose source exists as apps/server/src/migrate.ts', () => {
    const hooks = chart('templates/hooks.yaml')
    expect(hooks).toContain('command: ["node", "dist/migrate.js"]')
    expect(hooks, 'the path that never existed in the image must not return').not.toContain('dist/scripts/migrate.js')
    expect(existsSync(join(root, 'apps/server/src/migrate.ts')), 'the compiled name tracks this source file').toBe(true)
  })
})

describe('#1085 the fga-bootstrap hook stays deleted', () => {
  it('no template or value resurrects it', () => {
    expect(chart('templates/hooks.yaml')).not.toMatch(/fga-bootstrap|fgaBootstrap/)
    expect(chart('values.yaml')).not.toMatch(/fgaBootstrap:\s*true/)
  })
  it('…because the server carries the model and resolves the store itself (ADR-253)', () => {
    // The two halves the startup resolve depends on: the model in the image, the resolver in the app.
    expect(readFileSync(join(root, 'apps/server/Dockerfile'), 'utf8')).toContain('COPY infra/openfga/model.fga /app/model.fga')
    expect(existsSync(join(root, 'apps/server/src/openfga-resolve.ts'))).toBe(true)
  })
})

describe('#1086 the generated OIDC key decodes to exactly 32 bytes', () => {
  it('secret.yaml mints it with randBytes 32, never randAlphaNum', () => {
    const secret = chart('templates/secret.yaml')
    expect(secret).toMatch(/OIDC_SECRET_ENC_KEY:.*randBytes 32/)
    expect(secret).not.toMatch(/OIDC_SECRET_ENC_KEY:.*randAlphaNum/)
  })
})

describe('#1083 the ingress default survives a stock ingress-nginx', () => {
  it('securityHeaderSnippet defaults to false', () => {
    expect(chart('values.yaml')).toMatch(/securityHeaderSnippet:\s*false/)
  })
})

describe('#1087 the NOTES first-admin command can actually run', () => {
  it('carries --origin, which the CLI refuses to work without on the chart default config', () => {
    const notes = chart('templates/NOTES.txt')
    const line = notes.split('\n').find((l) => l.includes('local-admin.js'))
    expect(line, 'the first-admin command exists').toBeTruthy()
    // #1100: on the chart's default config (workspaceHostTemplate unset), --origin is still printed —
    // its scheme now follows ingress.tls.enabled instead of being fixed to https.
    expect(line).toContain('--origin={{ ternary "https" "http" .Values.ingress.tls.enabled }}://{{ .Values.host }}')
  })
})

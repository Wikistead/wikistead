// #575 / ADR-200 slice D: the server half of "the product name is a value, not a literal".
//
// Slice A pinned the web bundle. The server writes the name in places the client never sees — mail
// subjects and bodies, the MCP consent screen, the authoring-syntax reference an LLM reads — and those
// are exactly the surfaces a rename would leave behind, because nobody opens them while renaming.
//
// The interesting part of this pin is the exemption list, because the name appears in two genuinely
// different roles:
//
//   - as a NAME on a screen or in a message. Must come from `productName()`.
//   - as an IDENTIFIER in a protocol or in infrastructure: the `x-wikistead-*` webhook headers that
//     receivers match on, the `_wikistead-challenge` DNS record, the `wikistead.io/...` k8s labels, the
//     MCP `serverInfo.name` a client keys its config off, the `@wikistead/*` package scope, and the
//     `wikistead.local` fallback mail DOMAIN. Renaming any of those breaks something outside this repo
//     and changes nothing anyone reads. They are listed BY FILE with the reason, so the list is a set of
//     decisions rather than a regex that quietly swallows the next real offender.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// #178: the EE package is mid-move to the ee/ overlay, so its source root is RESOLVED, not hard-coded
// — null only in a genuinely CE-only clone (an overlay that drifted throws in the resolver instead).
// @ts-expect-error — .mjs script module, no types; #621: the image build has no repo-root scripts/
import { eeServerSourceRoot } from '../../../../scripts/ee-source-root.mjs'

const SERVER = resolve(import.meta.dirname, '..')
const EE = eeServerSourceRoot(resolve(import.meta.dirname, '../../../..'))
const NAME = /[Ww]ikistead/

/** Files allowed to write the name, each because it is an identifier or IS the fallback. */
const ALLOWED: Record<string, string> = {
  'product-name.ts': 'the fallback itself — a fallback cannot be a lookup',
  'routes/webhooks.ts': 'x-wikistead-signature / -timestamp: wire headers receivers match on',
  'routes/mcp.ts': 'serverInfo.name: the MCP client keys its config off this identifier',
  'auth/dns-challenge.ts': '_wikistead-challenge: a DNS record name the operator publishes',
  'deploy/cert-manifest.ts': 'wikistead.io/* : kubernetes label keys',
  'openfga-resolve.ts': "STORE_NAME = 'wikistead': the OpenFGA store's own name, an identifier every self-resolving deployment's tooling already creates it under (ADR-253 §3.3), not a display name",
  'email/index.ts': 'noreply@wikistead.local: the fallback mail DOMAIN, not a display name',
}
const ALLOWED_EE: Record<string, string> = {
  'email/managed-driver.ts': 'the EE-side fallback + the fallback mail domain',
  'scim/router.ts': 'documentationUri: a URL',
}

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n')

const sources = (root: string): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) { if (entry !== 'dist' && entry !== '__tests__') walk(p) }
      else if (/\.ts$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p)
    }
  }
  walk(root)
  return out
}

const offendersIn = (root: string, allowed: Record<string, string>): string[] =>
  sources(root)
    .filter((f) => !(f.slice(root.length + 1) in allowed))
    .filter((f) => NAME.test(withoutComments(readFileSync(f, 'utf8')).replace(/@wikistead(-ee)?\/[a-z-]+/g, '')))
    .map((f) => f.slice(root.length + 1))

describe('#575 slice D: the server reads the product name rather than writing it', () => {
  it('no server source writes it outside the named identifier files', () => {
    expect(offendersIn(SERVER, ALLOWED), 'use productName()').toEqual([])
  })

  // skipIf, not a silent branch: in a CE-only clone there is no EE source to sweep and the skip is
  // visible in the run. In this upstream the resolver always finds it (or throws on a drifted overlay).
  it.skipIf(EE === null)('nor does EE', () => {
    expect(offendersIn(EE!, ALLOWED_EE), 'use the deployment value').toEqual([])
  })

  it('the exemption list is not stale — every entry is a real file', () => {
    for (const rel of Object.keys(ALLOWED)) expect(() => readFileSync(join(SERVER, rel), 'utf8'), rel).not.toThrow()
    if (EE !== null)
      for (const rel of Object.keys(ALLOWED_EE)) expect(() => readFileSync(join(EE, rel), 'utf8'), rel).not.toThrow()
  })

  it('the surfaces slice B and D converted really interpolate it', () => {
    const read = (rel: string) => readFileSync(join(SERVER, rel), 'utf8')
    expect(read('routes/members.ts'), 'the invite mail').toMatch(/\$\{productName\(\)\}/)
    expect(read('routes/mcp-oauth-flow.ts'), 'the MCP consent screen').toMatch(/productName\(\)/)
    expect(read('routes/mcp.ts'), 'the authoring-syntax reference').toMatch(/\$\{productName\(\)\}/)
    expect(read('email/layout.ts'), 'the mail shell takes it from the branding value').toMatch(/productName/)
  })
})

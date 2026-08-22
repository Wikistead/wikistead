// #828 / ADR-254 Acceptance: the address each shipped topology would compose is either a host that
// topology SERVES, or no address at all.
//
// ⚠️ Read as TEXT, and not from `pnpm lint:selfhost-profile`. That script prints SKIPPED and exits 0
// when `docker compose config` is unavailable, and CI never creates the `.env` that `env_file:`
// requires — a pin placed there would be green by absence. Deriving hosts from the Caddyfile has a
// precedent in `scripts/check-origin-routes.mjs`.
//
// ⚠️ The compose EFFECTIVE value is `env_file` ∪ `environment`, so `.env.example` is read too;
// reading only `docker-compose.yml` measures a document rather than a deployment.
//
// ⚠️ `deploy/k8s/**` is filtered from the published tree (measured: `isFilteredPath` says so for
// both files below, and says no for the Caddyfile and the compose file). So the k8s half ASKS
// whether the files are there and skips its cases when they are not, rather than this whole file
// being excluded from publication — excluding it would take the compose and Caddy cases, which do
// ship, along with it. Measured by hiding `deploy/k8s` and re-running: the compose cases still fail
// when the compose value is restored.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

// ── the composition, stated once ───────────────────────────────────────────────────────────────
// What `composeTenantUrl` does, expressed over text: the workspace slug is prefixed onto the host of
// the declared zone. This pin measures the CONFIGURATION, so the composition has to be written here;
// that it matches the code is `mail-address-828.test.ts`'s job.
const compose = (slug: string, zone: string): string => {
  const u = new URL(zone)
  return `${u.protocol}//${slug}.${u.host}`
}

// ── what each topology serves ──────────────────────────────────────────────────────────────────
/** Site addresses from the Caddyfile: an UNINDENTED, uncommented line ending in `{`. */
const caddySites = (): string[] =>
  read('deploy/caddy/Caddyfile')
    .split('\n')
    .filter((l) => /^\S.*\{\s*$/.test(l) && !l.trimStart().startsWith('#'))
    .map((l) => l.replace(/\s*\{\s*$/, '').trim())

/** Ingress `rules:` hosts — what the cluster ROUTES. TLS is a separate fact and #123's business. */
const ingressHosts = (): string[] =>
  [...read('deploy/k8s/base/ingress.yaml').matchAll(/^\s*-\s+host:\s*"?([^"\s]+)"?/gm)].map((m) => m[1]!)

/** Does `url`'s host match one of these site addresses, with `SITE_HOST` bound to `siteHost`? */
const servedByCaddy = (url: string, siteHost: string): boolean => {
  const host = new URL(url).hostname
  return caddySites().some((site) => site.replace(/\{\$SITE_HOST(?::[^}]*)?\}/g, siteHost) === host)
}

const servedByIngress = (url: string): boolean => {
  const host = new URL(url).hostname
  return ingressHosts().some((h) =>
    h.startsWith('*.') ? host.endsWith(h.slice(1)) && host.split('.').length === h.split('.').length : h === host)
}

// ── what each topology declares ────────────────────────────────────────────────────────────────
/** The compose effective value: `environment:` wins, `env_file` shows through only when absent. */
const composeDeclaredZone = (): string | null => {
  const yml = read('docker-compose.yml')
  const inEnvironment = yml.match(/^\s+WKS_PUBLIC_BASE_URL:\s*(.*)$/m)
  if (inEnvironment) {
    const raw = inEnvironment[1]!.trim().replace(/^["']|["']$/g, '')
    return raw === '' ? null : raw
  }
  const inEnvFile = read('.env.example').match(/^\s*WKS_PUBLIC_BASE_URL=(.+)$/m)
  return inEnvFile ? inEnvFile[1]!.trim() : null
}

const K8S = 'deploy/k8s/base/ingress.yaml'
const haveK8s = existsSync(resolve(ROOT, K8S))

describe('#828 the address a topology composes is one it serves, or none', () => {
  it('compose: declares no zone, so it composes no address', () => {
    // Decision 2. Before #828 this said `https://${SITE_HOST}`, which composed
    // `https://<slug>.<SITE_HOST>` — an address the Caddyfile beside it does not serve.
    expect(composeDeclaredZone(), 'the compose profile declares a zone again — check it is served').toBeNull()
  })

  it('compose: the value is BLANK, not deleted — `env_file` would otherwise show through', () => {
    // ⚠️ Deleting the line does not remove the variable: the service carries `env_file: [.env]` and
    // compose merges the file in. This pin is the difference between "absent" and "blank", which
    // `composeDeclaredZone` above deliberately cannot tell apart (it answers null for both).
    expect(read('docker-compose.yml'), 'the line was deleted; the operator\'s own .env now shows through')
      .toMatch(/^\s+WKS_PUBLIC_BASE_URL:\s*""\s*$/m)
  })

  it.skipIf(!haveK8s)('kubernetes: declares no WKS_PUBLIC_BASE_URL, so it composes no address', () => {
    expect(read('deploy/k8s/overlays/prod/kustomization.yaml')).not.toMatch(/WKS_PUBLIC_BASE_URL/)
  })

  // ── the served-or-not side, which both shipped topologies would otherwise never exercise ──────
  it.skipIf(!haveK8s)('positive: the parent zone composes an address the cluster routes', () => {
    expect(servedByIngress(compose('acme', 'https://wikistead.com')), 'the ingress wildcard stopped covering it').toBe(true)
  })

  it.skipIf(!haveK8s)('negative: the app\'s own origin composes an address nothing routes', () => {
    // The reading the catalog USED to invite — set it to the application's origin. The composition
    // then lands a label deeper than the wildcard, which matches nothing.
    expect(servedByIngress(compose('acme', 'https://app.wikistead.com'))).toBe(false)
  })

  it('negative: the site host composes an address the Caddyfile does not serve', () => {
    // The exact defect #828 is about, in the shipped compose profile's own terms.
    expect(servedByCaddy(compose('acme', 'https://wiki.example.com'), 'wiki.example.com')).toBe(false)
  })

  it('positive: the PARENT zone composes the site host itself, which the Caddyfile serves', () => {
    // Decision 3's recovery recipe: one line in an override, no wildcard, no #123.
    expect(servedByCaddy(compose('wiki', 'https://example.com'), 'wiki.example.com'),
      'the recovery recipe in docker-compose.yml no longer works').toBe(true)
  })

  it('⚠️ negative: the parent zone with a slug that is NOT the site host\'s first label', () => {
    // The case the other four assume away — Decision 3's precondition 1. A second workspace in a
    // single-host deployment has its mail pointed somewhere nobody serves, and nothing can check it,
    // which is why the compose comment says so in prose.
    expect(servedByCaddy(compose('other', 'https://example.com'), 'wiki.example.com')).toBe(false)
  })
})

describe('#828 the prose that stands in for a check is itself checked', () => {
  // Decision 3 chose prose over a check and NAMED that prose as what stands in for one. Prose that
  // nothing asserts is one edit from being gone. Brittle and present beats absent, given that the
  // alternative here was to have no check at all.
  const around = (): string => {
    const yml = read('docker-compose.yml')
    const at = yml.search(/^\s+WKS_PUBLIC_BASE_URL:\s*""\s*$/m)
    expect(at, 'the value moved; this pin is reading the wrong part of the file').toBeGreaterThan(-1)
    return yml.slice(Math.max(0, at - 1800), at)
  }

  it('names precondition 1: one workspace, named after the site host\'s first label', () => {
    expect(around()).toMatch(/first label/)
  })

  it('names precondition 2: the operator owns the whole parent zone', () => {
    expect(around()).toMatch(/parent\s+\n?\s*#?\s*zone|owns the whole parent/)
  })

  it('carries the recovery recipe, so the blank value is not a dead end', () => {
    expect(around()).toMatch(/docker-compose\.override\.yml/)
    expect(around(), 'the recipe does not show the override line itself').toMatch(/WKS_PUBLIC_BASE_URL:\s*https:\/\//)
  })
})

// #806 / ADR-249: a workspace address is a SHAPE the deployment declares, not a hostname to guess at.
//
// Four places used to answer "what is this workspace's address" from three different inputs. The two
// this ticket owns — signup's reply and the invite link `local-admin` prints — guessed: they glued a
// slug onto the request's own Host (or onto `localhost`) and picked a scheme from `NODE_ENV`. On a
// single-host self-host that produces `https://<slug>.wiki.example.com`, which nothing serves: the
// workspace really was created, and the person who created it was sent somewhere that does not exist.
//
// A template says what a hostname fragment cannot — the scheme, the port, and WHERE THE SLUG GOES:
//
//     WKS_TENANT_URL_TEMPLATE=https://{slug}.wikistead.com     # the shipped topology
//     WKS_TENANT_URL_TEMPLATE=http://{slug}.localhost:5173     # development
//
// ── Why the placeholder must be the host's entire first label ───────────────────────────────────
//
// This is not taste. `resolveTenantFromHost` reads `hostname.split('.')[0]`, so an address whose
// first label is anything but the slug resolves to a DIFFERENT workspace or to none. A check that
// only asked "does it contain {slug}" would admit four shapes an operator could plausibly write:
//
//     https://ws-{slug}.example.com   first label is `ws-<slug>`  → every workspace 404s
//     https://app.{slug}.com          first label is `app`        → never resolves
//     https://example.com/{slug}      resolution is by host       → everyone lands in one workspace
//     https://{slug}.com              the parent zone is a TLD    → a workspace named `google`
//                                                                   addresses somebody else's domain
//
// The last one is why this is a safety condition rather than a lint: the rendered URL goes into an
// invite mail and into the redirect a browser follows after signup. Anyone who changes the resolver
// has to change this file, which is the point of writing down where the rule comes from.
//
// ── Unset is a legitimate answer ────────────────────────────────────────────────────────────────
//
// The template is OPTIONAL (owner ruling, #806). A single host with a platform IdP has no true
// value to write, and demanding one at boot would be demanding a fiction — so an unset template does
// not stop the server. It closes exactly one door: self-serve creation of a NEW workspace, which had
// nowhere to send anybody anyway. Signing in, every existing workspace, and holding several
// workspaces on one host through custom domains (ADR-065) all keep working.

export const TENANT_URL_TEMPLATE_ENV = 'WKS_TENANT_URL_TEMPLATE'

const PLACEHOLDER = '{slug}'

/** Stands in for the placeholder while the URL parser reads the template. Lower-case: hosts fold. */
const PROBE = 'wksslugprobe'

/**
 * Why a template cannot be used. The caller turns this into a refusal; the operator reads it in the
 * boot line. Each value names the shape, not the fix, so the two readers can word it their own way.
 */
export type TemplateFault =
  | 'unset'
  | 'no-placeholder'
  | 'repeated-placeholder'
  | 'unparseable'
  | 'scheme'
  | 'not-an-origin'
  | 'placeholder-outside-host'
  | 'placeholder-not-the-first-label'
  | 'parent-zone-is-a-public-suffix'

export type TenantUrlTemplate =
  | { ok: true; render: (slug: string) => string }
  | { ok: false; fault: TemplateFault; why: string }

/** Prose for a fault, in the words an operator needs to act on it. */
export function explainTemplateFault(fault: TemplateFault): string {
  switch (fault) {
    case 'unset':
      return `${TENANT_URL_TEMPLATE_ENV} is not set`
    case 'no-placeholder':
      return `${TENANT_URL_TEMPLATE_ENV} has no ${PLACEHOLDER} placeholder — a fixed host cannot address more than one workspace`
    case 'repeated-placeholder':
      return `${TENANT_URL_TEMPLATE_ENV} repeats ${PLACEHOLDER}; it belongs in exactly one place, the host's first label`
    case 'unparseable':
      return `${TENANT_URL_TEMPLATE_ENV} is not a URL — it needs a scheme, e.g. https://${PLACEHOLDER}.example.com`
    case 'scheme':
      return `${TENANT_URL_TEMPLATE_ENV} must use http or https`
    case 'not-an-origin':
      return `${TENANT_URL_TEMPLATE_ENV} must be a bare origin — no path, query, fragment or credentials`
    case 'placeholder-outside-host':
      return `${TENANT_URL_TEMPLATE_ENV} puts ${PLACEHOLDER} somewhere other than the host; workspaces are resolved by hostname, so a slug anywhere else lands everybody in the same place`
    case 'placeholder-not-the-first-label':
      return `${TENANT_URL_TEMPLATE_ENV} must have ${PLACEHOLDER} as the host's ENTIRE first label (https://${PLACEHOLDER}.example.com), because tenant resolution reads that label and nothing else`
    case 'parent-zone-is-a-public-suffix':
      return `${TENANT_URL_TEMPLATE_ENV} leaves only a top-level domain after ${PLACEHOLDER}; a workspace could then be addressed at somebody else's registered domain`
  }
}

/**
 * Read and validate the declared shape.
 *
 * Returns a renderer or a fault — never a partially-trusted template. The caller decides what a
 * fault means (signup closes its door; `local-admin` refuses before it changes anything), which is
 * why nothing here throws or logs.
 */
export function readTenantUrlTemplate(raw: string | undefined = process.env[TENANT_URL_TEMPLATE_ENV]): TenantUrlTemplate {
  const template = raw?.trim()
  if (!template) return fault('unset')

  const occurrences = template.split(PLACEHOLDER).length - 1
  if (occurrences === 0) return fault('no-placeholder')
  if (occurrences > 1) return fault('repeated-placeholder')

  let url: URL
  try {
    url = new URL(template.replace(PLACEHOLDER, PROBE))
  } catch {
    return fault('unparseable')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fault('scheme')
  if (url.username || url.password) return fault('not-an-origin')
  if (url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    // A path is not merely useless here: `https://example.com/{slug}` is one of the shapes that
    // silently sends every workspace to the same host, so it is refused rather than ignored.
    return url.pathname.includes(PROBE) || url.search.includes(PROBE) || url.hash.includes(PROBE)
      ? fault('placeholder-outside-host')
      : fault('not-an-origin')
  }
  if (url.port.includes(PROBE)) return fault('placeholder-outside-host')

  const labels = url.hostname.split('.')
  if (labels[0] !== PROBE) {
    // Either the slug is deeper in the host (`app.{slug}.com`) or it shares the first label with
    // something else (`ws-{slug}.example.com`). Both resolve to the wrong workspace, or to none.
    return url.hostname.includes(PROBE) ? fault('placeholder-not-the-first-label') : fault('placeholder-outside-host')
  }
  const parentZone = labels.slice(1)
  if (parentZone.some((label) => label.includes(PROBE))) return fault('placeholder-not-the-first-label')

  // `{slug}.com` would let a workspace named `google` be addressed at a domain somebody else owns.
  // Distinguishing a public suffix from a private one properly needs the PSL, which is not worth a
  // dependency here: what is refused is a parent zone of a SINGLE label, which is what a bare TLD
  // looks like. `localhost` is the one single-label zone that is nobody's registrable domain, and
  // development addresses workspaces under it.
  if (parentZone.length === 0) return fault('parent-zone-is-a-public-suffix')
  if (parentZone.length === 1 && parentZone[0] !== 'localhost') return fault('parent-zone-is-a-public-suffix')

  return {
    ok: true,
    // Rendered from the raw template rather than from the parsed URL, so the operator's own spelling
    // (port, scheme) reaches the address unchanged. A trailing slash is dropped because every caller
    // appends a path to this.
    render: (slug: string) => template.replace(PLACEHOLDER, slug).replace(/\/+$/, ''),
  }
}

function fault(f: TemplateFault): TenantUrlTemplate {
  return { ok: false, fault: f, why: explainTemplateFault(f) }
}

// #409 / ADR-154: the public HTML shell. Anti-tests 1-3+5 from the ADR: per-page robots efficacy
// (page OR space noindex), existence-hiding (absent / unpublished / member-only / cross-tenant are the
// byte-identical generic 404 shell), XSS (a hostile title renders escaped), and the shell carrying the
// SPA document (the fixture's asset reference survives injection). Real PG + FGA; the shell template is
// a fixture wired via PUBLIC_SHELL_INDEX before buildApp (prod mounts the web build artifact instead).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { loadShellTemplate, injectShellHead, publicFrameSrc } from '../routes/public-shell.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/assets/main-TEST.js"></script></head><body><div id="root"></div></body></html>`

let app: FastifyInstance
let pt: PrivateTenant
let db: TenantDb
let spaceId: string
let publicPage: string   // public + published + indexable
let noindexPage: string  // public + published + page-level noindex
let memberPage: string   // published, NOT public
let unpubPage: string    // public grant but NEVER published
let xssPage: string      // public + published, hostile title
const grants: { user: string; relation: string; object: string }[] = []
let H: { host: string }

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell409-'))
  const indexPath = join(dir, 'index.html')
  writeFileSync(indexPath, FIXTURE)
  process.env.PUBLIC_SHELL_INDEX = indexPath

  // #1090: a private tenant — 10 files were fighting over `tenant_dev`'s single tenant_settings row.
  pt = await privateTenant(admin, 't409')
  H = { host: `${pt.slug}.localhost` }
  db = await acquireTenantDb(asTenant(pt.id))
  await admin`INSERT INTO tenant_settings (tenant_id, public_enabled) VALUES (${pt.id}, TRUE) ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = TRUE`
  spaceId = (await createSpace(db, fgaClient, { tenantId: pt.id, userId: 'dev-user', plan: 'business', name: 'shell409' })).id

  const mk = async (title: string, opts: { publish?: boolean; noindex?: boolean; pub?: boolean }) => {
    const p = await createPage(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user', title })
    if (opts.publish !== false) await admin`UPDATE pages SET published_md = 'body', published_at = now() WHERE id = ${p.id}`
    if (opts.noindex) await admin`UPDATE pages SET noindex = TRUE WHERE id = ${p.id}`
    if (opts.pub !== false) grants.push({ user: 'user:*', relation: 'view_base', object: `page:${p.id}` })
    return p.id
  }
  publicPage = await mk('Shell Public Page', {})
  noindexPage = await mk('Shell Noindex Page', { noindex: true })
  memberPage = await mk('Shell Member Page', { pub: false })
  unpubPage = await mk('Shell Unpublished', { publish: false })
  xssPage = await mk('</title><script>window.__shell_xss=1</script>', {})
  await writeTuples(fgaClient, grants)

  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  delete process.env.PUBLIC_SHELL_INDEX
  await app?.close()
  await deleteTuples(fgaClient, grants).catch(() => {})
  for (const id of [publicPage, noindexPage, memberPage, unpubPage, xssPage]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM tenant_settings WHERE tenant_id = ${pt.id}`.catch(() => {})
  await pt.dispose()
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('shell template plumbing (#409 — pure)', () => {
  it('loadShellTemplate returns the fixture; unset → null; injection lands before </head>', () => {
    const t = loadShellTemplate()
    expect(t).toContain('/assets/main-TEST.js')
    const out = injectShellHead(t!, '<title>X</title>')
    expect(out.indexOf('<title>X</title>')).toBeLessThan(out.indexOf('</head>'))
    const saved = process.env.PUBLIC_SHELL_INDEX
    delete process.env.PUBLIC_SHELL_INDEX
    expect(loadShellTemplate()).toBeNull()
    process.env.PUBLIC_SHELL_INDEX = saved
  })
})

// #990 / ADR-277 §Decision item 3: /pub/* is the one surface where frame-src is a second layer — a
// per-tenant HTTP header that intersects with the meta CSP the built shell carries.
describe('#990: /pub/* sends a per-tenant frame-src header', () => {
  it('the allowlist becomes host + wildcard-subdomain sources; anything not hostname-shaped is dropped', () => {
    expect(publicFrameSrc([])).toBe("frame-src 'self'")
    expect(publicFrameSrc(['YouTube.com', '.vimeo.com', 'youtube.com'])).toBe("frame-src 'self' https://youtube.com https://*.youtube.com https://vimeo.com https://*.vimeo.com")
    // a header is built from strings an administrator typed: a directive separator or a scheme
    // never reaches it (break-check: drop the hostname filter and this reddens)
    expect(publicFrameSrc(["evil.com; script-src 'unsafe-inline'", 'https://x.com', 'a b.com', 'localhost'])).toBe("frame-src 'self'")
  })

  it('a public page answers with the tenant\'s own allowlist; the generic 404 answers with bare self', async () => {
    await admin`UPDATE tenant_settings SET embed_providers = ${admin.array(['youtube.com'])} WHERE tenant_id = ${pt.id}`
    try {
      const ok = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: H })
      expect(ok.statusCode).toBe(200)
      expect(ok.headers['content-security-policy'], 'the tenant allowlist, as a header').toBe("frame-src 'self' https://youtube.com https://*.youtube.com")
      const absent = await app.inject({ method: 'GET', url: '/pub/no-such-page', headers: H })
      expect(absent.statusCode).toBe(404)
      expect(absent.headers['content-security-policy'], 'a 404 must not name the allowlist (existence oracle)').toBe("frame-src 'self'")
      const space = await app.inject({ method: 'GET', url: `/pub/space/${spaceId}`, headers: H })
      if (space.statusCode === 200) expect(space.headers['content-security-policy']).toContain('https://youtube.com')
    } finally {
      await admin`UPDATE tenant_settings SET embed_providers = ${admin.array([])} WHERE tenant_id = ${pt.id}`
    }
  })
})

describe('GET /pub/:id — the crawler shell (#409 / ADR-154)', () => {
  it('anti-test 1: an indexable public page gets title+canonical and NO robots meta; noindex page gets it', async () => {
    const ok = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: H })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toContain('text/html')
    expect(ok.headers['cache-control']).toBe('no-store')
    expect(ok.body).toContain('<title>Shell Public Page</title>')
    expect(ok.body).toContain(`/pub/${publicPage}`) // canonical
    expect(ok.body).toContain('/assets/main-TEST.js') // the SPA document survives (anti-test 5)
    expect(ok.body).not.toContain('name="robots"')

    const ni = await app.inject({ method: 'GET', url: `/pub/${noindexPage}`, headers: H })
    expect(ni.statusCode).toBe(200)
    expect(ni.body).toContain('<meta name="robots" content="noindex">')
    expect(ni.body).toContain('<title>Shell Noindex Page</title>')
  })

  it('anti-test 2: absent / member-only / unpublished ids are the BYTE-IDENTICAL generic 404 shell', async () => {
    const absent = await app.inject({ method: 'GET', url: '/pub/no-such-page', headers: H })
    const member = await app.inject({ method: 'GET', url: `/pub/${memberPage}`, headers: H })
    const unpub = await app.inject({ method: 'GET', url: `/pub/${unpubPage}`, headers: H })
    for (const r of [absent, member, unpub]) {
      expect(r.statusCode).toBe(404)
      expect(r.body).toContain('<meta name="robots" content="noindex">')
      expect(r.body).not.toContain('<title>') // generic: no title, no leak
    }
    expect(member.body).toBe(absent.body) // byte-identical — no cause distinction
    expect(unpub.body).toBe(absent.body)
    // cross-tenant: the acme host cannot resolve a dev page (same generic shell).
    const cross = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: { host: 'acme.localhost' } })
    expect(cross.statusCode).toBe(404)
    expect(cross.body).toBe(absent.body)
  })

  it('anti-test 3 (XSS): a hostile title renders fully escaped — no live tag reaches the shell', async () => {
    const r = await app.inject({ method: 'GET', url: `/pub/${xssPage}`, headers: H })
    expect(r.statusCode).toBe(200)
    expect(r.body).not.toContain('<script>window.__shell_xss')
    expect(r.body).toContain('&lt;/title&gt;&lt;script&gt;')
  })

  it('#408: social meta rides the shell — og:title/description/type/url + twitter:card, all escaped', async () => {
    await admin`UPDATE pages SET published_md = ${'# Heading\n\nSome **prose** with a [link](/p/x) and `code`.\n\n```js\nsecret()\n```'} WHERE id = ${publicPage}`
    const r = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: H })
    expect(r.body).toContain('<meta property="og:title" content="Shell Public Page">')
    expect(r.body).toContain('og:type" content="article"')
    expect(r.body).toContain('twitter:card" content="summary"')
    expect(r.body).toContain(`/pub/${publicPage}`)
    const desc = /og:description" content="([^"]*)"/.exec(r.body)?.[1] ?? ''
    expect(desc).toContain('Some prose with a link and code')
    expect(desc).not.toContain('secret()') // fenced code stripped
    // The hostile-title page's og:title is escaped too (same interpolation discipline).
    const x = await app.inject({ method: 'GET', url: `/pub/${xssPage}`, headers: H })
    expect(x.body).not.toContain('<script>window.__shell_xss')
  })

  it('#408: robots.txt allows /pub+/assets and points at the sitemap; parent switch OFF disallows all', async () => {
    const on = await app.inject({ method: 'GET', url: '/robots.txt', headers: H })
    expect(on.statusCode).toBe(200)
    expect(on.body).toContain('Allow: /pub/')
    expect(on.body).toContain('Allow: /assets/')
    expect(on.body).toContain(`Sitemap: https://${pt.slug}.localhost/sitemap.xml`)
    await admin`UPDATE tenant_settings SET public_enabled = FALSE WHERE tenant_id = ${pt.id}`
    try {
      const off = await app.inject({ method: 'GET', url: '/robots.txt', headers: H })
      expect(off.body.trim()).toBe('User-agent: *\nDisallow: /')
    } finally {
      await admin`UPDATE tenant_settings SET public_enabled = TRUE WHERE tenant_id = ${pt.id}`
    }
  })

  it('#408 anti-test 4: the sitemap lists the public indexable page and omits noindexed/member-only/draft (list AND count)', async () => {
    const r = await app.inject({ method: 'GET', url: '/sitemap.xml', headers: H })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain(`/pub/${publicPage}`)
    for (const id of [noindexPage, memberPage, unpubPage]) expect(r.body).not.toContain(id)
    // Count discipline: exactly as many <url> entries as anonymously-indexable pages we can see —
    // the omitted three never inflate the count.
    const count = (r.body.match(/<url>/g) ?? []).length
    expect(count).toBeGreaterThan(0)
    expect(r.body.includes(memberPage)).toBe(false)
    // Parent switch OFF → empty urlset (no URL list leak).
    await admin`UPDATE tenant_settings SET public_enabled = FALSE WHERE tenant_id = ${pt.id}`
    try {
      const off = await app.inject({ method: 'GET', url: '/sitemap.xml', headers: H })
      expect((off.body.match(/<url>/g) ?? []).length).toBe(0)
    } finally {
      await admin`UPDATE tenant_settings SET public_enabled = TRUE WHERE tenant_id = ${pt.id}`
    }
  })

  it('the #253 tenant parent switch OFF hides the whole shell surface (generic 404)', async () => {
    await admin`UPDATE tenant_settings SET public_enabled = FALSE WHERE tenant_id = ${pt.id}`
    try {
      const r = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: H })
      expect(r.statusCode).toBe(404)
      expect(r.body).not.toContain('<title>')
    } finally {
      await admin`UPDATE tenant_settings SET public_enabled = TRUE WHERE tenant_id = ${pt.id}`
    }
  })
})

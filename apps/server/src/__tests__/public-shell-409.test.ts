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
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { loadShellTemplate, injectShellHead } from '../routes/public-shell.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/assets/main-TEST.js"></script></head><body><div id="root"></div></body></html>`

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let publicPage: string   // public + published + indexable
let noindexPage: string  // public + published + page-level noindex
let memberPage: string   // published, NOT public
let unpubPage: string    // public grant but NEVER published
let xssPage: string      // public + published, hostile title
const grants: { user: string; relation: string; object: string }[] = []
const H = { host: 'dev.localhost' }

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell409-'))
  const indexPath = join(dir, 'index.html')
  writeFileSync(indexPath, FIXTURE)
  process.env.PUBLIC_SHELL_INDEX = indexPath

  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await admin`UPDATE tenant_settings SET public_enabled = TRUE WHERE tenant_id = ${tenant.id}`
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'shell409' })).id

  const mk = async (title: string, opts: { publish?: boolean; noindex?: boolean; pub?: boolean }) => {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
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
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
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

  it('the #253 tenant parent switch OFF hides the whole shell surface (generic 404)', async () => {
    await admin`UPDATE tenant_settings SET public_enabled = FALSE WHERE tenant_id = ${tenant.id}`
    try {
      const r = await app.inject({ method: 'GET', url: `/pub/${publicPage}`, headers: H })
      expect(r.statusCode).toBe(404)
      expect(r.body).not.toContain('<title>')
    } finally {
      await admin`UPDATE tenant_settings SET public_enabled = TRUE WHERE tenant_id = ${tenant.id}`
    }
  })
})

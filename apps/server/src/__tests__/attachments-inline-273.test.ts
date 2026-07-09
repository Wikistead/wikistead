// #273 / ADR-120: type-aware attachments — the XSS/authz anti-tests. Real Postgres + OpenFGA +
// S3-compatible storage + Fastify.
//   - inline classification is SERVER-SNIFFED from the object's leading bytes: a real PDF sniffs
//     'pdf'; HTML/SVG bytes sniff 'none' EVEN when the client-declared content_type lies
//     ('application/pdf') — a mislabelled active-content blob can never reach the inline frame;
//   - the inline proxy serves the authoritative headers (sniffed Content-Type, inline disposition,
//     nosniff, CSP) and 415s a non-inline kind; a NON-viewer gets a uniform 404 (gate before status);
//   - the direct presigned download carries the signed Content-Disposition: attachment override
//     (review condition ③, retroactive for images too);
//   - both markdown renderers intercept the wks-attachment: href (review condition ① — the server
//     implementation here; the client one is tested in apps/web md-render.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalStorageDriver } from '../storage/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { presignAttachment, confirmAttachment, downloadAttachment, sniffInlineKind } from '../routes/attachments.js'
import { renderMarkdownToHtml, builtinMacroRegistry } from '@wikistead/macro-render'
import type { Tenant } from '@wikistead/types'
import IORedis from 'ioredis'

const storage = new LogicalStorageDriver()
const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6381')

// A tiny but REAL one-page PDF (header sniffs %PDF-).
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF',
)
const HTML_BYTES = new TextEncoder().encode('<html><script>alert(1)</script></html>')

let app: FastifyInstance
let tenant: Tenant, db: TenantDb, spaceId: string, pageId: string
let pdfId: string, htmlId: string

async function uploadAndConfirm(filename: string, declaredType: string, bytes: Uint8Array): Promise<string> {
  const { attachmentId, uploadUrl } = await presignAttachment(db, storage, fgaClient, {
    tenantId: tenant.id, plan: tenant.plan, pageId, userId: 'dev-user', filename, contentType: declaredType,
  })
  const res = await fetch(uploadUrl, { method: 'PUT', body: bytes as unknown as BodyInit, headers: { 'Content-Type': declaredType } })
  expect(res.ok).toBe(true)
  await confirmAttachment(db, storage, fgaClient, { id: attachmentId, tenantId: tenant.id, userId: 'dev-user' })
  return attachmentId
}

beforeAll(async () => {
  await storage.ensureBucket()
  app = await buildApp()
  await app.ready()
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'att273-space' })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'att273-page' })).id
  pdfId = await uploadAndConfirm('report.pdf', 'application/pdf', PDF_BYTES)
  // The LYING upload: active-content bytes DECLARED as application/pdf — the sniff must win.
  htmlId = await uploadAndConfirm('evil.html', 'application/pdf', HTML_BYTES)
}, 60_000)

afterAll(async () => {
  await app.close()
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM attachments WHERE page_id = ${pageId}`.catch(() => {})
  await db.release(); await admin.end(); await valkey.quit(); await pool.end()
}, 60_000)

describe('#273 sniffed classification (never the declared type)', () => {
  it('sniffInlineKind: pdf/image magics classify; HTML/SVG/unknown are none', () => {
    expect(sniffInlineKind(PDF_BYTES)).toBe('pdf')
    expect(sniffInlineKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image') // PNG
    expect(sniffInlineKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image') // JPEG
    expect(sniffInlineKind(HTML_BYTES)).toBe('none')
    expect(sniffInlineKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('none')
    expect(sniffInlineKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('none') // zip
    expect(sniffInlineKind(new Uint8Array())).toBe('none')
  })

  it('confirm stores the sniffed kind: real PDF → pdf; lying HTML-as-pdf → none', async () => {
    const rows = await admin<{ id: string; inline_kind: string }[]>`SELECT id, inline_kind FROM attachments WHERE id IN (${pdfId}, ${htmlId})`
    expect(rows.find((r) => r.id === pdfId)?.inline_kind).toBe('pdf')
    expect(rows.find((r) => r.id === htmlId)?.inline_kind).toBe('none')
  })

  it('download resolves the sniffed kind + a presigned URL with the SIGNED attachment disposition', async () => {
    const d = await downloadAttachment(db, storage, fgaClient, { id: pdfId, subject: 'user:dev-user' })
    expect(d.inlineKind).toBe('pdf')
    expect(d.sizeBytes).toBe(PDF_BYTES.byteLength)
    expect(d.downloadUrl).toContain('response-content-disposition=attachment') // condition ③
    const lying = await downloadAttachment(db, storage, fgaClient, { id: htmlId, subject: 'user:dev-user' })
    expect(lying.inlineKind).toBe('none') // the declared application/pdf did not matter
  })
})

describe('#273 inline proxy route (the XSS boundary headers)', () => {
  const H = async () => {
    const sid = await createSession(valkey, { tenantId: tenant.id, sub: 'dev-user', role: 'admin' })
    return { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` }
  }

  it('serves a sniffed PDF with authoritative Content-Type + inline + nosniff + CSP', async () => {
    const res = await app.inject({ method: 'GET', url: `/attachments/${pdfId}/inline`, headers: await H() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(String(res.headers['content-disposition'])).toContain('inline')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'none'")
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('a non-inline kind (the lying HTML) is 415 — it can never be served inline', async () => {
    const res = await app.inject({ method: 'GET', url: `/attachments/${htmlId}/inline`, headers: await H() })
    expect(res.statusCode).toBe(415)
  })

  it('a NON-viewer gets a uniform 404 (view gate before status/kind — no oracle)', async () => {
    const sid = await createSession(valkey, { tenantId: tenant.id, sub: 'att273-stranger', role: 'member' })
    const h = { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` }
    expect((await app.inject({ method: 'GET', url: `/attachments/${pdfId}/inline`, headers: h })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/attachments/${htmlId}/inline`, headers: h })).statusCode).toBe(404) // same as the pdf — kind not leaked
  })
})

describe('#273 renderer intercept (server implementation — condition ①)', () => {
  it('a wks-attachment link renders as a non-anchor affordance, never a raw custom-scheme <a>', () => {
    const html = renderMarkdownToHtml('see [report.pdf](wks-attachment:abc-123) here', builtinMacroRegistry()).value
    expect(html).toContain('wks-attachment-ref')
    expect(html).toContain('report.pdf')
    expect(html).not.toContain('<a href="wks-attachment')
  })

  it('a normal link still renders as an anchor (the intercept is scheme-scoped)', () => {
    const html = renderMarkdownToHtml('[site](https://example.com)', builtinMacroRegistry()).value
    expect(html).toContain('<a href="https://example.com"')
  })
})

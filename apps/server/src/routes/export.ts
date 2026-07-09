import type { FastifyInstance, FastifyReply } from 'fastify'
import { buildExport, buildSpaceExport, buildTenantExport, ExportTooLargeError, type ExportResult } from '../export/index.js'
import { buildHtmlExport } from '../render/html-export.js'

// Send an export result as a download, or 413 when it exceeds the size cap (a huge tenant/space).
function sendExport(reply: FastifyReply, result: ExportResult) {
  return reply
    .header('content-type', result.contentType)
    // filename* (RFC 5987) so unicode titles survive in the download name.
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
    .send(Buffer.from(result.body))
}

// Export a page + its view-authorized subtree as Markdown (.md for a lone page,
// .zip with bundled images otherwise) — or a whole space / the whole tenant (#309).
// Authorization lives in the builders: the root/space must be viewable (null → 404),
// and the subtree + images are view-filtered (tenant is always 200, view-filtered).
export async function exportPlugin(app: FastifyInstance) {
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/export', async (req, reply) => {
    const result = await buildExport(req.db, app.fga, app.storageDriver, { userId: req.user.sub, rootId: req.params.pageId })
    if (!result) return reply.code(404).send({ error: 'not found' })
    return sendExport(reply, result)
  })

  // #309: a whole space as one Markdown ZIP (view-filtered subtree of every viewable root page). Space view
  // is the gate (non-viewable / cross-tenant → 404, existence-hiding). 413 when it exceeds the size cap.
  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/export', async (req, reply) => {
    try {
      const result = await buildSpaceExport(req.db, app.fga, app.storageDriver, { userId: req.user.sub, spaceId: req.params.spaceId })
      if (!result) return reply.code(404).send({ error: 'not found' })
      return sendExport(reply, result)
    } catch (e) {
      if (e instanceof ExportTooLargeError) return reply.code(413).send({ error: 'export too large' })
      throw e
    }
  })

  // #309: the whole tenant as one Markdown ZIP — every space the caller can view (view-filtered, all plans,
  // NOT admin-gated). Always 200 with whatever is visible. 413 when it exceeds the size cap.
  app.get('/export', async (req, reply) => {
    try {
      const result = await buildTenantExport(req.db, app.fga, app.storageDriver, { userId: req.user.sub })
      return sendExport(reply, result)
    } catch (e) {
      if (e instanceof ExportTooLargeError) return reply.code(413).send({ error: 'export too large' })
      throw e
    }
  })

  // #85 / ADR-059: HTML export of a single page (the published version), rendered by the shared
  // macro renderer and passed through the final server-side sanitizer — the ONE render→sanitize
  // path. View-gated (unviewable → 404, no existence leak), like the Markdown export.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/export.html', async (req, reply) => {
    const result = await buildHtmlExport(req.db, app.fga, { userId: req.user.sub, pageId: req.params.pageId })
    if (!result) return reply.code(404).send({ error: 'not found' })
    return reply
      .header('content-type', result.contentType)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .send(result.body)
  })
}

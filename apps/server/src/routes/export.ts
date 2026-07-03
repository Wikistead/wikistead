import type { FastifyInstance } from 'fastify'
import { buildExport } from '../export/index.js'
import { buildHtmlExport } from '../render/html-export.js'

// Export a page + its view-authorized subtree as Markdown (.md for a lone page,
// .zip with bundled images otherwise). Authorization lives in buildExport: the
// root must be viewable (null → 404), and the subtree + images are view-filtered.
export async function exportPlugin(app: FastifyInstance) {
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/export', async (req, reply) => {
    const result = await buildExport(req.db, app.fga, app.storageDriver, { userId: req.user.sub, rootId: req.params.pageId })
    if (!result) return reply.code(404).send({ error: 'not found' })
    return reply
      .header('content-type', result.contentType)
      // filename* (RFC 5987) so unicode page titles survive in the download name.
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .send(Buffer.from(result.body))
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

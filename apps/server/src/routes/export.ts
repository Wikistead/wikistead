import type { FastifyInstance } from 'fastify'
import { buildExport } from '../export/index.js'

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
}
